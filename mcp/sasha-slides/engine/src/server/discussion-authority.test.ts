// The discussion authority (acceptance 4): actor and time are the server's, roles and authorship
// decide, a repeated request id is answered with its first outcome and appends nothing, mentions
// keep members only, and a body past 10,000 characters is refused. Each rule is a row; the room
// test at the bottom sends a forged actor over a fake socket.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import type {
  CommentAnchor,
  DeckId,
  DeckRole,
  DiscussionCommand,
  DiscussionOutcome,
  DiscussionRequest,
  DiscussionRequestId,
  MessageId,
  Person,
  PersonId,
  ServerMessage,
  SlideId,
  ThreadId,
} from "../contracts/index.ts";
import { manualClock, seededRandom } from "../model/testing/model-fixtures.ts";
import { createDeckRoom } from "./deck-room.ts";
import { decideDiscussionRequest, discussionAuthorityFromLog, type DiscussionAuthorityState } from "./discussion-authority.ts";
import { connectFakeClient } from "./testing/fake-client.ts";

const OWNER = person("pr_00000000000000000000000000000001", "Owner");
const AUTHOR = person("pr_00000000000000000000000000000002", "Author");
const OTHER = person("pr_00000000000000000000000000000003", "Other");
const OUTSIDER = "pr_00000000000000000000000000000009" as PersonId;
const MEMBER_IDS: ReadonlySet<PersonId> = new Set([OWNER.id, AUTHOR.id, OTHER.id]);
const THREAD = "th_thread0001" as ThreadId;
const FIRST_MESSAGE = "ms_message001" as MessageId;
const ANCHOR: CommentAnchor = { slideId: "sl_slide00001" as SlideId, target: { kind: "slide" }, region: null, elementFrameAtCreation: null };

describe("discussion authority", () => {
  type Row = Readonly<{
    name: string;
    actor: Person;
    role: DeckRole;
    command: DiscussionCommand;
    expected: "applied" | Extract<DiscussionOutcome, { kind: "rejected" }>["reason"];
  }>;
  const rows: readonly Row[] = [
    { name: "control: the author edits their own message", actor: AUTHOR, role: "commenter", command: { kind: "editMessage", threadId: THREAD, messageId: FIRST_MESSAGE, body: "Edited", mentions: [] }, expected: "applied" },
    { name: "editMessage by a non-author", actor: OTHER, role: "editor", command: { kind: "editMessage", threadId: THREAD, messageId: FIRST_MESSAGE, body: "Edited", mentions: [] }, expected: "notAuthor" },
    { name: "deleteMessage by a non-author", actor: OWNER, role: "owner", command: { kind: "deleteMessage", threadId: THREAD, messageId: FIRST_MESSAGE }, expected: "notAuthor" },
    { name: "deleteThread by the owner", actor: OWNER, role: "owner", command: { kind: "deleteThread", threadId: THREAD }, expected: "applied" },
    { name: "deleteThread by another commenter", actor: OTHER, role: "commenter", command: { kind: "deleteThread", threadId: THREAD }, expected: "notPermitted" },
    { name: "deleteThread by its creator", actor: AUTHOR, role: "commenter", command: { kind: "deleteThread", threadId: THREAD }, expected: "applied" },
    { name: "a viewer's createThread", actor: OTHER, role: "viewer", command: createThread({ threadId: "th_thread0002", messageId: "ms_message002", body: "Hi" }), expected: "notPermitted" },
    { name: "a body of 10,000 characters", actor: OTHER, role: "commenter", command: createThread({ threadId: "th_thread0003", messageId: "ms_message003", body: "x".repeat(10_000) }), expected: "applied" },
    { name: "a body of 10,001 characters", actor: OTHER, role: "commenter", command: createThread({ threadId: "th_thread0004", messageId: "ms_message004", body: "x".repeat(10_001) }), expected: "invalidValue" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const decision = decideDiscussionRequest({ state: withOneThread(), request: request("dq_request0099", row.command), actor: row.actor, role: row.role, memberIds: MEMBER_IDS, now: 5_000 });
      assert.equal(decision.outcome.kind === "applied" ? "applied" : decision.outcome.reason, row.expected);
      assert.equal(decision.entry === null, row.expected !== "applied");
    });
  }

  test("actor and time come from the session and the clock", () => {
    const decision = decideDiscussionRequest({ state: withOneThread(), request: request("dq_request0100", { kind: "resolveThread", threadId: THREAD }), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 77_777 });
    assert.deepEqual(decision.entry?.actor, OTHER);
    assert.equal(decision.entry?.at, 77_777);
  });

  test("a repeated request id returns the identical first outcome and appends nothing, refusals included", () => {
    for (const role of ["commenter", "viewer"] as const) {
      const first = decideDiscussionRequest({ state: withOneThread(), request: request("dq_request0101", { kind: "reopenThread", threadId: THREAD }), actor: OTHER, role, memberIds: MEMBER_IDS, now: 1 });
      const again = decideDiscussionRequest({ state: first.state, request: request("dq_request0101", { kind: "resolveThread", threadId: THREAD }), actor: OTHER, role: "owner", memberIds: MEMBER_IDS, now: 2 });
      assert.deepEqual(again.outcome, first.outcome);
      assert.equal(again.entry, null);
      assert.equal(again.state.snapshot.sequence, first.state.snapshot.sequence);
    }
  });

  test("mentions keep current members only, each once", () => {
    const decision = decideDiscussionRequest({
      state: withOneThread(),
      request: request("dq_request0102", { kind: "reply", threadId: THREAD, messageId: "ms_message010" as MessageId, body: "@Other @Nobody", mentions: [OTHER.id, OUTSIDER, OTHER.id] }),
      actor: AUTHOR,
      role: "commenter",
      memberIds: MEMBER_IDS,
      now: 3,
    });
    const command = decision.entry?.command;
    assert.ok(command !== undefined && command.kind === "reply");
    assert.deepEqual(command.mentions, [OTHER.id]);
  });

  test("a request id is remembered per person: another person reusing it is decided on its own", () => {
    const first = decideDiscussionRequest({ state: withOneThread(), request: request("dq_request0103", { kind: "resolveThread", threadId: THREAD }), actor: AUTHOR, role: "viewer", memberIds: MEMBER_IDS, now: 1 });
    assert.equal(first.outcome.kind, "rejected");
    const reused = decideDiscussionRequest({ state: first.state, request: request("dq_request0103", { kind: "resolveThread", threadId: THREAD }), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 2 });
    assert.equal(reused.outcome.kind, "applied");
    assert.notEqual(reused.entry, null);
    const repeated = decideDiscussionRequest({ state: reused.state, request: request("dq_request0103", { kind: "reopenThread", threadId: THREAD }), actor: AUTHOR, role: "owner", memberIds: MEMBER_IDS, now: 3 });
    assert.deepEqual(repeated.outcome, first.outcome, "the first person's own repeat still gets their first outcome");
  });
});

