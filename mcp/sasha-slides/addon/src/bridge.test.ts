// The boundary with Apps Script: every reply parser, the call promisifier, and the `seen` cache.
//
// This file is the reason Code.gs can be a thin relay. Everything a server function could get wrong
// -- a missing field, a wrong type, a reply that never arrives, a function name that is not on the
// server at all -- is decided here, in TypeScript that runs under `node --test`, instead of in a
// .gs file that can only be exercised by deploying it.

import assert from "node:assert/strict";
import test from "node:test";
import {
  appsScriptCall,
  appsScriptCommentThreadApi,
  appsScriptFeedbackApi,
  appsScriptDriveApi,
  appsScriptPickApi,
  helloFromServer,
} from "./bridge-client.ts";
import { AGENT_REPLY_MARKER } from "../../agent-marker.ts";
import {
  SERVER_FUNCTION_NAMES,
  parseFeedbackReply as parseFeedbackReplyForTest,
  parseHelloReply,
  parseInsertReply,
  parseProposalMark,
  parseReadTextReply,
  parseScanReply,
  parseWritePickReply,
  parseCommentReply,
  parseReplyCommentReply,
  parseResolveCommentReply,
} from "./bridge.ts";
import { SEEN_LIMIT, parseSeen, seenStore, serializeSeen, type KeyValueStorage } from "./seen-store.ts";

test("there are exactly nineteen server functions, and they are the ones Code.gs declares", () => {
  assert.deepEqual(SERVER_FUNCTION_NAMES, [
    // The picker's five.
    "sashaHello",
    "sashaScanInbox",
    "sashaReadText",
    "sashaReadEvents",
    "sashaWriteEvent",
    "sashaCandidateComments",
    "sashaInsert",
    // The candidates as GOOGLE renders them: a throwaway deck, photographed and deleted. It is
    // separate from sashaInsert because it must never touch the user's own presentation.
    "sashaRenderPreviews",
    "sashaWritePick",
    // The comment channel's two. Both take a FILE ID, which is what lets the same pair carry a
    // message about the deck and a mark-up on a candidate's own NN.html (PROTOCOL.md).
    "sashaSendFeedback",
    "sashaReadFeedback",
    // Answering and resolving an EXISTING thread, from its card in Ask Sasha or its row in the
    // slides window's thread rail. ALL THREE ARE ONE DRIVE CALL -- a resolve is a reply carrying
    // `action: "resolve"` -- so they are a pair by construction and a Code.gs that has one and not
    // the others cannot exist. `sashaReplyToComment` is the same post as `sashaReplyComment` for a
    // caller that names the field `text`; it is here only until sidebar.tsx moves over, and then
    // the older name goes and this list is sixteen again (src/bridge.ts, CommentReplySpec).
    "sashaReplyComment",
    "sashaReplyToComment",
    "sashaResolveComment",
    // The SURFACE SPLIT's three: asking the host to show another document, and reading back which
    // candidate the report window was opened on. They are server calls and not client JavaScript
    // because `showModelessDialog` is `SlidesApp.getUi()`, and the three HtmlService documents
    // share nothing (UI-CONTRACT.md).
    "sashaOpenPicker",
    // Which candidate the slides window should come up on; reading it clears it.
    "sashaTakePickerTarget",
    "sashaOpenDefectReport",
    // The WEB-APP URL. Slides hosts exactly one modeless dialog, so showing the report evicted
    // the Candidate slides window; a web-app window is the only separate browser window Apps
    // Script can give, and this is how the client learns whether one has been deployed.
    "sashaReportWindowUrl",
    "sashaTakeReportTarget",
  ]);
});

test("a hello reply must carry both fields, with the right types", () => {
  assert.deepEqual(parseHelloReply({ protocolVersion: 1, presentationUrl: "https://x" }), {
    kind: "ok",
    value: { protocolVersion: 1, presentationUrl: "https://x" },
  });
  assert.equal(parseHelloReply({ presentationUrl: "https://x" }).kind, "invalid");
  assert.equal(parseHelloReply({ protocolVersion: "1", presentationUrl: "https://x" }).kind, "invalid");
  assert.equal(parseHelloReply({ protocolVersion: 1 }).kind, "invalid");
  assert.equal(parseHelloReply(null).kind, "invalid");
  assert.equal(parseHelloReply([]).kind, "invalid");
});

