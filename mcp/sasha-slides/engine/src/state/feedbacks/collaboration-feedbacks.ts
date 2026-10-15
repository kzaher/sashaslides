// THE DECK SERVER SESSION'S EFFECTS (contracts/collaboration.ts `CollaborationSession`), one
// feedback per direction:
//
//  * STATUS AND NOTICES IN: every new status becomes `collaborationChanged`; a server notice becomes
//    `agentEditObserved` (an agent's edit, offering "Undo Claude's edit") or
//    `collaborationNoticeReceived` (a correction, a rate limit, a reload).
//  * "TRY NOW" OUT: the reducer answers `reconnectRequested` by moving an offline connection to
//    `connecting` (collaboration.ts); seeing exactly that move, this feedback calls `reconnectNow`.
//    The session's own offline-to-connecting moves call it too, which the contract makes a no-op.
//  * AGENT REVERTS OUT: one `revertAgentSession` per agent session in `pendingAgentReverts`, keyed
//    by that id, settling with `agentRevertSettled`. `revertAgentSession` never throws by contract;
//    a broken promise still settles as `failed`, so the request never hangs in the list.
//
// A local deck (the demo, most tests) has no session: nothing flows in, "Try now" never shows, and
// a revert settles at once as failed with a reason.

import { defer, from, merge, of } from "rxjs";
import { catchError, filter, ignoreElements, map, pairwise, tap } from "rxjs/operators";
import {
  assertNever,
  type AgentRevertOutcome,
  type CollaborationNotice,
  type CollaborationSession,
  type ConnectionState,
  type EditorEvent,
  type EditorState,
  type Feedback,
} from "../../contracts/index.ts";
import { reactSet } from "../rxfeedback/react-feedbacks.ts";
import { messageOf } from "./document-feedbacks.ts";

type ReportError = (error: unknown, context: string) => void;

export const NO_SESSION_REVERT: AgentRevertOutcome = { kind: "failed", message: "this deck is not shared, so there is no server to undo the edit on" };

export function collaborationFeedback(dependencies: Readonly<{ collaboration: CollaborationSession | null; reportError: ReportError }>): Feedback<EditorState, EditorEvent> {
  const session = dependencies.collaboration;
  const reverts = agentRevertsFeedback(dependencies);
  if (session === null) return reverts;
  return (state$) =>
    merge(
      session.statusChanges.pipe(map((status): EditorEvent => ({ kind: "collaborationChanged", status }))),
      session.notices.pipe(map(noticeEvent)),
      state$.pipe(
        map((state) => state.collaboration.connection),
        pairwise(),
        filter((pair) => isRetryNow({ before: pair[0], after: pair[1] })),
        tap(() => {
          try {
            session.reconnectNow();
          } catch (error: unknown) {
            dependencies.reportError(error, "reconnecting to the deck server");
          }
        }),
        ignoreElements(),
      ),
      reverts(state$),
    );
}

function agentRevertsFeedback(dependencies: Readonly<{ collaboration: CollaborationSession | null; reportError: ReportError }>): Feedback<EditorState, EditorEvent> {
  return reactSet<EditorState, string, EditorEvent>({
    query: (state) => new Map(state.pendingAgentReverts.map((agentSessionId) => [agentSessionId, agentSessionId])),
    effects: (agentSessionId) => {
      const session = dependencies.collaboration;
      const settled = (outcome: AgentRevertOutcome): EditorEvent => ({ kind: "agentRevertSettled", agentSessionId, outcome });
      if (session === null) return of(settled(NO_SESSION_REVERT));
      return defer(() => from(session.revertAgentSession(agentSessionId))).pipe(
        map(settled),
        catchError((error: unknown) => {
          dependencies.reportError(error, `undoing agent session ${agentSessionId}`);
          return of(settled({ kind: "failed", message: messageOf(error) }));
        }),
      );
    },
  });
}

function noticeEvent(notice: CollaborationNotice): EditorEvent {
  switch (notice.kind) {
    case "agentEdit":
      return { kind: "agentEditObserved", agentSessionId: notice.agentSessionId, agentName: notice.agentName, summary: notice.summary };
    case "correction":
    case "rateLimited":
    case "resynchronising":
      return { kind: "collaborationNoticeReceived", notice };
    default:
      return assertNever(notice);
  }
}

/** Offline, then connecting: what the reducer's "Try now" produces (see the header). */
function isRetryNow(pair: Readonly<{ before: ConnectionState; after: ConnectionState }>): boolean {
  return CONNECTION_PHASE[pair.before.kind] === "waitingToRetry" && CONNECTION_PHASE[pair.after.kind] === "connecting";
}

const CONNECTION_PHASE: Readonly<Record<ConnectionState["kind"], "waitingToRetry" | "connecting" | "other">> = {
  local: "other",
  connecting: "connecting",
  synchronising: "other",
  online: "other",
  offline: "waitingToRetry",
  closed: "other",
};