describe("discussion limits per deck", () => {
  test("a thread holds at most 500 messages: the 500th is applied, the 501st is limitReached", () => {
    const fullBut = threadWithReplies({ replies: 498, body: "Reply" });
    const last = decideDiscussionRequest({ state: fullBut, request: request("dq_request0300", reply("ms_message300", "One more")), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 9 });
    assert.equal(last.outcome.kind, "applied");
    const over = decideDiscussionRequest({ state: last.state, request: request("dq_request0301", reply("ms_message301", "Too many")), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 10 });
    assert.equal(rejection(over.outcome), "limitReached");
    assert.match(messageOf(over.outcome), /500 messages/);
  });

  test("a message is edited at most 100 times, counted across a restart (the stored log)", () => {
    const edits = Array.from({ length: 99 }, (_, index) => ({ actor: AUTHOR, command: edit(`Edit ${String(index)}`) }));
    const restarted = stateFromLog([{ actor: AUTHOR, command: createThread({ threadId: THREAD, messageId: FIRST_MESSAGE, body: "First" }) }, ...edits]);
    const hundredth = decideDiscussionRequest({ state: restarted, request: request("dq_request0310", edit("Edit 100")), actor: AUTHOR, role: "commenter", memberIds: MEMBER_IDS, now: 9 });
    assert.equal(hundredth.outcome.kind, "applied");
    const over = decideDiscussionRequest({ state: hundredth.state, request: request("dq_request0311", edit("Edit 101")), actor: AUTHOR, role: "commenter", memberIds: MEMBER_IDS, now: 10 });
    assert.equal(rejection(over.outcome), "limitReached");
    assert.match(messageOf(over.outcome), /100 times/);
  });

  test("a deck's live message bodies hold at most 5 megabytes, counted in UTF-8 bytes", () => {
    // 262 messages of 10,000 two-byte characters: 5,240,000 bytes, but only 2,620,000 characters,
    // so a limit counted in characters would never refuse what follows.
    const twoByte = "\u00e9".repeat(10_000);
    const nearlyFull = threadWithReplies({ replies: 261, body: twoByte });
    const remaining = 5 * 1024 * 1024 - 262 * 20_000;
    const exactlyFull = decideDiscussionRequest({ state: nearlyFull, request: request("dq_request0320", reply("ms_message320", "x".repeat(remaining))), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 9 });
    assert.equal(exactlyFull.outcome.kind, "applied", "reaching the limit exactly is allowed");
    const over = decideDiscussionRequest({ state: exactlyFull.state, request: request("dq_request0321", reply("ms_message321", "x")), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 10 });
    assert.equal(rejection(over.outcome), "limitReached");
    assert.match(messageOf(over.outcome), /5 megabytes/);
    const newThread = decideDiscussionRequest({ state: exactlyFull.state, request: request("dq_request0322", createThread({ threadId: "th_thread0322", messageId: "ms_message322", body: "x" })), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 10 });
    assert.equal(rejection(newThread.outcome), "limitReached");
    const shrunk = decideDiscussionRequest({ state: exactlyFull.state, request: request("dq_request0323", edit("Shorter")), actor: AUTHOR, role: "commenter", memberIds: MEMBER_IDS, now: 11 });
    assert.equal(shrunk.outcome.kind, "applied", "an edit that shrinks a message is allowed at the limit");
    const afterShrinking = decideDiscussionRequest({ state: shrunk.state, request: request("dq_request0324", reply("ms_message324", "x")), actor: OTHER, role: "commenter", memberIds: MEMBER_IDS, now: 12 });
    assert.equal(afterShrinking.outcome.kind, "applied", "the bytes the edit freed can be used again");
  });
});

