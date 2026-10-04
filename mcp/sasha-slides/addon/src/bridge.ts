// The contract between the sidebar and Apps Script, and the guards that parse it. This file
// REPLACES the extension's wire.ts: there are no longer three contexts and no port, because an
// Apps Script sidebar is ONE document that lives exactly as long as it is open. What used to be
// content script <-> service worker <-> offscreen document is now sidebar <-> `google.script.run`.
//
// THE FIRST FIVE FUNCTIONS: WHY FIVE AND NOT SEVEN. wire.ts's `Upstream` had five variants
// (hello, visibility, request-slide-html, insert, decide) and they map one-for-one onto the five
// functions below, with two substitutions the vehicle forces:
//
//   hello               -> sashaHello        (the sidebar cannot read the deck's URL: it is served
//                                            from googleusercontent.com, so `presentationIdOf
//                                            (location.href)` is meaningless here. Apps Script is
//                                            the only thing that knows the active presentation.)
//   visibility          -> no call at all    (one sidebar, and `document.visibilityState` is
//                                            readable locally, so the poll cadence needs no server)
//   -- the observer's   -> sashaScanInbox    (was DriveApi.listByRoles. appProperties are private
//      Drive poll                             to the writing OAuth client, so discovery is a NAME
//                                             walk: "Sasha Slides Inbox" -> <proposalId> ->
//                                             READY/PICK. See PROTOCOL.md.)
//   request-slide-html  -> sashaReadText     (one primitive, three callers: READY, manifest.json
//                                             and NN.html are all just text read by file id)
//   insert              -> sashaInsert
//   decide              -> sashaWritePick
//
// EVERYTHING IS PARSED AT THIS BOUNDARY. Apps Script serialises a return value through its own
// JSON-ish bridge, so what arrives is `unknown` no matter what Code.gs wrote. Nothing above this
// file sees an unparsed reply, which is also what lets Code.gs stay a thin relay: every decision
// about whether a reply is usable is made here, in TypeScript that unit-tests.

import { authoredByAgentText, withoutAgentMarker } from "../../agent-marker.ts";
import type { FeedbackCommentRecord, FeedbackReply, SendFeedbackResult } from "./feedback.ts";
// `CandidateCommentsEntry` is DECLARED in session-log.ts, not restated here. A second declaration
// of the same wire shape compiles perfectly and then drifts, which this repo has already paid for
// once (UI-CONTRACT.md on `SlideEditor`); session-log.ts owns the session-log shapes, so the
// parser imports the type it fills in rather than inventing a twin.
import type { CandidateCommentsEntry } from "./session-log.ts";
import { assertNever, type Parsed } from "./protocol.ts";

/**
 * One proposal folder as the inbox name walk found it -- the replacement for the extension's
 * `DriveFileRef`. `proposalId` is the folder's own NAME (PROTOCOL.md: "a proposal folder is found
 * by its `proposalId` name under the inbox"), never a private `appProperties` tag.
 *
 * `readyFileId === null` means the proposal is still partial and must be ignored; a non-null
 * `pickFileId` means it has already been answered and must never be offered again.
 */
export type ProposalMark = Readonly<{
  proposalId: string;
  folderId: string;
  readyFileId: string | null;
  pickFileId: string | null;
  createdTime: string;
}>;

/** `sashaHello()`. The URL, not the id, so the one parse lives in `presentationIdOf` below. */
export type HelloReply = Readonly<{ protocolVersion: number; presentationUrl: string }>;

export type ScanReply = Readonly<{ marks: readonly ProposalMark[] }>;

export type ReadTextReply = Readonly<{ text: string }>;

/**
 * `sashaInsert()`. The RAW batchUpdate response comes back rather than a list of ids, so
 * `createdObjectIdsOf` (drive-api.ts) stays the one place that knows how Slides reports what it
 * created -- and stays testable. `renderArtifact` is best-effort: null is normal, never an error.
 */
export type InsertReply = Readonly<{ batchResponse: unknown; renderArtifact: string | null }>;

export type WritePickReply = Readonly<{ fileId: string }>;