test("a scan reply drops the folders it cannot read instead of blinding the whole poll", () => {
  const parsed = parseScanReply({
    marks: [
      { proposalId: "p_1", folderId: "f1", readyFileId: "r1", pickFileId: null, createdTime: "t1" },
      { proposalId: "", folderId: "f2" },
      { folderId: "f3" },
      "not an object",
      { proposalId: "p_4", folderId: "f4" },
    ],
  });
  assert.equal(parsed.kind, "ok");
  assert.deepEqual(parsed.kind === "ok" ? parsed.value.marks : [], [
    { proposalId: "p_1", folderId: "f1", readyFileId: "r1", pickFileId: null, createdTime: "t1" },
    // Missing marks read as absent, which is what "still partial / not yet answered" means.
    { proposalId: "p_4", folderId: "f4", readyFileId: null, pickFileId: null, createdTime: "" },
  ]);
  assert.equal(parseScanReply({ marks: "nope" }).kind, "invalid");
  assert.equal(parseScanReply(null).kind, "invalid");
});

test("a proposal mark needs a non-empty id AND folder -- a nameless folder is not a proposal", () => {
  assert.equal(parseProposalMark({ proposalId: "p_1", folderId: "" }), null);
  assert.equal(parseProposalMark({ proposalId: "", folderId: "f" }), null);
  assert.equal(parseProposalMark({ proposalId: 7, folderId: "f" }), null);
});

test("read-text, insert and write-pick replies are each checked for the field they promise", () => {
  assert.deepEqual(parseReadTextReply({ text: "" }), { kind: "ok", value: { text: "" } });
  assert.equal(parseReadTextReply({}).kind, "invalid");

  const inserted = parseInsertReply({ batchResponse: { replies: [] }, renderArtifact: "03.png" });
  assert.equal(inserted.kind, "ok");
  assert.equal(inserted.kind === "ok" ? inserted.value.renderArtifact : "", "03.png");
  // A missing renderArtifact is the NORMAL best-effort outcome, so it must parse, not fail.
  const noRender = parseInsertReply({ batchResponse: {} });
  assert.equal(noRender.kind === "ok" ? noRender.value.renderArtifact : "unset", null);

  assert.deepEqual(parseWritePickReply({ fileId: "1abc" }), { kind: "ok", value: { fileId: "1abc" } });
  assert.equal(parseWritePickReply({}).kind, "invalid");
});

test("a server call that never answers fails on its budget instead of hanging the picker", async () => {
  const call = appsScriptCall({ run: silentRunner(), budgetMs: 5 });
  const outcome = await call({ invoke: (runner) => runner.sashaHello(), what: "sashaHello" });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.message : "", /did not answer within 5 ms/);
});

test("a failure handler's Error, a bare string and a synchronous throw all read as one message", async () => {
  const fromError = await appsScriptCall({ run: failingRunner(new Error("Drive 403")) })({
    invoke: (runner) => runner.sashaScanInbox({ pageSize: 10 }),
    what: "sashaScanInbox",
  });
  assert.equal(fromError.kind, "failed");
  assert.match(fromError.kind === "failed" ? fromError.message : "", /sashaScanInbox: Drive 403/);

  const fromString = await appsScriptCall({ run: failingRunner("ScriptError") })({
    invoke: (runner) => runner.sashaScanInbox({ pageSize: 10 }),
    what: "sashaScanInbox",
  });
  assert.match(fromString.kind === "failed" ? fromString.message : "", /ScriptError/);

  const fromThrow = await appsScriptCall({ run: throwingRunner() })({
    invoke: (runner) => runner.sashaHello(),
    what: "sashaHello",
  });
  assert.match(fromThrow.kind === "failed" ? fromThrow.message : "", /could not be called/);
});

