// THE DISCUSSION AUTHORITY: the deck server's half of discussion.ts. A client sends only a
// `DiscussionRequest`; this decides it against the session's person and role and the server's
// clock, and returns the outcome plus the log entry to append. Pure over an immutable state, so
// the room only stores the value and every rule is tested without a socket (SPEC.md 21.5, 21.9).
//
// Key decisions:
//
//  * ACTOR AND TIME ARE THE SERVER'S. The entry's `actor` is the session's person and `at` the
//    injected clock, whatever the request carries (it carries neither: discussion.ts).
//  * ROLES FIRST, THEN THE LOG'S OWN RULES. `comment` is needed for everything; deleting someone
//    else's thread needs `moderateDiscussion` (`notPermitted` otherwise); then the model's
//    `discussionRefusal` decides existence, duplicates and authorship, so the authority and every
//    replica's fold agree by construction.
//  * LIMITS ARE VALUES, NOT LIMITS ON THE WIRE: a body over 10,000 characters, more than 50
//    markings or a marking of more than 2,000 points is `invalidValue` with a sentence saying which.
//  * A DECK'S DISCUSSION IS BOUNDED, so one member cannot grow it without end: 5,000 threads, 500
//    messages per thread, 100 edits per message and 5 megabytes of live message bodies per deck
//    are `limitReached`, again with a sentence. The byte budget counts the UTF-8 bytes of the
//    bodies of the messages that are still there (what every replica holds in memory and every
//    client renders), kept as a running total in this state, so a decision costs one body's
//    encoding instead of a walk over the deck; deleting a message gives its bytes back. The edit
//    count is the fold's own `CommentMessage.editCount`, so it survives a restart with the log.
//  * MENTIONS ARE FILTERED, NOT REFUSED. Ids of people who are not current members are dropped
//    (and duplicates), then the list is cut to 20; the stored command carries the filtered list.
//  * IDEMPOTENT BY PERSON AND REQUEST ID. The outcome of each of the last 1,000 requests is
//    remembered, refusals included, and the same person repeating a request id gets the identical
//    first outcome and appends nothing: a retry after a reconnect never doubles a comment. Another
//    person's request with the same id is decided on its own (request ids are minted by clients).

import { assertNever } from "../contracts/assert-never.ts";
import { COLLABORATION_LIMITS } from "../contracts/collaboration.ts";
import { roleAllows, type DeckRole } from "../contracts/deck-access.ts";
import {
  EMPTY_DISCUSSION,
  type CommentThread,
  type DiscussionCommand,
  type DiscussionLogEntry,
  type DiscussionOutcome,
  type DiscussionRequest,
  type DiscussionSnapshot,
  type Marking,
  type Person,
} from "../contracts/discussion.ts";
import type { DiscussionRequestId, MessageId, PersonId, ThreadId } from "../contracts/ids.ts";
import { discussionRefusal, reduceDiscussionLog } from "../model/discussion-log.ts";

export type DiscussionAuthorityState = Readonly<{
  snapshot: DiscussionSnapshot;
  /** Oldest first; at most `rememberedDiscussionRequestIds` entries. */
  remembered: readonly RememberedOutcome[];
  /** UTF-8 bytes of every live message body in `snapshot` (see the header). */
  discussionBytes: number;
}>;

export type RememberedOutcome = Readonly<{ personId: PersonId; requestId: DiscussionRequestId; outcome: DiscussionOutcome }>;

export type DiscussionDecision = Readonly<{
  outcome: DiscussionOutcome;
  /** The entry to append (and persist) before the outcome is sent; null for a refusal or a repeat. */
  entry: DiscussionLogEntry | null;
  state: DiscussionAuthorityState;
}>;

/** The authority's state after replaying a stored log (restart): the fold, and no remembered ids beyond the log's. */
export function discussionAuthorityFromLog(entries: readonly DiscussionLogEntry[]): DiscussionAuthorityState {
  let snapshot: DiscussionSnapshot = EMPTY_DISCUSSION;
  const remembered: RememberedOutcome[] = [];
  for (const entry of entries) {
    snapshot = reduceDiscussionLog(snapshot, entry);
    remembered.push({ personId: entry.actor.id, requestId: entry.requestId, outcome: { kind: "applied", requestId: entry.requestId, sequence: entry.sequence } });
  }
  const discussionBytes = snapshot.threads.reduce((total, thread) => total + threadBodyBytes(thread), 0);
  return { snapshot, remembered: remembered.slice(-COLLABORATION_LIMITS.rememberedDiscussionRequestIds), discussionBytes };
}