// ---------------------------------------------------------------------------
// THE COMMENT CHANNEL -- the two functions that carry a comment and read it back. Same discipline
// as the first five: Code.gs relays, this file parses, and every decision about what a reply MEANS
// is in feedback.ts / session-log.ts under `node --test`.
//
// `sashaSendFeedback` / `sashaReadFeedback` take any Drive FILE ID, which is what lets the same
// pair serve two jobs: a message about the deck is a comment on the presentation, and a mark-up on
// a CANDIDATE is a comment on that candidate's own `NN.html` (PROTOCOL.md -- "Comments live on the
// CANDIDATE, not the deck"). Nothing here knows which; the caller passes the file.
// ---------------------------------------------------------------------------

/** `sashaSendFeedback()`. One result per requested comment, in the order they were requested. */
export type SendFeedbackReply = Readonly<{ results: readonly SendFeedbackResult[] }>;

/** `sashaReadFeedback()`. Every comment on the presentation -- ours and other people's. */
export type ReadFeedbackReply = Readonly<{ comments: readonly FeedbackCommentRecord[] }>;

export type ReadFeedbackSpec = Readonly<{ fileId: string; pageSize: number }>;

/**
 * `sashaOpenPicker()`. The sidebar asking Apps Script to SHOW THE CANDIDATES DIALOG.
 *
 * This is the only call whose point is a side effect on the host rather than data, and it exists
 * because the two surfaces cannot talk to each other (UI-CONTRACT.md): the sidebar has no handle on
 * the dialog's window and no way to create one in its own document -- `showModelessDialog` is a
 * server-side `SlidesApp.getUi()` call. `opened` is read back rather than assumed, so a host that
 * declined still produces a visible failure instead of a button that silently does nothing.
 */
export type OpenPickerReply = Readonly<{ opened: boolean }>;

/**
 * What a `google.script.run` call can come back as. An Apps Script failure handler hands over an
 * Error, never a status code, so there is no `unauthorized` arm to branch on the way the
 * extension's `HttpOutcome` had: Code.gs reports a 401/403 from Drive as a thrown Error and the
 * observer treats it like any other transport failure (it cannot re-prompt for consent anyway --
 * Apps Script owns the grant).
 */
export type CallOutcome<TValue> =
  | Readonly<{ kind: "ok"; value: TValue }>
  | Readonly<{ kind: "failed"; message: string }>;

/** The functions Code.gs exposes. Arguments are one object each, as Apps Script prefers. */
export type ServerFunctionName =
  | "sashaHello"
  | "sashaScanInbox"
  | "sashaReadText"
  | "sashaReadEvents"
  | "sashaWriteEvent"
  | "sashaCandidateComments"
  | "sashaInsert"
  | "sashaWritePick"
  | "sashaSendFeedback"
  | "sashaReadFeedback"
  | "sashaOpenPicker"
  | "sashaOpenDefectReport"
  | "sashaReportWindowUrl"
  | "sashaTakeReportTarget";

export const SERVER_FUNCTION_NAMES: readonly ServerFunctionName[] = [
  "sashaHello",
  "sashaScanInbox",
  "sashaReadText",
  "sashaReadEvents",
  "sashaWriteEvent",
  "sashaCandidateComments",
  "sashaInsert",
  "sashaWritePick",
  "sashaSendFeedback",
  "sashaReadFeedback",
  "sashaOpenPicker",
  "sashaOpenDefectReport",
  "sashaReportWindowUrl",
  "sashaTakeReportTarget",
];

/**
 * `sashaReportWindowUrl()`. THE WEB-APP URL, or null when the script is not deployed as one.
 *
 * Slides hosts exactly ONE dialog, so opening the report evicted the Candidate slides window
 * (measured 2026-10-04). A web-app window is the only separate browser window Apps Script can
 * give, and it exists only once somebody has deployed the script as one -- so `null` is an
 * ordinary answer here, not a failure, and the caller falls back to the dialog.
 */
export function parseReportWindowUrl(value: unknown): Parsed<string | null> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaReportWindowUrl did not return an object" };
  const url = record["url"];
  if (url === null || url === undefined) return { kind: "ok", value: null };
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return { kind: "invalid", reason: "url must be an https URL or null" };
  }
  return { kind: "ok", value: url };
}

/**
 * `sashaTakeReportTarget()`. WHICH CANDIDATE THE DEFECT-REPORT WINDOW WAS OPENED ON, read once and
 * cleared.
 *
 * The surfaces share nothing, so "open the report window on slide 2 of this proposal" cannot be a
 * message from one document to another -- there is no channel and no window handle
 * (UI-CONTRACT.md). It goes the only way anything goes between them: through the server. Whoever
 * pressed the button records the target with `sashaOpenDefectReport` and shows the window; the
 * window asks for it and the server hands it over exactly once, so a report window opened later
 * does not come up on a slide the user finished with yesterday.
 *
 * BOTH FIELDS NULL IS THE NORMAL "nothing was recorded" answer, not an error: the window then
 * picks the first staged candidate itself and says so.
 */
