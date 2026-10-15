// A FAKE DECK SERVER SESSION (contracts/collaboration.ts `CollaborationSession`) for the state
// module's tests: statuses and notices are pushed by the test, `reconnectNow` and
// `revertAgentSession` are recorded, and each revert resolves with the outcome the test chose.

import { Subject } from "rxjs";
import type { AgentRevertOutcome, CollaborationNotice, CollaborationSession, CollaborationStatus } from "../../contracts/index.ts";

export type FakeCollaborationSession = CollaborationSession &
  Readonly<{
    /** Sets the current status and emits it, as the web module's session does. */
    emitStatus: (status: CollaborationStatus) => void;
    emitNotice: (notice: CollaborationNotice) => void;
    reconnectCalls: () => number;
    revertCalls: () => readonly string[];
  }>;

export function createFakeCollaborationSession(options: Readonly<{ initial: CollaborationStatus; revertOutcome: AgentRevertOutcome }>): FakeCollaborationSession {
  let status = options.initial;
  let reconnects = 0;
  const reverts: string[] = [];
  const statusChanges = new Subject<CollaborationStatus>();
  const notices = new Subject<CollaborationNotice>();
  return {
    status: () => status,
    statusChanges: statusChanges.asObservable(),
    notices: notices.asObservable(),
    reconnectNow: () => {
      reconnects += 1;
    },
    revertAgentSession: (agentSessionId) => {
      reverts.push(agentSessionId);
      return Promise.resolve(options.revertOutcome);
    },
    emitStatus: (next) => {
      status = next;
      statusChanges.next(next);
    },
    emitNotice: (notice) => notices.next(notice),
    reconnectCalls: () => reconnects,
    revertCalls: () => reverts.slice(),
    [Symbol.dispose]: () => {
      statusChanges.complete();
      notices.complete();
    },
  };
}