export function decideDiscussionRequest(
  options: Readonly<{
    state: DiscussionAuthorityState;
    request: DiscussionRequest;
    actor: Person;
    role: DeckRole;
    /** Current members' person ids (agents included): the only ids a mention may keep. */
    memberIds: ReadonlySet<PersonId>;
    now: number;
  }>,
): DiscussionDecision {
  const { state, request, actor, role } = options;
  const earlier = state.remembered.find((remembered) => remembered.personId === actor.id && remembered.requestId === request.requestId);
  if (earlier !== undefined) return { outcome: earlier.outcome, entry: null, state };
  const refusal = authorityRefusal({ state, command: request.command, actor, role });
  if (refusal !== null) {
    const outcome: DiscussionOutcome = { kind: "rejected", requestId: request.requestId, reason: refusal.reason, message: refusal.message };
    return { outcome, entry: null, state: remember({ state, personId: actor.id, requestId: request.requestId, outcome }) };
  }
  const entry: DiscussionLogEntry = {
    sequence: state.snapshot.sequence + 1,
    requestId: request.requestId,
    actor,
    at: options.now,
    command: withFilteredMentions({ command: request.command, memberIds: options.memberIds }),
  };
  const outcome: DiscussionOutcome = { kind: "applied", requestId: request.requestId, sequence: entry.sequence };
  const appended: DiscussionAuthorityState = {
    snapshot: reduceDiscussionLog(state.snapshot, entry),
    remembered: state.remembered,
    discussionBytes: state.discussionBytes + bodyBytesDelta({ threads: state.snapshot.threads, command: entry.command }),
  };
  return { outcome, entry, state: remember({ state: appended, personId: actor.id, requestId: request.requestId, outcome }) };
}

type AuthorityRefusal = Readonly<{ reason: Extract<DiscussionOutcome, { kind: "rejected" }>["reason"]; message: string }>;

function authorityRefusal(
  options: Readonly<{ state: DiscussionAuthorityState; command: DiscussionCommand; actor: Person; role: DeckRole }>,
): AuthorityRefusal | null {
  const { state, command, actor, role } = options;
  if (!roleAllows({ role, permission: "comment" })) return { reason: "notPermitted", message: "your role on this deck cannot comment" };
  const limit = limitRefusal({ state, command });
  if (limit !== null) return limit;
  const moderator = roleAllows({ role, permission: "moderateDiscussion" });
  return moderationRefusal({ state, command, actor, moderator }) ?? discussionRefusal({ threads: state.snapshot.threads, command, actor, mayDeleteAnyThread: moderator });
}

/** Deleting another person's thread is a permission question (`notPermitted`), not an authorship one. */
function moderationRefusal(
  options: Readonly<{ state: DiscussionAuthorityState; command: DiscussionCommand; actor: Person; moderator: boolean }>,
): AuthorityRefusal | null {
  const { state, command, actor, moderator } = options;
  switch (command.kind) {
    case "deleteThread": {
      const thread = state.snapshot.threads.find((candidate) => candidate.id === command.threadId);
      if (thread === undefined || thread.createdBy.id === actor.id || moderator) return null;
      return { reason: "notPermitted", message: "only the thread's creator or the deck's owner may delete it" };
    }
    case "createThread":
    case "reply":
    case "editMessage":
    case "deleteMessage":
    case "resolveThread":
    case "reopenThread":
      return null;
    default:
      return assertNever(command);
  }
}

function limitRefusal(options: Readonly<{ state: DiscussionAuthorityState; command: DiscussionCommand }>): AuthorityRefusal | null {
  const { state, command } = options;
  switch (command.kind) {
    case "createThread":
      if (state.snapshot.threads.length >= COLLABORATION_LIMITS.maximumThreadsPerDeck) {
        return { reason: "limitReached", message: `a deck holds at most ${String(COLLABORATION_LIMITS.maximumThreadsPerDeck)} threads` };
      }
      return bodyRefusal(command.body) ?? markingsRefusal(command.markings) ?? deckBytesRefusal({ state, command });
    case "reply": {
      const thread = state.snapshot.threads.find((candidate) => candidate.id === command.threadId);
      if (thread !== undefined && thread.messages.length >= COLLABORATION_LIMITS.maximumMessagesPerThread) {
        return { reason: "limitReached", message: `a thread holds at most ${String(COLLABORATION_LIMITS.maximumMessagesPerThread)} messages` };
      }
      return bodyRefusal(command.body) ?? deckBytesRefusal({ state, command });
    }
    case "editMessage": {
      const message = findMessage({ threads: state.snapshot.threads, threadId: command.threadId, messageId: command.messageId });
      if (message !== undefined && message.editCount >= COLLABORATION_LIMITS.maximumEditsPerMessage) {
        return { reason: "limitReached", message: `a message can be edited at most ${String(COLLABORATION_LIMITS.maximumEditsPerMessage)} times` };
      }
      return bodyRefusal(command.body) ?? deckBytesRefusal({ state, command });
    }
    case "deleteMessage":
    case "resolveThread":
    case "reopenThread":
    case "deleteThread":
      return null;
    default:
      return assertNever(command);
  }
}