export type ReportTargetReply = Readonly<{ proposalId: string | null; slideIndex: number | null }>;

/** What `sashaOpenDefectReport` is told to record. Null when the caller has no slide in mind. */
export type ReportTargetSpec = Readonly<{
  proposalId: string | null;
  slideIndex: number | null;
  /**
   * Whether the HOST should also show the report as a dialog.
   *
   * False when the caller already opened a real second window: Slides hosts exactly one dialog,
   * so showing it anyway would evict the Candidate slides the user is reporting on -- which is
   * the defect this whole path exists to fix. The target is recorded either way.
   */
  showDialog: boolean;
}>;

/** `sashaReadEvents()`. One proposal's whole `events/` folder, raw -- name and bytes per file. */
export type ReadEventsReply = Readonly<{ events: readonly RawEventFile[] }>;

/** `fileId` is the sort's last tie-break -- see session-log.ts's `sessionEventsOf`. */
export type RawEventFile = Readonly<{ fileId: string; name: string; text: string }>;

export type ReadEventsSpec = Readonly<{ folderId: string; pageSize: number }>;

/** `sashaWriteEvent()`. One event file CREATED under `<proposal>/events/` -- never an append. */
export type WriteEventSpec = Readonly<{
  folderId: string;
  name: string;
  mimeType: string;
  body: string;
}>;

export type WriteEventReply = Readonly<{ fileId: string }>;

/**
 * `sashaCandidateComments()`. The comment threads on each candidate file, one entry per file ASKED
 * FOR -- including the ones Drive refused, which carry their own `error`. A per-file error rather
 * than one verdict is what lets slide 2's badge say "could not be read" while slide 1's shows 3.
 */
export type CandidateCommentsReply = Readonly<{ files: readonly CandidateCommentsEntry[] }>;

export type CandidateCommentsSpec = Readonly<{ fileIds: readonly string[]; pageSize: number }>;

/**
 * What `sashaInsert` is told to write back to Drive after the batchUpdate succeeds. Every name and
 * tag is computed in TypeScript (render-artifact.ts) and executed blindly by Code.gs, so the
 * protocol's naming rules stay unit-tested instead of living in an un-runnable .gs file.
 */
export type RenderRequest = Readonly<{
  /** The proposal folder the `render` subfolder goes in. */
  folderId: string;
  folderName: string;
  folderAppProperties: Readonly<Record<string, string>>;
  fileName: string;
  fileAppProperties: Readonly<Record<string, string>>;
  mimeType: string;
  /** Which page of the deck to rasterise. */
  pageObjectId: string;
}>;

export type InsertRequestSpec = Readonly<{
  presentationId: string;
  requests: readonly Readonly<Record<string, unknown>>[];
  /** null for a deck with no proposal folder to write into; the insert still happens. */
  render: RenderRequest | null;
}>;

export type WritePickSpec = Readonly<{
  folderId: string;
  name: string;
  mimeType: string;
  body: string;
  appProperties: Readonly<Record<string, string>>;
}>;

/**
 * The deck the sidebar is bound to, or null. Apps Script hands over
 * `https://docs.google.com/presentation/d/<id>/edit`, so this is the same regex the extension used
 * on `location.href` -- kept because it is ALSO the id's charset check, and because keeping the
 * parse here is what lets `sashaHello` be a one-line relay.
 */
export function presentationIdOf(url: string): string | null {
  // TWO shapes reach here, and only the first is the one you see in a browser.
  //
  //  1. the editor URL, `https://docs.google.com/presentation/d/<id>/edit`, optionally with a
  //     `/u/<n>/` segment when more than one Google account is signed in;
  //  2. the LEGACY Drive form, `https://docs.google.com/open?id=<id>`, which is what
  //     `SlidesApp.getActivePresentation().getUrl()` actually returns -- measured from the live
  //     add-on, where only accepting shape 1 parsed to null and the picker disabled Insert with
  //     "this tab is not an editable presentation" on a perfectly editable deck.
  //
  // Host and scheme stay pinned in both, so a lookalike origin still parses to null.
  const editor = /^https:\/\/docs\.google\.com\/(?:u\/\d+\/)?presentation\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/.exec(url);
  if (editor !== null) return editor[1] ?? null;
  const legacy = /^https:\/\/docs\.google\.com\/(?:u\/\d+\/)?open\?id=([A-Za-z0-9_-]{10,})(?:&|$)/.exec(url);
  return legacy === null ? null : (legacy[1] ?? null);
}

