// CAN SASHA ANSWER COMMENTS ON THIS DECK? The sidebar's small "Let Sasha answer comments" card,
// as one state value, a pure reducer, and the predicates the controller's loop asks.
//
// WHY. Comments are answered with each user's OWN Google grant, which under `drive.file` reaches a
// deck only after the user chose it once in the Google Picker (comment-bot/comment-access-page.ts).
// Before this card, the user learned that only when they asked their assistant to watch the deck
// and it handed back a link. The sidebar already knows the deck, so it asks the connector up front
// (Code.gs `sashaCommentAccess`, POST /comments/access) and offers the one-click Allow.
//
// WHEN IT IS ASKED, and why that costs no time: ONCE PER OPEN, in the same pump as the sidebar's
// other boot reads (sidebar-controller.ts), never in series after one of them; and ONCE MORE when
// the user comes back to the deck after pressing Allow. Never on the poll. The last answer is kept
// in the sidebar seed (sidebar-seed.ts), so the next open draws the right card at once.
//
// A FAILED CHECK SHOWS NOTHING NEW: the card is a convenience, and a transient connector or Drive
// failure must not nag. The last known answer (fresh or seeded) stays on screen.

import { assertNever } from "./protocol.ts";
import type { CommentAccessAnswer } from "../../comment-bot/comment-access-contract.ts";

export type { CommentAccessAnswer } from "../../comment-bot/comment-access-contract.ts";

/** Whether a check is wanted, out, or done. `wanted` is the start: every open asks once. */
export type CommentAccessCheckPhase = "wanted" | "inFlight" | "idle";

export type CommentAccessState = Readonly<{
  /** The last answer, or null before any. */
  answer: CommentAccessAnswer | null;
  /** True while `answer` is still the seed's (the previous open's) and no fresh check has answered. */
  seeded: boolean;
  check: CommentAccessCheckPhase;
  /** The user pressed Allow and has not come back yet: their return re-checks once. */
  awaitingReturn: boolean;
}>;

export type CommentAccessEvent =
  | Readonly<{ kind: "access-seeded"; answer: CommentAccessAnswer }>
  | Readonly<{ kind: "access-check-requested" }>
  | Readonly<{ kind: "access-check-arrived"; answer: CommentAccessAnswer }>
  | Readonly<{ kind: "access-check-failed"; message: string }>
  /** The Allow link was opened (in a new tab). */
  | Readonly<{ kind: "access-allow-opened" }>
  /** The sidebar became visible again or got focus: the user may be back from the allow page. */
  | Readonly<{ kind: "access-returned" }>;

/** What the card shows, or null for no card at all. */
export type CommentAccessCard =
  | Readonly<{ kind: "allow"; allowUrl: string; checking: boolean }>
  | Readonly<{ kind: "notConnected" }>
  | Readonly<{ kind: "viewOnly" }>;

export const INITIAL_COMMENT_ACCESS: CommentAccessState = { answer: null, seeded: false, check: "wanted", awaitingReturn: false };

export function reduceCommentAccess(state: CommentAccessState, event: CommentAccessEvent): CommentAccessState {
  switch (event.kind) {
    case "access-seeded":
      // Only before anything fresher: a seed never overwrites a real answer.
      return state.answer === null ? { ...state, answer: event.answer, seeded: true } : state;
    case "access-check-requested":
      return state.check === "inFlight" ? state : { ...state, check: "inFlight" };
    case "access-check-arrived":
      return { ...state, answer: event.answer, seeded: false, check: "idle" };
    case "access-check-failed":
      return { ...state, check: "idle" };
    case "access-allow-opened":
      return state.awaitingReturn ? state : { ...state, awaitingReturn: true };
    case "access-returned":
      // ONE re-check per Allow press, and none while one is already out (it will answer).
      if (!state.awaitingReturn || state.check === "inFlight") return state;
      return { ...state, awaitingReturn: false, check: "wanted" };
    default:
      return assertNever(event);
  }
}

/** The controller's gate: true exactly when a check should go out now. */
export function needsCommentAccessCheck(state: CommentAccessState): boolean {
  switch (state.check) {
    case "wanted":
      return true;
    case "inFlight":
    case "idle":
      return false;
    default:
      return assertNever(state.check);
  }
}

/** The card for the last known answer; null when Sasha can already answer, or nothing is known yet. */
export function commentAccessCardOf(state: CommentAccessState): CommentAccessCard | null {
  const answer = state.answer;
  if (answer === null) return null;
  switch (answer.access) {
    case "ready":
      return null;
    case "needsAllow":
      // "Checking" only for the re-check after Allow: the boot's check behind a seeded card is
      // the routine refresh, and saying so on every open would read as something going on.
      return { kind: "allow", allowUrl: answer.allowUrl, checking: state.check === "inFlight" && !state.seeded };
    case "notConnected":
      return { kind: "notConnected" };
    case "viewOnly":
      return { kind: "viewOnly" };
    default:
      return assertNever(answer);
  }
}