test("the Drive adapter hands the observer marks and the picker text, both already parsed", async () => {
  const drive = appsScriptDriveApi({
    call: stubCall({
      sashaScanInbox: { marks: [{ proposalId: "p_1", folderId: "f1", readyFileId: "r1" }] },
      sashaReadText: { text: "READY body" },
    }),
  });
  const scanned = await drive.scanInbox({ pageSize: 100 });
  assert.equal(scanned.kind, "ok");
  assert.equal(scanned.kind === "ok" ? scanned.value[0]?.proposalId : null, "p_1");
  const text = await drive.downloadText("r1");
  assert.deepEqual(text, { kind: "ok", value: "READY body" });
});

test("a malformed reply is a failure the observer can back off on, not a crash", async () => {
  const drive = appsScriptDriveApi({ call: stubCall({ sashaScanInbox: { oops: true }, sashaReadText: {} }) });
  const scanned = await drive.scanInbox({ pageSize: 100 });
  assert.equal(scanned.kind, "failed");
  const text = await drive.downloadText("r1");
  assert.equal(text.kind, "failed");

  const pick = appsScriptPickApi({ call: stubCall({ sashaWritePick: { nope: 1 } }) });
  const written = await pick.createPick({
    folderId: "f1",
    name: "PICK",
    mimeType: "application/json",
    body: "{}",
    appProperties: {},
  });
  assert.equal(written.kind, "failed");

  const hello = await helloFromServer({ call: stubCall({ sashaHello: { protocolVersion: 1 } }) });
  assert.equal(hello.kind, "failed");
});

test("the seen cache survives a storage that is absent, broken or holding junk", async () => {
  assert.deepEqual(parseSeen(null), []);
  assert.deepEqual(parseSeen(""), []);
  assert.deepEqual(parseSeen("not json"), []);
  assert.deepEqual(parseSeen('{"a":1}'), []);
  assert.deepEqual(parseSeen('["p_1",7,"p_2"]'), ["p_1", "p_2"]);

  const thrown: KeyValueStorage = {
    read() {
      throw new Error("site data blocked");
    },
    write() {
      throw new Error("site data blocked");
    },
  };
  // The guard belongs to the browser storage, not to the store, so a throwing storage is the
  // caller's bug -- but a store over a WORKING storage must round-trip and stay bounded.
  assert.throws(() => thrown.read("k"));

  const memory = new Map<string, string>();
  const store = seenStore({
    storage: {
      read: (key) => memory.get(key) ?? null,
      write: ({ key, value }) => void memory.set(key, value),
    },
  });
  assert.deepEqual(await store.read(), []);
  await store.write(["p_1", "p_2"]);
  assert.deepEqual(await store.read(), ["p_1", "p_2"]);

  const tooMany = Array.from({ length: SEEN_LIMIT + 10 }, (_unused, position) => `p_${position}`);
  await store.write(tooMany);
  const kept = await store.read();
  assert.equal(kept.length, SEEN_LIMIT);
  assert.equal(kept[kept.length - 1], `p_${SEEN_LIMIT + 9}`, "the newest ids are the ones kept");
  assert.equal(JSON.parse(serializeSeen(tooMany)).length, SEEN_LIMIT);
});

/** A runner whose handlers are never called -- i.e. an Apps Script execution that never returns. */
function silentRunner(): AppsScriptRunner {
  const runner: AppsScriptRunner = {
    withSuccessHandler: () => runner,
    withFailureHandler: () => runner,
    sashaHello: () => undefined,
    sashaScanInbox: () => undefined,
    sashaReadText: () => undefined,
    sashaInsert: () => undefined,
    sashaWritePick: () => undefined,
    sashaReadEvents: () => undefined,
    sashaWriteEvent: () => undefined,
    sashaCandidateComments: () => undefined,
    sashaSendFeedback: () => undefined,
    sashaReadFeedback: () => undefined,
    sashaReplyComment: () => undefined,
    sashaReplyToComment: () => undefined,
    sashaResolveComment: () => undefined,
    sashaOpenPicker: () => undefined,
    sashaOpenDefectReport: () => undefined,
    sashaReportWindowUrl: () => undefined,
    sashaTakeReportTarget: () => undefined,
    sashaRenderPreviews: () => undefined,
    sashaTakePickerTarget: () => undefined,
  };
  return runner;
}