/**
 * Turn an Apps Script HOST failure into something the user can act on.
 *
 * These are not our errors: `google.script.run` surfaces them when Google declines to run the
 * function at all, and the raw strings are opaque ("a server error occurred while reading from
 * storage"). Each pattern below was seen in the wild against this add-on, so the mapping is
 * evidence, not decoration. Returns null when the string is not a known host failure, in which
 * case the caller shows it unchanged.
 */
export function explainHostFailure(raw: string): string | null {
  // Google refuses to load the bound script for the session. Overwhelmingly this is a browser
  // signed into more than one Google account: the add-on iframe is served under a /u/<n>/ path
  // and the script cannot be read for that profile.
  if (/reading from storage/i.test(raw) && /PERMISSION_DENIED/i.test(raw)) {
    return (
      "Google would not load the add-on for this browser session. This almost always means more " +
      "than one Google account is signed in. Open the presentation in an Incognito window signed " +
      "in only as its owner, or make that account the default one (its URL should read /u/0/)."
    );
  }
  if (/Authorization is required|Authorisation is required/i.test(raw)) {
    return "The add-on needs authorising for this account. Reload the presentation and accept the permission prompt.";
  }
  if (/Script function not found/i.test(raw)) {
    return "The deployed Code.gs is older than this picker. Redeploy it (deploy-via-ide.ts --step code, or clasp push).";
  }
  if (/has not been used in project|SERVICE_DISABLED/i.test(raw)) {
    return (
      "A Google API is disabled for the script's own Cloud project. Code.gs should be calling the " +
      "Slides ADVANCED SERVICE rather than slides.googleapis.com over UrlFetchApp."
    );
  }
  return null;
}

export function parseHelloReply(value: unknown): Parsed<HelloReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaHello returned no object" };
  const protocolVersion = integerAt({ record, key: "protocolVersion" });
  const presentationUrl = stringAt({ record, key: "presentationUrl" });
  if (protocolVersion === null) return { kind: "invalid", reason: "sashaHello returned no protocolVersion" };
  if (presentationUrl === null) return { kind: "invalid", reason: "sashaHello returned no presentationUrl" };
  return { kind: "ok", value: { protocolVersion, presentationUrl } };
}

/**
 * A scan reply, dropping any folder the walk could not make sense of rather than failing the whole
 * poll: one unreadable folder in the inbox must not blind the observer to the others.
 */
export function parseScanReply(value: unknown): Parsed<ScanReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaScanInbox returned no object" };
  const raw = record["marks"];
  if (!Array.isArray(raw)) return { kind: "invalid", reason: "sashaScanInbox returned no marks array" };
  const marks: ProposalMark[] = [];
  for (const candidate of raw) {
    const mark = parseProposalMark(candidate);
    if (mark !== null) marks.push(mark);
  }
  return { kind: "ok", value: { marks } };
}

export function parseProposalMark(value: unknown): ProposalMark | null {
  const record = asRecord(value);
  if (record === null) return null;
  const proposalId = stringAt({ record, key: "proposalId" });
  const folderId = stringAt({ record, key: "folderId" });
  if (proposalId === null || proposalId === "" || folderId === null || folderId === "") return null;
  return {
    proposalId,
    folderId,
    readyFileId: stringAt({ record, key: "readyFileId" }),
    pickFileId: stringAt({ record, key: "pickFileId" }),
    createdTime: stringAt({ record, key: "createdTime" }) ?? "",
  };
}

export function parseReadTextReply(value: unknown): Parsed<ReadTextReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaReadText returned no object" };
  const text = stringAt({ record, key: "text" });
  return text === null
    ? { kind: "invalid", reason: "sashaReadText returned no text" }
    : { kind: "ok", value: { text } };
}

export function parseInsertReply(value: unknown): Parsed<InsertReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaInsert returned no object" };
  // `batchResponse` stays `unknown` on purpose: createdObjectIdsOf is the only reader and it
  // already sweeps an arbitrary reply shape.
  return {
    kind: "ok",
    value: { batchResponse: record["batchResponse"], renderArtifact: stringAt({ record, key: "renderArtifact" }) },
  };
}

