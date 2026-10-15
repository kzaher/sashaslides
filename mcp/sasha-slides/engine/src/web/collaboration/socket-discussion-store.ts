// THE DISCUSSION OVER THE DECK'S SOCKET (discussion.ts `DiscussionStore`, SPEC.md 21.4
// "Discussion"): a replica of the deck server's append-only log, folded with the model's
// `reduceDiscussionLog`, and a queue of requests waiting for their outcomes.
//
// Key decisions:
//
//  * A REQUEST WAITS UNTIL IT IS ANSWERED, NOT UNTIL IT IS SENT. Every request without an outcome
//    is sent after every welcome -- queued while offline, or sent on a socket that dropped before
//    the answer came. The server answers a repeated `requestId` with its first outcome (it
//    remembers the last 1,000), so resending never doubles a comment.
//  * ENTRIES AT OR BELOW THE KNOWN SEQUENCE ARE IGNORED. After a reconnect the server sends what
//    follows `discussionAfter`, and an entry the replica already folded may still arrive twice
//    around the switch; folding it again would be harmless for most commands but not all.
//  * `submit` NEVER THROWS: when the connection closes for good, or the store is disposed, every
//    waiting request resolves as rejected with the reason in a sentence.

import { Subject } from "rxjs";
import type { ClientMessage } from "../../contracts/collaboration.ts";
import {
  EMPTY_DISCUSSION,
  type DiscussionLogEntry,
  type DiscussionOutcome,
  type DiscussionRequest,
  type DiscussionSnapshot,
  type DiscussionStore,
  type ReduceDiscussionLog,
} from "../../contracts/discussion.ts";
import type { DiscussionRequestId } from "../../contracts/ids.ts";

/** What the socket effect does with the discussion while a connection lives. */
export type DiscussionParticipant = Readonly<{
  /** The sequence to ask the server to continue after (`discussionAfter`). */
  knownSequence: () => number;
  /** The welcome arrived: send every request still waiting for its outcome through `send`. */
  connected: (send: (frame: string) => void) => void;
  received: (entries: readonly DiscussionLogEntry[]) => void;
  settled: (outcome: DiscussionOutcome) => void;
  disconnected: () => void;
  /** The connection closed for good: refuse what is waiting, and anything submitted later. */
  stopped: (reason: string) => void;
}>;

export type SocketDiscussionStore = Readonly<{ store: DiscussionStore; participant: DiscussionParticipant }>;

export function createSocketDiscussionStore(options: Readonly<{ reduceDiscussionLog: ReduceDiscussionLog }>): SocketDiscussionStore {
  let snapshot: DiscussionSnapshot = EMPTY_DISCUSSION;
  let send: ((frame: string) => void) | null = null;
  let stoppedReason: string | null = null;
  const waiting = new Map<DiscussionRequestId, Readonly<{ request: DiscussionRequest; resolve: (outcome: DiscussionOutcome) => void }>>();
  const changes = new Subject<DiscussionSnapshot>();

  const transmit = (request: DiscussionRequest): void => {
    if (send === null) return;
    const message: ClientMessage = { kind: "discussionRequest", request };
    send(JSON.stringify(message));
  };

  const refuseAll = (reason: string): void => {
    for (const [requestId, entry] of [...waiting]) {
      waiting.delete(requestId);
      entry.resolve(refusal({ requestId, reason }));
    }
  };

  const store: DiscussionStore = {
    snapshot: () => snapshot,
    changes: changes.asObservable(),
    submit: (request) => {
      if (stoppedReason !== null) return Promise.resolve(refusal({ requestId: request.requestId, reason: stoppedReason }));
      const earlier = waiting.get(request.requestId);
      if (earlier !== undefined) return new Promise((resolve) => waiting.set(request.requestId, { request, resolve: chain(earlier.resolve, resolve) }));
      return new Promise((resolve) => {
        waiting.set(request.requestId, { request, resolve });
        transmit(request);
      });
    },
    [Symbol.dispose]: () => {
      stoppedReason = "The deck was closed.";
      send = null;
      refuseAll(stoppedReason);
      changes.complete();
    },
  };

  const participant: DiscussionParticipant = {
    knownSequence: () => snapshot.sequence,
    connected: (sender) => {
      send = sender;
      for (const entry of waiting.values()) transmit(entry.request);
    },
    received: (entries) => {
      const before = snapshot;
      for (const entry of entries) {
        if (entry.sequence <= snapshot.sequence) continue;
        snapshot = options.reduceDiscussionLog(snapshot, entry);
      }
      if (snapshot !== before) changes.next(snapshot);
    },
    settled: (outcome) => {
      const entry = waiting.get(outcome.requestId);
      if (entry === undefined) return;
      waiting.delete(outcome.requestId);
      entry.resolve(outcome);
    },
    disconnected: () => {
      send = null;
    },
    stopped: (reason) => {
      stoppedReason = reason;
      send = null;
      refuseAll(reason);
    },
  };

  return { store, participant };
}

function refusal(options: Readonly<{ requestId: DiscussionRequestId; reason: string }>): DiscussionOutcome {
  return { kind: "rejected", requestId: options.requestId, reason: "notPermitted", message: options.reason };
}

/** Both callers of a request submitted twice before its answer get the one outcome. */
function chain(first: (outcome: DiscussionOutcome) => void, second: (outcome: DiscussionOutcome) => void): (outcome: DiscussionOutcome) => void {
  return (outcome) => {
    first(outcome);
    second(outcome);
  };
}