describe("the room's discussion over a socket", () => {
  test("a forged actor and time in the request are ignored; the entry reaches every connection before the outcome", async () => {
    const clock = manualClock(123_456);
    const room = createDeckRoom({
      deckId: "dk_discussionDeck00000001" as DeckId,
      seed: { kind: "blankDeck" },
      storedDiscussion: [],
      members: [OWNER, AUTHOR, OTHER].map((member) => ({ person: member, role: "commenter" as const, email: null })),
      now: clock.now,
      scheduler: new VirtualTimeScheduler(),
      random: seededRandom(4),
      persistUpdate: () => undefined,
      persistDiscussionEntry: () => Promise.resolve(),
      connectionsChanged: () => undefined,
      warn: () => undefined,
    });
    using author = connectFakeClient({ room, person: AUTHOR, role: "commenter" });
    using other = connectFakeClient({ room, person: OTHER, role: "viewer" });
    const forged = { kind: "discussionRequest", request: { ...request("dq_request0200", createThread({ threadId: "th_thread0200", messageId: "ms_message200", body: "Hello" })), actor: OWNER, at: 1 } };
    author.sendText(JSON.stringify(forged));
    await waitFor(() => author.messages().some((message) => message.kind === "discussionOutcome"));
    const entries = (messages: readonly ServerMessage[]) => messages.flatMap((message) => (message.kind === "discussionEntries" ? message.entries : []));
    const [entry] = entries(other.messages());
    assert.deepEqual(entry?.actor, AUTHOR);
    assert.equal(entry?.at, 123_456);
    const kinds = author.messages().map((message) => message.kind);
    assert.ok(kinds.lastIndexOf("discussionEntries") < kinds.indexOf("discussionOutcome"), "the entry is broadcast before the outcome is answered");
    room[Symbol.dispose]();
  });
});

function withOneThread(): DiscussionAuthorityState {
  return discussionAuthorityFromLog([
    { sequence: 1, requestId: "dq_request0001" as DiscussionRequestId, actor: AUTHOR, at: 1_000, command: createThread({ threadId: THREAD, messageId: FIRST_MESSAGE, body: "First" }) },
  ]);
}

function stateFromLog(entries: readonly Readonly<{ actor: Person; command: DiscussionCommand }>[]): DiscussionAuthorityState {
  return discussionAuthorityFromLog(
    entries.map((entry, index) => ({ sequence: index + 1, requestId: `dq_log${String(index).padStart(6, "0")}` as DiscussionRequestId, actor: entry.actor, at: 1_000 + index, command: entry.command })),
  );
}

/** The thread `THREAD` by AUTHOR, its first message "First", then `replies` replies by OTHER. */
function threadWithReplies(options: Readonly<{ replies: number; body: string }>): DiscussionAuthorityState {
  const first = options.body === "Reply" ? "First" : options.body;
  const replies = Array.from({ length: options.replies }, (_, index) => ({ actor: OTHER, command: reply(`ms_reply${String(index).padStart(5, "0")}`, options.body) }));
  return stateFromLog([{ actor: AUTHOR, command: createThread({ threadId: THREAD, messageId: FIRST_MESSAGE, body: first }) }, ...replies]);
}

function reply(messageId: string, body: string): DiscussionCommand {
  // As in createThread: a valid object id.
  return { kind: "reply", threadId: THREAD, messageId: messageId as MessageId, body, mentions: [] };
}

function edit(body: string): DiscussionCommand {
  return { kind: "editMessage", threadId: THREAD, messageId: FIRST_MESSAGE, body, mentions: [] };
}

function rejection(outcome: DiscussionOutcome): string {
  return outcome.kind === "rejected" ? outcome.reason : "applied";
}

function messageOf(outcome: DiscussionOutcome): string {
  return outcome.kind === "rejected" ? outcome.message : "";
}

function createThread(options: Readonly<{ threadId: string; messageId: string; body: string }>): DiscussionCommand {
  // Test ids are valid object ids by construction (letters, digits and an underscore).
  return { kind: "createThread", threadId: options.threadId as ThreadId, anchor: ANCHOR, markings: [], messageId: options.messageId as MessageId, body: options.body, mentions: [] };
}

function request(requestId: string, command: DiscussionCommand): DiscussionRequest {
  // As above: a valid object id.
  return { requestId: requestId as DiscussionRequestId, command };
}

function person(id: string, displayName: string): Person {
  // Test person ids follow the `pr_` + 32 hexadecimal shape (deck-access.ts).
  return { id: id as PersonId, displayName, colourIndex: 1, kind: "person" };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("the condition never held");
}