function failingRunner(error: unknown): AppsScriptRunner {
  let onFailure: ((error: unknown) => void) | null = null;
  const runner: AppsScriptRunner = {
    withSuccessHandler: () => runner,
    withFailureHandler: (handler) => {
      onFailure = handler;
      return runner;
    },
    sashaHello: () => onFailure?.(error),
    sashaScanInbox: () => onFailure?.(error),
    sashaReadText: () => onFailure?.(error),
    sashaInsert: () => onFailure?.(error),
    sashaWritePick: () => onFailure?.(error),
    sashaReadEvents: () => onFailure?.(error),
    sashaWriteEvent: () => onFailure?.(error),
    sashaCandidateComments: () => onFailure?.(error),
    sashaSendFeedback: () => onFailure?.(error),
    sashaReadFeedback: () => onFailure?.(error),
    sashaReplyComment: () => onFailure?.(error),
    sashaReplyToComment: () => onFailure?.(error),
    sashaResolveComment: () => onFailure?.(error),
    sashaOpenPicker: () => onFailure?.(error),
    sashaOpenDefectReport: () => onFailure?.(error),
    sashaReportWindowUrl: () => onFailure?.(error),
    sashaTakeReportTarget: () => onFailure?.(error),
    sashaRenderPreviews: () => undefined,
    sashaTakePickerTarget: () => undefined,
  };
  return runner;
}

/** A deploy mismatch: the function name is simply not on the server. */
function throwingRunner(): AppsScriptRunner {
  const runner: AppsScriptRunner = {
    withSuccessHandler: () => runner,
    withFailureHandler: () => runner,
    sashaHello: () => {
      throw new TypeError("google.script.run.sashaHello is not a function");
    },
    sashaScanInbox: () => undefined,
    sashaReadText: () => undefined,
    sashaInsert: () => undefined,
    sashaWritePick: () => undefined,
    sashaReadEvents: () => undefined,
    sashaWriteEvent: () => undefined,
    sashaCandidateComments: () => undefined,
    sashaSendFeedback: () => undefined,
    sashaReadFeedback: () => undefined,
    sashaReplyComment: () => undefined,
    sashaReplyToComment: () => undefined,
    sashaResolveComment: () => undefined,
    sashaOpenPicker: () => undefined,
    sashaOpenDefectReport: () => undefined,
    sashaReportWindowUrl: () => undefined,
    sashaTakeReportTarget: () => undefined,
    sashaRenderPreviews: () => undefined,
    sashaTakePickerTarget: () => undefined,
  };
  return runner;
}

/** A runner that answers each named function with a canned reply, through the real promisifier. */
function stubCall(replies: Readonly<Record<string, unknown>>) {
  let onSuccess: ((value: unknown) => void) | null = null;
  const answer = (name: string) => () => onSuccess?.(replies[name]);
  const runner: AppsScriptRunner = {
    withSuccessHandler: (handler) => {
      onSuccess = handler;
      return runner;
    },
    withFailureHandler: () => runner,
    sashaHello: answer("sashaHello"),
    sashaScanInbox: answer("sashaScanInbox"),
    sashaReadText: answer("sashaReadText"),
    sashaInsert: answer("sashaInsert"),
    sashaRenderPreviews: answer("sashaRenderPreviews"),
    sashaTakePickerTarget: answer("sashaTakePickerTarget"),
    sashaWritePick: answer("sashaWritePick"),
    sashaReadEvents: answer("sashaReadEvents"),
    sashaWriteEvent: answer("sashaWriteEvent"),
    sashaCandidateComments: answer("sashaCandidateComments"),
    sashaSendFeedback: answer("sashaSendFeedback"),
    sashaReadFeedback: answer("sashaReadFeedback"),
    sashaReplyComment: answer("sashaReplyComment"),
    sashaReplyToComment: answer("sashaReplyToComment"),
    sashaResolveComment: answer("sashaResolveComment"),
    sashaOpenPicker: answer("sashaOpenPicker"),
    sashaOpenDefectReport: answer("sashaOpenDefectReport"),
    sashaReportWindowUrl: answer("sashaReportWindowUrl"),
    sashaTakeReportTarget: answer("sashaTakeReportTarget"),
  };
  return appsScriptCall({ run: runner });
}