/** Only a request that GROWS the deck's bodies is refused at the limit: an edit that shrinks one is fine. */
function deckBytesRefusal(options: Readonly<{ state: DiscussionAuthorityState; command: DiscussionCommand }>): AuthorityRefusal | null {
  const growth = bodyBytesDelta({ threads: options.state.snapshot.threads, command: options.command });
  if (growth <= 0 || options.state.discussionBytes + growth <= COLLABORATION_LIMITS.maximumDiscussionBytesPerDeck) return null;
  const megabytes = COLLABORATION_LIMITS.maximumDiscussionBytesPerDeck / (1024 * 1024);
  return { reason: "limitReached", message: `the comments on a deck hold at most ${String(megabytes)} megabytes of text; delete some to make room` };
}

/**
 * How `command` changes the UTF-8 bytes of the live bodies, judged against the threads before it.
 * Called for a decision before the log's own rules ran, so a missing thread or message counts as
 * empty; for an accepted entry they exist.
 */
function bodyBytesDelta(options: Readonly<{ threads: readonly CommentThread[]; command: DiscussionCommand }>): number {
  const { threads, command } = options;
  switch (command.kind) {
    case "createThread":
    case "reply":
      return utf8Bytes(command.body);
    case "editMessage":
      return utf8Bytes(command.body) - utf8Bytes(findMessage({ threads, threadId: command.threadId, messageId: command.messageId })?.body ?? "");
    case "deleteMessage":
      return -utf8Bytes(findMessage({ threads, threadId: command.threadId, messageId: command.messageId })?.body ?? "");
    case "deleteThread": {
      const thread = threads.find((candidate) => candidate.id === command.threadId);
      return thread === undefined ? 0 : -threadBodyBytes(thread);
    }
    case "resolveThread":
    case "reopenThread":
      return 0;
    default:
      return assertNever(command);
  }
}

function threadBodyBytes(thread: CommentThread): number {
  return thread.messages.reduce((total, message) => total + utf8Bytes(message.body), 0);
}

function findMessage(options: Readonly<{ threads: readonly CommentThread[]; threadId: ThreadId; messageId: MessageId }>): CommentThread["messages"][number] | undefined {
  return options.threads.find((thread) => thread.id === options.threadId)?.messages.find((message) => message.id === options.messageId);
}

const UTF8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return UTF8.encode(text).byteLength;
}

function bodyRefusal(body: string): AuthorityRefusal | null {
  if (body.length <= COLLABORATION_LIMITS.maximumDiscussionBodyCharacters) return null;
  return { reason: "invalidValue", message: `a message is at most ${String(COLLABORATION_LIMITS.maximumDiscussionBodyCharacters)} characters` };
}

function markingsRefusal(markings: readonly Marking[]): AuthorityRefusal | null {
  if (markings.length > COLLABORATION_LIMITS.maximumMarkingsPerThread) {
    return { reason: "invalidValue", message: `a thread holds at most ${String(COLLABORATION_LIMITS.maximumMarkingsPerThread)} markings` };
  }
  const tooLong = markings.some((marking) => pointCount(marking) > COLLABORATION_LIMITS.maximumPointsPerMarking);
  if (!tooLong) return null;
  return { reason: "invalidValue", message: `a marking has at most ${String(COLLABORATION_LIMITS.maximumPointsPerMarking)} points` };
}

function pointCount(marking: Marking): number {
  switch (marking.kind) {
    case "pen":
      return marking.points.length;
    case "rectangle":
    case "highlight":
    case "arrow":
      return 2;
    default:
      return assertNever(marking);
  }
}

function withFilteredMentions(options: Readonly<{ command: DiscussionCommand; memberIds: ReadonlySet<PersonId> }>): DiscussionCommand {
  const { command, memberIds } = options;
  const filter = (mentions: readonly PersonId[]): readonly PersonId[] =>
    [...new Set(mentions.filter((personId) => memberIds.has(personId)))].slice(0, COLLABORATION_LIMITS.maximumMentionsPerMessage);
  switch (command.kind) {
    case "createThread":
    case "reply":
    case "editMessage":
      return { ...command, mentions: filter(command.mentions) };
    case "deleteMessage":
    case "resolveThread":
    case "reopenThread":
    case "deleteThread":
      return command;
    default:
      return assertNever(command);
  }
}

function remember(
  options: Readonly<{ state: DiscussionAuthorityState; personId: PersonId; requestId: DiscussionRequestId; outcome: DiscussionOutcome }>,
): DiscussionAuthorityState {
  const remembered = [...options.state.remembered, { personId: options.personId, requestId: options.requestId, outcome: options.outcome }];
  return { ...options.state, remembered: remembered.slice(-COLLABORATION_LIMITS.rememberedDiscussionRequestIds) };
}
