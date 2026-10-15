// COMMENTS AS A LOG (discussion.ts): the pure fold every replica runs over the authority's log,
// and the in-memory authority milestone 1 uses in place of the deck server.
//
// Key decisions:
//
//  * THE FOLD TRUSTS ONLY WHAT THE AUTHORITY STAMPED. `actor` and `at` come from the log entry, never
//    from the command, and the fold re-checks authorship itself, so a log replayed anywhere yields
//    the same snapshot even if a bad entry slipped in: an entry that references something missing,
//    or edits a message its actor did not write, is skipped, never thrown on.
//  * STATUS IS ONE FOLDED VALUE. Resolve sets `resolved` with who and when; reopen sets `open` with
//    nothing left over, so a concurrent resolve and reopen end as whichever the log ordered last.
//  * THE AUTHORITY CHECKS BEFORE IT APPENDS, so a client learns of a refusal (`notAuthor`,
//    `threadMissing` ...) from `submit` instead of finding its request silently ignored. A request
//    id already in the log answers with its original outcome: a retried request is not applied twice.

import { Subject } from "rxjs";
import type {
  CommentMessage,
  CommentThread,
  CreateMemoryDiscussionStore,
  DiscussionCommand,
  DiscussionLogEntry,
  DiscussionOutcome,
  DiscussionRejectionReason,
  DiscussionRequest,
  DiscussionSnapshot,
  DiscussionStore,
  Person,
  ReduceDiscussionLog,
} from "../contracts/index.ts";
import { assertNever, EMPTY_DISCUSSION } from "../contracts/index.ts";

export const reduceDiscussionLog: ReduceDiscussionLog = (snapshot, entry) => {
  const threads = applyEntry({ threads: snapshot.threads, entry });
  return { sequence: entry.sequence, threads: threads ?? snapshot.threads };
};

export const createMemoryDiscussionStore: CreateMemoryDiscussionStore = (options) => {
  const log: DiscussionLogEntry[] = [];
  let snapshot: DiscussionSnapshot = EMPTY_DISCUSSION;
  for (const entry of options.initialLog) {
    log.push(entry);
    snapshot = reduceDiscussionLog(snapshot, entry);
  }
  const changes = new Subject<DiscussionSnapshot>();
  const store: DiscussionStore = {
    snapshot: () => snapshot,
    changes: changes.asObservable(),
    submit: (request: DiscussionRequest): Promise<DiscussionOutcome> => {
      const earlier = log.find((entry) => entry.requestId === request.requestId);
      if (earlier !== undefined) return Promise.resolve({ kind: "applied", requestId: request.requestId, sequence: earlier.sequence });
      const refusal = refusalOf({ threads: snapshot.threads, command: request.command, actor: options.actor });
      if (refusal !== null) return Promise.resolve({ kind: "rejected", requestId: request.requestId, reason: refusal.reason, message: refusal.message });
      const entry: DiscussionLogEntry = {
        sequence: snapshot.sequence + 1,
        requestId: request.requestId,
        actor: options.actor,
        at: options.now(),
        command: request.command,
      };
      log.push(entry);
      snapshot = reduceDiscussionLog(snapshot, entry);
      changes.next(snapshot);
      return Promise.resolve({ kind: "applied", requestId: request.requestId, sequence: entry.sequence });
    },
    [Symbol.dispose]: () => changes.complete(),
  };
  return store;
};

type Refusal = Readonly<{ reason: DiscussionRejectionReason; message: string }>;