/**
 * Measured in the deployed add-on, 2026-10-04: Sasha's answer rendered in Ask Sasha with a
 * literal "[sasha-slides-agent]" line under it. The marker is how the two halves tell the
 * agent's posts from the user's (the connector and the user authenticate as the SAME Google
 * account), so it has to be on the wire -- and it has to be off the screen.
 */
test("an agent reply arrives marked but is never shown with its marker", () => {
  const parsed = parseFeedbackReplyForTest({
    id: "r_1",
    content: `evened the borders out\n\n${AGENT_REPLY_MARKER}`,
    createdTime: "2026-10-04T12:07:00.000Z",
    author: { displayName: "Ante M" },
  });
  assert.deepEqual(parsed, {
    replyId: "r_1",
    author: "Ante M",
    createdAt: "2026-10-04T12:07:00.000Z",
    text: "evened the borders out",
    authoredByAgent: true,
  });
});

test("a reply the user typed in Drive is not the agent's, and keeps every word", () => {
  const parsed = parseFeedbackReplyForTest({
    id: "r_2",
    content: "still looks wrong to me",
    createdTime: "2026-10-04T12:09:00.000Z",
    author: { displayName: "Ante M" },
  });
  assert.equal(parsed?.authoredByAgent, false);
  assert.equal(parsed?.text, "still looks wrong to me");
});

// --- answering a thread from its card ----------------------------------------

test("a posted reply must come back with Drive's id -- an empty one is not a success", () => {
  assert.deepEqual(parseReplyCommentReply({ replyId: "AAAB", resolved: false }), {
    kind: "ok",
    value: { replyId: "AAAB", resolved: false },
  });
  assert.equal(parseReplyCommentReply({ replyId: "" }).kind, "invalid");
  assert.equal(parseReplyCommentReply({}).kind, "invalid");
  assert.equal(parseReplyCommentReply(null).kind, "invalid");
  assert.deepEqual(parseResolveCommentReply({ replyId: "AAAC", resolved: true }), {
    kind: "ok",
    value: { replyId: "AAAC", resolved: true },
  });
  assert.deepEqual(
    parseResolveCommentReply("nope"),
    { kind: "invalid", reason: "sashaResolveComment returned no object" },
    "the refusal names which function answered badly",
  );
});

// An unknown resolve state must not throw away a post that LANDED. A Code.gs deployed before
// `resolved` existed answers with the id alone, and a card that refused that reply would tell the
// user their words were not sent when Drive has them -- so absent, null and a non-boolean all read
// as "still open", which is both the safe answer and what an un-resolved thread actually is.
test("a reply's resolve state is read as a boolean and defaults to open, never to a failure", () => {
  assert.deepEqual(parseReplyCommentReply({ replyId: "AAAB" }), {
    kind: "ok",
    value: { replyId: "AAAB", resolved: false },
  });
  assert.deepEqual(parseReplyCommentReply({ replyId: "AAAB", resolved: null }), {
    kind: "ok",
    value: { replyId: "AAAB", resolved: false },
  });
  assert.deepEqual(
    parseReplyCommentReply({ replyId: "AAAB", resolved: "true" }),
    { kind: "ok", value: { replyId: "AAAB", resolved: false } },
    "the STRING \"true\" is not Drive saying it resolved the thread",
  );
});

