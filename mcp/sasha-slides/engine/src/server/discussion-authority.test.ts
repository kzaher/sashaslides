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