export function parseWritePickReply(value: unknown): Parsed<WritePickReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaWritePick returned no object" };
  const fileId = stringAt({ record, key: "fileId" });
  return fileId === null
    ? { kind: "invalid", reason: "sashaWritePick returned no fileId" }
    : { kind: "ok", value: { fileId } };
}

/**
 * The event folder's listing. A file with no id, no name or no text is DROPPED -- it is not an
 * event, and there is nothing for `parseSessionEventFile` to render opaque. Anything that has all
 * three survives, however unreadable its bytes: deciding that is session-log.ts's job, not this
 * one's. The id is required because it is the last key of the event sort, and an event without it
 * could order differently here than on the server.
 */
export function parseReadEventsReply(value: unknown): Parsed<ReadEventsReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaReadEvents returned no object" };
  const raw = record["events"];
  if (!Array.isArray(raw)) return { kind: "invalid", reason: "sashaReadEvents returned no events array" };
  const events: RawEventFile[] = [];
  for (const candidate of raw) {
    const entry = asRecord(candidate);
    if (entry === null) continue;
    const fileId = stringAt({ record: entry, key: "fileId" });
    const name = stringAt({ record: entry, key: "name" });
    const text = stringAt({ record: entry, key: "text" });
    if (fileId === null || fileId === "" || name === null || name === "" || text === null) continue;
    events.push({ fileId, name, text });
  }
  return { kind: "ok", value: { events } };
}

export function parseWriteEventReply(value: unknown): Parsed<WriteEventReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaWriteEvent returned no object" };
  const fileId = stringAt({ record, key: "fileId" });
  return fileId === null || fileId === ""
    ? { kind: "invalid", reason: "sashaWriteEvent returned no fileId" }
    : { kind: "ok", value: { fileId } };
}

/**
 * The per-candidate comment read. An entry with no `fileId` is dropped (there is no slide to
 * attribute it to); an entry whose `comments` array is missing is kept as an ERROR rather than as
 * an empty list, because "no comments" and "could not read the comments" are the two answers this
 * whole mechanism exists to keep apart.
 */
export function parseCandidateCommentsReply(value: unknown): Parsed<CandidateCommentsReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaCandidateComments returned no object" };
  const raw = record["files"];
  if (!Array.isArray(raw)) return { kind: "invalid", reason: "sashaCandidateComments returned no files array" };
  const files: CandidateCommentsEntry[] = [];
  for (const candidate of raw) {
    const entry = asRecord(candidate);
    if (entry === null) continue;
    const fileId = stringAt({ record: entry, key: "fileId" });
    if (fileId === null || fileId === "") continue;
    const error = stringAt({ record: entry, key: "error" });
    const listed = entry["comments"];
    if (error !== null) {
      files.push({ fileId, comments: [], error });
      continue;
    }
    if (!Array.isArray(listed)) {
      files.push({ fileId, comments: [], error: "Drive returned no comments array for this candidate" });
      continue;
    }
    const comments: FeedbackCommentRecord[] = [];
    for (const one of listed) {
      const comment = parseFeedbackCommentRecord(one);
      if (comment !== null) comments.push(comment);
    }
    files.push({ fileId, comments, error: null });
  }
  return { kind: "ok", value: { files } };
}

export function parseSendFeedbackReply(value: unknown): Parsed<SendFeedbackReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaSendFeedback returned no object" };
  const raw = record["results"];
  if (!Array.isArray(raw)) return { kind: "invalid", reason: "sashaSendFeedback returned no results array" };
  const results: SendFeedbackResult[] = [];
  for (const candidate of raw) {
    const entry = asRecord(candidate);
    // A result that is not even an object still counts as one answer, and `sendOutcomeOf` compares
    // the count against what was requested -- so it is kept as an explicit failure, not dropped.
    if (entry === null) {
      results.push({ commentId: null, error: "sashaSendFeedback returned a non-object result" });
      continue;
    }
    results.push({
      commentId: stringAt({ record: entry, key: "commentId" }),
      error: stringAt({ record: entry, key: "error" }),
    });
  }
  return { kind: "ok", value: { results } };
}

/**
 * The comment list. A comment the walk cannot make sense of is DROPPED rather than failing the
 * whole read, for the same reason `parseScanReply` drops an unreadable folder: one odd row in a
 * pane the add-on does not own must not blind the user to the answers they are waiting for.
 */