/** The new thread list, or null when the entry does not apply (see the header: it is skipped). */
function applyEntry(options: Readonly<{ threads: readonly CommentThread[]; entry: DiscussionLogEntry }>): readonly CommentThread[] | null {
  const { threads, entry } = options;
  const command = entry.command;
  if (refusalOf({ threads, command, actor: entry.actor }) !== null) return null;
  switch (command.kind) {
    case "createThread": {
      const message: CommentMessage = { id: command.messageId, author: entry.actor, body: command.body, createdAt: entry.at, editedAt: null };
      return [
        ...threads,
        { id: command.threadId, anchor: command.anchor, status: { kind: "open" }, createdBy: entry.actor, createdAt: entry.at, messages: [message], markings: command.markings },
      ];
    }
    case "reply":
      return updateThread({
        threads,
        threadId: command.threadId,
        update: (thread) => ({ ...thread, messages: [...thread.messages, { id: command.messageId, author: entry.actor, body: command.body, createdAt: entry.at, editedAt: null }] }),
      });
    case "editMessage":
      return updateThread({
        threads,
        threadId: command.threadId,
        update: (thread) => ({
          ...thread,
          messages: thread.messages.map((message) => (message.id === command.messageId ? { ...message, body: command.body, editedAt: entry.at } : message)),
        }),
      });
    case "deleteMessage":
      return updateThread({ threads, threadId: command.threadId, update: (thread) => ({ ...thread, messages: thread.messages.filter((message) => message.id !== command.messageId) }) });
    case "resolveThread":
      return updateThread({ threads, threadId: command.threadId, update: (thread) => ({ ...thread, status: { kind: "resolved", resolvedBy: entry.actor, resolvedAt: entry.at } }) });
    case "reopenThread":
      return updateThread({ threads, threadId: command.threadId, update: (thread) => ({ ...thread, status: { kind: "open" } }) });
    case "deleteThread":
      return threads.filter((thread) => thread.id !== command.threadId);
    default:
      return assertNever(command);
  }
}

function updateThread(
  options: Readonly<{ threads: readonly CommentThread[]; threadId: CommentThread["id"]; update: (thread: CommentThread) => CommentThread }>,
): readonly CommentThread[] {
  return options.threads.map((thread) => (thread.id === options.threadId ? options.update(thread) : thread));
}

/** Why `actor` may not do `command` now, or null when it may. Shared by the authority and the fold. */
function refusalOf(options: Readonly<{ threads: readonly CommentThread[]; command: DiscussionCommand; actor: Person }>): Refusal | null {
  const { threads, command, actor } = options;
  const allMessageIds = (): ReadonlySet<string> => new Set(threads.flatMap((thread) => thread.messages.map((message) => message.id)));
  switch (command.kind) {
    case "createThread":
      if (threads.some((thread) => thread.id === command.threadId)) return { reason: "duplicateId", message: "a thread with this id exists" };
      if (allMessageIds().has(command.messageId)) return { reason: "duplicateId", message: "a message with this id exists" };
      if (command.body.trim().length === 0) return { reason: "invalidValue", message: "a comment needs text" };
      return null;
    case "reply": {
      const thread = threads.find((candidate) => candidate.id === command.threadId);
      if (thread === undefined) return { reason: "threadMissing", message: "the thread does not exist" };
      if (allMessageIds().has(command.messageId)) return { reason: "duplicateId", message: "a message with this id exists" };
      if (command.body.trim().length === 0) return { reason: "invalidValue", message: "a reply needs text" };
      return null;
    }
    case "editMessage":
    case "deleteMessage": {
      const thread = threads.find((candidate) => candidate.id === command.threadId);
      if (thread === undefined) return { reason: "threadMissing", message: "the thread does not exist" };
      const message = thread.messages.find((candidate) => candidate.id === command.messageId);
      if (message === undefined) return { reason: "messageMissing", message: "the message does not exist" };
      if (message.author.id !== actor.id) return { reason: "notAuthor", message: "only the author may change a message" };
      if (command.kind === "editMessage" && command.body.trim().length === 0) return { reason: "invalidValue", message: "a message needs text" };
      return null;
    }
    case "resolveThread":
    case "reopenThread":
      return threads.some((thread) => thread.id === command.threadId) ? null : { reason: "threadMissing", message: "the thread does not exist" };
    case "deleteThread": {
      const thread = threads.find((candidate) => candidate.id === command.threadId);
      if (thread === undefined) return { reason: "threadMissing", message: "the thread does not exist" };
      return thread.createdBy.id === actor.id ? null : { reason: "notAuthor", message: "only the thread's creator may delete it" };
    }
    default:
      return assertNever(command);
  }
}
