// THE SHARED DECK AS THE EDITOR SEES IT (contracts/collaboration.ts): the connection, this person's
// role, the server's one-off notices, "Try now" and "Undo Claude's edit". The deck server enforces
// every permission (deck-access.ts); the reducer reads the same table only so the editor never
// queues what the server would refuse, and says why instead.
//
// Key decisions:
//
//  * REFUSED, WITH A REASON, ONCE. A viewer's keystroke or a commenter's drag queues nothing and
//    raises one notice naming what this person may do ("You can comment on this deck, but not edit
//    it"). A notice with the same message already showing is not repeated, so typing into a
//    read-only deck does not stack a notice per key.
//  * A CLOSED CONNECTION IS READ-ONLY for everyone, with the close reason as the message: the
//    server will not take the change, and the banner already says why.
//  * "TRY NOW" IS STATE. Feedbacks only see state, so `reconnectRequested` moves an offline
//    connection to `connecting` at once (the indicator answers the click) and the collaboration
//    feedback calls `reconnectNow` when it sees that move; the session reports its real status
//    right after. `reconnectNow` is a no-op unless the session is offline, so a `connecting` the
//    session reported itself costs nothing.
//  * AN AGENT REVERT IS A KEYED REQUEST in `pendingAgentReverts`; the feedback runs one revert per
//    agent session and reports `agentRevertSettled`, whose outcome becomes a notice.

import {
  assertNever,
  roleAllows,
  type AgentRevertOutcome,
  type CollaborationNotice,
  type CollaborationStatus,
  type DeckRole,
  type EditorState,
  type ProtectedFieldCorrection,
  type ResynchroniseReason,
  type TransitionScriptRecord,
} from "../../contracts/index.ts";
import { raiseNotice, refuse } from "./editor-queue.ts";

/** A new status from the session; a role change is announced, since controls appear or disappear. */
export function reduceCollaborationChanged(state: EditorState, status: CollaborationStatus): EditorState {
  const previousRole = state.collaboration.role;
  const changed: EditorState = { ...state, collaboration: status };
  if (status.role === previousRole) return changed;
  return raiseNotice(changed, { tone: "information", message: ROLE_GRANTED[status.role], action: null });
}

/** The server's one-off notices other than agent edits (which arrive as `agentEditObserved`). */
export function reduceCollaborationNotice(state: EditorState, notice: Exclude<CollaborationNotice, { kind: "agentEdit" }>): EditorState {
  switch (notice.kind) {
    case "correction":
      return raiseNotice(state, { tone: "warning", message: correctionMessage(notice.correction), action: null });
    case "rateLimited":
      return raiseNotice(state, {
        tone: "warning",
        message: `The server is receiving too many changes from this window; it takes them again in ${secondsText(notice.retryAfterMilliseconds)}.`,
        action: null,
      });
    case "resynchronising":
      return raiseNotice(state, { tone: "warning", message: RESYNCHRONISE_MESSAGE[notice.reason], action: null });
    default:
      return assertNever(notice);
  }
}

/** "Try now": an offline connection shows `connecting` at once and the feedback skips the wait. */
export function requestReconnect(state: EditorState): EditorState {
  const connection = state.collaboration.connection;
  switch (connection.kind) {
    case "offline":
      return { ...state, collaboration: { ...state.collaboration, connection: { kind: "connecting", attempt: connection.attempt + 1 } } };
    case "local":
    case "connecting":
    case "synchronising":
    case "online":
    case "closed":
      return state;
    default:
      return assertNever(connection);
  }
}

/** "Undo Claude's edit": queued for the collaboration feedback unless already running or not allowed. */
export function requestAgentRevert(state: EditorState, options: Readonly<{ agentSessionId: string; agentName: string }>): EditorState {
  if (!roleAllows({ role: state.collaboration.role, permission: "revertAgentEdits" })) return refuse(state, `You cannot undo ${options.agentName}'s edits on this deck.`);
  if (state.pendingAgentReverts.includes(options.agentSessionId)) return state;
  return { ...state, pendingAgentReverts: [...state.pendingAgentReverts, options.agentSessionId] };
}