export function parseReadFeedbackReply(value: unknown): Parsed<ReadFeedbackReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaReadFeedback returned no object" };
  const raw = record["comments"];
  if (!Array.isArray(raw)) return { kind: "invalid", reason: "sashaReadFeedback returned no comments array" };
  const comments: FeedbackCommentRecord[] = [];
  for (const candidate of raw) {
    const comment = parseFeedbackCommentRecord(candidate);
    if (comment !== null) comments.push(comment);
  }
  return { kind: "ok", value: { comments } };
}

export function parseFeedbackCommentRecord(value: unknown): FeedbackCommentRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const commentId = stringAt({ record, key: "id" });
  const content = stringAt({ record, key: "content" });
  if (commentId === null || commentId === "" || content === null) return null;
  const raw = record["replies"];
  const replies: FeedbackReply[] = [];
  if (Array.isArray(raw)) {
    for (const candidate of raw) {
      const reply = parseFeedbackReply(candidate);
      if (reply !== null) replies.push(reply);
    }
  }
  return {
    commentId,
    content,
    createdAt: stringAt({ record, key: "createdTime" }) ?? "",
    resolved: record["resolved"] === true,
    author: authorNameOf(record["author"]),
    replies,
  };
}

/**
 * `sashaOpenPicker`'s reply. `opened` must be explicitly `true`: anything else -- a missing field,
 * a stale Code.gs that returned nothing -- is a refusal the sidebar has to show, not a success.
 */
export function parseOpenPickerReply(value: unknown): Parsed<OpenPickerReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaOpenPicker returned no object" };
  return record["opened"] === true
    ? { kind: "ok", value: { opened: true } }
    : { kind: "invalid", reason: "Google Slides did not open the candidates window" };
}

/**
 * The recorded report target. Both fields absent is the NORMAL "nothing was recorded" answer, so
 * this parser has no `invalid` arm for a missing field -- only for a reply that is not an object
 * at all, which is a stale deploy.
 */
export function parseReportTargetReply(value: unknown): Parsed<ReportTargetReply> {
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "sashaTakeReportTarget returned no object" };
  const proposalId = stringAt({ record, key: "proposalId" });
  const slideIndex = integerAt({ record, key: "slideIndex" });
  return {
    kind: "ok",
    value: {
      proposalId: proposalId === "" ? null : proposalId,
      slideIndex: slideIndex !== null && slideIndex >= 1 ? slideIndex : null,
    },
  };
}

/** A parsed reply as a CallOutcome, so every caller handles one failure shape. */

export function outcomeOf<TValue>({ parsed, what }: { parsed: Parsed<TValue>; what: string }): CallOutcome<TValue> {
  switch (parsed.kind) {
    case "ok":
      return parsed;
    case "invalid":
      return { kind: "failed", message: `${what}: ${parsed.reason}` };
    case "unsupported-version":
      return { kind: "failed", message: `${what} declares protocolVersion ${parsed.protocolVersion}` };
    default:
      return assertNever(parsed);
  }
}

/**
 * ONE REPLY, WITH THE PROTOCOL TAKEN OFF IT.
 *
 * The agent marks its own posts because the connector and the user authenticate as the SAME
 * Google account, so Drive's author field cannot tell them apart. That marker is wire format:
 * it is read here into `authoredByAgent` and REMOVED from the text, because the deployed
 * add-on rendered the literal "[sasha-slides-agent]" to the user under every answer Sasha
 * gave (2026-10-04).
 */
export function parseFeedbackReply(value: unknown): FeedbackReply | null {
  const record = asRecord(value);
  if (record === null) return null;
  const replyId = stringAt({ record, key: "id" });
  const text = stringAt({ record, key: "content" });
  if (replyId === null || replyId === "" || text === null || text.trim() === "") return null;
  return {
    replyId,
    author: authorNameOf(record["author"]),
    createdAt: stringAt({ record, key: "createdTime" }) ?? "",
    text: withoutAgentMarker(text.trim()),
    authoredByAgent: authoredByAgentText(text),
  };
}

/** Drive nests the display name; an anonymous or stripped author is "someone", never "undefined". */
function authorNameOf(field: unknown): string {
  const record = asRecord(field);
  const name = record === null ? null : stringAt({ record, key: "displayName" });
  return name === null || name === "" ? "someone" : name;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function integerAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