test("a reply and a resolve go to the server functions of those names, and come back parsed", async () => {
  const api = appsScriptFeedbackApi({
    call: stubCall({
      sashaReplyComment: { replyId: "r_new", resolved: false },
      sashaResolveComment: { replyId: "r_res", resolved: true },
    }),
  });
  assert.deepEqual(await api.reply({ fileId: "html_2", commentId: "c_1", content: "still uneven" }), {
    kind: "ok",
    value: { replyId: "r_new", resolved: false },
  });
  assert.deepEqual(await api.resolve({ fileId: "html_2", commentId: "c_1", content: "" }), {
    kind: "ok",
    value: { replyId: "r_res", resolved: true },
  });
});

// --- the thread rail's reply and resolve -------------------------------------

test("a comment reply needs Drive's id, and reads its resolve state as a boolean", () => {
  assert.deepEqual(parseCommentReply({ replyId: "AAAD", resolved: true }), {
    kind: "ok",
    value: { replyId: "AAAD", resolved: true },
  });
  assert.deepEqual(
    parseCommentReply({ replyId: "AAAD" }),
    { kind: "ok", value: { replyId: "AAAD", resolved: false } },
    "an absent resolve state is an OPEN thread, not a failed post",
  );
  assert.deepEqual(
    parseCommentReply({ replyId: "AAAD", resolved: "yes" }),
    { kind: "ok", value: { replyId: "AAAD", resolved: false } },
    "only a real boolean closes a thread",
  );
  assert.equal(parseCommentReply({ replyId: "" }).kind, "invalid", "an unacknowledged post is not a success");
  assert.equal(parseCommentReply({}).kind, "invalid");
  assert.equal(parseCommentReply(null).kind, "invalid");
  assert.equal(parseCommentReply([]).kind, "invalid", "an array is not a reply");
  assert.equal(parseCommentReply("AAAD").kind, "invalid");
});

test("the thread rail's reply and resolve reach the server functions of those names", async () => {
  const api = appsScriptCommentThreadApi({
    call: stubCall({
      sashaReplyToComment: { replyId: "t_new", resolved: false },
      sashaResolveComment: { replyId: "t_res", resolved: true },
    }),
  });
  assert.deepEqual(await api.reply({ fileId: "html_3", commentId: "c_9", text: "still cropped" }), {
    kind: "ok",
    value: { replyId: "t_new", resolved: false },
  });
  assert.deepEqual(await api.resolve({ fileId: "html_3", commentId: "c_9", text: "Resolved." }), {
    kind: "ok",
    value: { replyId: "t_res", resolved: true },
  });
});

// The rail must not report a thread CLOSED because the button said resolve. Drive is the only
// authority on that, and Code.gs reports the `action` Drive echoed -- so a resolve Drive declined
// to apply comes back as a successful reply on a thread that is still open.
test("a resolve Drive did not apply is an open thread, not a closed one", async () => {
  const api = appsScriptCommentThreadApi({
    call: stubCall({ sashaResolveComment: { replyId: "t_res", resolved: false } }),
  });
  assert.deepEqual(await api.resolve({ fileId: "html_3", commentId: "c_9", text: "Resolved." }), {
    kind: "ok",
    value: { replyId: "t_res", resolved: false },
  });
});

test("a malformed reply from either thread function is a failure naming the function", async () => {
  const api = appsScriptCommentThreadApi({
    call: stubCall({ sashaReplyToComment: { replyId: "" }, sashaResolveComment: "nope" }),
  });
  const replied = await api.reply({ fileId: "html_3", commentId: "c_9", text: "again" });
  assert.equal(replied.kind, "failed");
  assert.match(replied.kind === "failed" ? replied.message : "", /sashaReplyToComment/);
  const resolved = await api.resolve({ fileId: "html_3", commentId: "c_9", text: "Resolved." });
  assert.equal(resolved.kind, "failed");
  assert.match(resolved.kind === "failed" ? resolved.message : "", /sashaResolveComment/);
});