export function reduceAgentRevertSettled(state: EditorState, options: Readonly<{ agentSessionId: string; outcome: AgentRevertOutcome }>): EditorState {
  const settled: EditorState = { ...state, pendingAgentReverts: state.pendingAgentReverts.filter((agentSessionId) => agentSessionId !== options.agentSessionId) };
  const outcome = options.outcome;
  switch (outcome.kind) {
    case "reverted":
      return raiseNotice(settled, {
        tone: "information",
        message: `Claude's edit was undone (${countText(outcome.stepsReverted, "step")})${outcome.skippedSteps === 0 ? "." : `; ${countText(outcome.skippedSteps, "step")} stayed because a collaborator changed ${outcome.skippedSteps === 1 ? "it" : "them"} since.`}`,
        action: null,
      });
    case "nothingToRevert":
      return raiseNotice(settled, {
        tone: "information",
        message: outcome.skippedSteps === 0 ? "There was nothing left of Claude's edit to undo." : "Nothing was undone: collaborators changed everything Claude's edit touched since.",
        action: null,
      });
    case "notPermitted":
      return raiseNotice(settled, { tone: "warning", message: "You cannot undo Claude's edits on this deck.", action: null });
    case "failed":
      return raiseNotice(settled, { tone: "warning", message: `Undoing Claude's edit failed: ${outcome.message}`, action: null });
    default:
      return assertNever(outcome);
  }
}

/**
 * Scripts that became an agent's unapproved text with this change: a new one, or one whose text
 * an agent rewrote. Each needs a person's review before it can run (SPEC.md section 11).
 */
export function newUnapprovedAgentScripts(options: Readonly<{ before: readonly TransitionScriptRecord[]; after: readonly TransitionScriptRecord[] }>): readonly TransitionScriptRecord[] {
  return options.after.filter((script) => {
    if (!awaitsReview(script)) return false;
    const previous = options.before.find((candidate) => candidate.id === script.id);
    return previous === undefined || !awaitsReview(previous) || previous.script !== script.script || previous.stylesheet !== script.stylesheet || previous.markup !== script.markup;
  });
}

/** One "Claude wrote a transition: review it" notice per new unapproved agent script. */
export function announceAgentScripts(state: EditorState, scripts: readonly TransitionScriptRecord[]): EditorState {
  return scripts.reduce(
    (current, script) =>
      raiseNotice(current, { tone: "information", message: `${agentNameOf(script)} wrote a transition: review it`, action: { kind: "reviewTransitionScript", scriptId: script.id } }),
    state,
  );
}

function agentNameOf(script: TransitionScriptRecord): string {
  switch (script.author.kind) {
    case "agent":
      return script.author.name;
    case "person":
      return "Someone";
    default:
      return assertNever(script.author);
  }
}

function awaitsReview(script: TransitionScriptRecord): boolean {
  if (script.approval.kind !== "unapproved") return false;
  switch (script.author.kind) {
    case "agent":
      return true;
    case "person":
      return false;
    default:
      return assertNever(script.author);
  }
}

const ROLE_GRANTED: Readonly<Record<DeckRole, string>> = {
  owner: "You own this deck now.",
  editor: "You can edit this deck now.",
  commenter: "You can comment on this deck now, but not edit it.",
  viewer: "You can view this deck now, but not edit or comment on it.",
};

const RESYNCHRONISE_MESSAGE: Readonly<Record<ResynchroniseReason, string>> = {
  updateFromReadOnlyRole: "This window held changes your role cannot make; the deck is being loaded again.",
  updateTooLarge: "A change was too large for the server; the deck is being loaded again.",
  updateMalformed: "The server could not read a change from this window; the deck is being loaded again.",
};

/** What the server's correction means to the person whose change it reverted. */
function correctionMessage(correction: ProtectedFieldCorrection): string {
  switch (correction.kind) {
    case "approvalRevoked":
      return `Your approval was removed: ${APPROVAL_REVOCATION_MESSAGE[correction.reason]}`;
    case "scriptAuthorRestored":
      return "A transition script records who changed it last, so its author was set back to you.";
    case "metaRestored":
      return "The deck's identity cannot change, so the server set it back.";
    default:
      return assertNever(correction);
  }
}

const APPROVAL_REVOCATION_MESSAGE: Readonly<Record<Extract<ProtectedFieldCorrection, { kind: "approvalRevoked" }>["reason"], string>> = {
  approvedByAnotherPerson: "an approval can only name the person who gives it.",
  fingerprintMismatch: "the script changed after it was approved; approve the new text.",
  notPermitted: "your role cannot approve transition scripts on this deck.",
};

function secondsText(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function countText(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}
