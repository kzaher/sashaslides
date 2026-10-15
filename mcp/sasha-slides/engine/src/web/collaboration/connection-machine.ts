// THE DECK CONNECTION'S LIFECYCLE AS A PURE REDUCER (SPEC.md 21.4): connecting, synchronising after
// the welcome, online after the server's sync step 2, offline with a full-jitter wait, refreshing
// the session after a 4001, and closed for good. The feedbacks in deck-collaboration.ts perform
// what each phase asks for -- open socket number N, wait D milliseconds, refresh the session -- and
// report back with events; this file decides, and does nothing.
//
// Key decisions:
//
//  * EVERY EFFECTFUL PHASE CARRIES A `generation`, minted from the state's counter when the phase
//    is entered. A feedback keyed on it starts when it appears and is cancelled when it leaves, and
//    an event from an old generation (a late close of the previous socket, a retry timer that lost
//    a race with "Try now") is ignored, so stale effects cannot steer the connection.
//  * RANDOMNESS AND TIME ARRIVE IN EVENTS (`jitter`, `at`), drawn by the feedback that saw the
//    cause, so this reducer is replayable and the backoff table is testable to the millisecond.
//  * `attempt` COUNTS CONSECUTIVE FAILURES and resets only when the connection reaches online; the
//    wait after failure number `attempt` is `reconnectDelayMilliseconds({ attempt, random })`.
//  * UNSENT CHANGES (SPEC.md 21.4 "Offline edits"): a local transaction while not online sets the
//    flag; it clears once the socket has sent the client's sync step 2 after a welcome and its
//    `bufferedAmount` is 0 (`outboundDrained`). While online a local update is sent at once, so the
//    flag is raised only when the send leaves a backlog (`outboundBacklogged`).

import {
  HEARTBEAT_INTERVAL_MILLISECONDS,
  type ClosedReason,
  type CollaborationStatus,
  type ConnectionState,
  type OfflineReason,
} from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DeckMember, DeckRole } from "../../contracts/deck-access.ts";
import type { Person } from "../../contracts/discussion.ts";
import { closeHandlingFor, reconnectDelayMilliseconds } from "./reconnect-policy.ts";

export type ConnectionPhase =
  /** Socket `generation` is opening, or open and waiting for the welcome. */
  | Readonly<{ kind: "connecting"; generation: number }>
  /** Welcome received on socket `generation`; waiting for the server's sync step 2. */
  | Readonly<{ kind: "synchronising"; generation: number }>
  | Readonly<{ kind: "online"; generation: number }>
  /** Waiting `retryInMilliseconds` (drawn with full jitter) before the next socket. */
  | Readonly<{ kind: "waiting"; generation: number; reason: OfflineReason; retryInMilliseconds: number }>
  /** The browser reports no network at all: no timer, the `online` event reconnects. */
  | Readonly<{ kind: "networkLost" }>
  /** After a 4001: asking the server for a fresh session before reconnecting. */
  | Readonly<{ kind: "refreshingSession"; generation: number }>
  | Readonly<{ kind: "closed"; reason: ClosedReason }>;

export type DeckConnectionState = Readonly<{
  phase: ConnectionPhase;
  /** Consecutive failures since the last time the connection was online. */
  attempt: number;
  /** The last generation minted (see the header). */
  generation: number;
  me: Person | null;
  role: DeckRole;
  members: readonly DeckMember[];
  unsentChanges: boolean;
  browserOnline: boolean;
  /** When the page was hidden (the event's own clock), null while it is visible. */
  hiddenSince: number | null;
  /** Text and binary frames that could not be parsed: ignored and counted (collaboration.ts). */
  malformedFrames: number;
  /** True once any socket reached online; the deck page shows the editor from then on. */
  everOnline: boolean;
  /** Where to sign in again after the session could not be refreshed. */
  signInAddress: string | null;
}>;

export type SessionRefreshFailure = Readonly<{ kind: "signedOut"; signInAddress: string }> | Readonly<{ kind: "unreachable" }>;

export type DeckConnectionEvent =
  | Readonly<{ kind: "welcomeReceived"; generation: number; me: Person; role: DeckRole; members: readonly DeckMember[] }>
  | Readonly<{ kind: "serverSynchronised"; generation: number }>
  | Readonly<{ kind: "socketClosed"; generation: number; code: number; jitter: number }>
  | Readonly<{ kind: "heartbeatMissed"; generation: number }>
  | Readonly<{ kind: "outboundBacklogged"; generation: number }>
  | Readonly<{ kind: "outboundDrained"; generation: number }>
  | Readonly<{ kind: "malformedFrameIgnored" }>
  | Readonly<{ kind: "retryDue"; generation: number }>
  /** "Try now", or the page asking to skip the wait. */
  | Readonly<{ kind: "reconnectRequested" }>
  | Readonly<{ kind: "networkChanged"; online: boolean }>
  | Readonly<{ kind: "visibilityChanged"; visible: boolean; at: number }>
  | Readonly<{ kind: "sessionRefreshed"; generation: number }>
  | Readonly<{ kind: "sessionRefreshFailed"; generation: number; failure: SessionRefreshFailure; jitter: number }>
  | Readonly<{ kind: "accessChanged"; role: DeckRole }>
  | Readonly<{ kind: "membersChanged"; members: readonly DeckMember[] }>
  | Readonly<{ kind: "localChangeMade" }>;

/** The first state: socket generation 1 opening at once. */
export function initialConnectionState(options: Readonly<{ role: DeckRole; browserOnline: boolean }>): DeckConnectionState {
  return {
    phase: options.browserOnline ? { kind: "connecting", generation: 1 } : { kind: "networkLost" },
    attempt: 0,
    generation: 1,
    me: null,
    role: options.role,
    members: [],
    unsentChanges: false,
    browserOnline: options.browserOnline,
    hiddenSince: null,
    malformedFrames: 0,
    everOnline: false,
    signInAddress: null,
  };
}

export function reduceConnection(state: DeckConnectionState, event: DeckConnectionEvent): DeckConnectionState {
  switch (event.kind) {
    case "welcomeReceived":
      if (socketGenerationOf(state.phase) !== event.generation) return state;
      return { ...state, phase: { kind: "synchronising", generation: event.generation }, me: event.me, role: event.role, members: event.members };
    case "serverSynchronised":
      if (synchronisingGenerationOf(state.phase) !== event.generation) return state;
      return { ...state, phase: { kind: "online", generation: event.generation }, attempt: 0, everOnline: true };
    case "socketClosed":
      if (socketGenerationOf(state.phase) !== event.generation) return state;
      return afterClose({ state, code: event.code, jitter: event.jitter });
    case "heartbeatMissed":
      if (socketGenerationOf(state.phase) !== event.generation) return state;
      return connectNow({ ...state, attempt: state.attempt + 1 });
    case "outboundBacklogged":
      return socketGenerationOf(state.phase) === event.generation ? { ...state, unsentChanges: true } : state;
    case "outboundDrained":
      return welcomedGenerationOf(state.phase) === event.generation ? { ...state, unsentChanges: false } : state;
    case "malformedFrameIgnored":
      return { ...state, malformedFrames: state.malformedFrames + 1 };
    case "retryDue":
      return retryTimerGenerationOf(state.phase) === event.generation ? connectNow(state) : state;
    case "reconnectRequested":
      return isWaitingToRetry(state.phase) ? connectNow(state) : state;
    case "networkChanged":
      return afterNetworkChange({ state, online: event.online });
    case "visibilityChanged":
      return afterVisibilityChange({ state, visible: event.visible, at: event.at });
    case "sessionRefreshed":
      return refreshGenerationOf(state.phase) === event.generation ? connectNow(state) : state;
    case "sessionRefreshFailed":
      if (refreshGenerationOf(state.phase) !== event.generation) return state;
      return afterRefreshFailure({ state, failure: event.failure, jitter: event.jitter });
    case "accessChanged":
      return { ...state, role: event.role };
    case "membersChanged":
      return { ...state, members: event.members };
    case "localChangeMade":
      return isOnline(state.phase) ? state : { ...state, unsentChanges: true };
    default:
      return assertNever(event);
  }
}

/** The connection as the editor shows it (collaboration.ts `CollaborationStatus`). */
export function collaborationStatusOf(state: DeckConnectionState): CollaborationStatus {
  return { connection: connectionStateOf(state), role: state.role, members: state.members, unsentChanges: state.unsentChanges };
}

/** The socket generation that should be open now, or null when no socket should exist. */
export function socketGenerationOf(phase: ConnectionPhase): number | null {
  switch (phase.kind) {
    case "connecting":
    case "synchronising":
    case "online":
      return phase.generation;
    case "waiting":
    case "networkLost":
    case "refreshingSession":
    case "closed":
      return null;
    default:
      return assertNever(phase);
  }
}

function connectionStateOf(state: DeckConnectionState): ConnectionState {
  const phase = state.phase;
  switch (phase.kind) {
    case "connecting":
    case "refreshingSession":
      return { kind: "connecting", attempt: state.attempt };
    case "synchronising":
      return { kind: "synchronising" };
    case "online":
      return { kind: "online" };
    case "waiting":
      return { kind: "offline", reason: phase.reason, attempt: state.attempt, retryInMilliseconds: phase.retryInMilliseconds };
    case "networkLost":
      return { kind: "offline", reason: "networkLost", attempt: state.attempt, retryInMilliseconds: null };
    case "closed":
      return { kind: "closed", reason: phase.reason };
    default:
      return assertNever(phase);
  }
}

/** The generation of a socket whose welcome has arrived (synchronising or online), else null. */
function welcomedGenerationOf(phase: ConnectionPhase): number | null {
  switch (phase.kind) {
    case "synchronising":
    case "online":
      return phase.generation;
    case "connecting":
    case "waiting":
    case "networkLost":
    case "refreshingSession":
    case "closed":
      return null;
    default:
      return assertNever(phase);
  }
}

function synchronisingGenerationOf(phase: ConnectionPhase): number | null {
  switch (phase.kind) {
    case "synchronising":
      return phase.generation;
    case "connecting":
    case "online":
    case "waiting":
    case "networkLost":
    case "refreshingSession":
    case "closed":
      return null;
    default:
      return assertNever(phase);
  }
}

/** The generation of a running retry timer, else null. */
function retryTimerGenerationOf(phase: ConnectionPhase): number | null {
  switch (phase.kind) {
    case "waiting":
      return phase.generation;
    case "connecting":
    case "synchronising":
    case "online":
    case "networkLost":
    case "refreshingSession":
    case "closed":
      return null;
    default:
      return assertNever(phase);
  }
}

function refreshGenerationOf(phase: ConnectionPhase): number | null {
  switch (phase.kind) {
    case "refreshingSession":
      return phase.generation;
    case "connecting":
    case "synchronising":
    case "online":
    case "waiting":
    case "networkLost":
    case "closed":
      return null;
    default:
      return assertNever(phase);
  }
}

function isOnline(phase: ConnectionPhase): boolean {
  switch (phase.kind) {
    case "online":
      return true;
    case "connecting":
    case "synchronising":
    case "waiting":
    case "networkLost":
    case "refreshingSession":
    case "closed":
      return false;
    default:
      return assertNever(phase);
  }
}

function isWaitingToRetry(phase: ConnectionPhase): boolean {
  switch (phase.kind) {
    case "waiting":
    case "networkLost":
      return true;
    case "connecting":
    case "synchronising":
    case "online":
    case "refreshingSession":
    case "closed":
      return false;
    default:
      return assertNever(phase);
  }
}

/** A new socket generation, opening now. */
function connectNow(state: DeckConnectionState): DeckConnectionState {
  const generation = state.generation + 1;
  return { ...state, generation, phase: { kind: "connecting", generation } };
}

function afterClose(options: Readonly<{ state: DeckConnectionState; code: number; jitter: number }>): DeckConnectionState {
  const handling = closeHandlingFor(options.code);
  switch (handling.kind) {
    case "refreshSessionThenReconnect": {
      const generation = options.state.generation + 1;
      return { ...options.state, generation, phase: { kind: "refreshingSession", generation } };
    }
    case "reconnectWithBackoff":
      return waitBeforeRetry({ state: options.state, reason: handling.offlineReason, jitter: options.jitter });
    case "stop":
      return { ...options.state, phase: { kind: "closed", reason: handling.closedReason } };
    default:
      return assertNever(handling);
  }
}

/** Full-jitter wait after failure number `attempt`, or no timer at all while the network is gone. */
function waitBeforeRetry(options: Readonly<{ state: DeckConnectionState; reason: OfflineReason; jitter: number }>): DeckConnectionState {
  const state = options.state;
  if (!state.browserOnline) return { ...state, phase: { kind: "networkLost" }, attempt: state.attempt + 1 };
  const generation = state.generation + 1;
  const retryInMilliseconds = reconnectDelayMilliseconds({ attempt: state.attempt, random: options.jitter });
  return { ...state, generation, attempt: state.attempt + 1, phase: { kind: "waiting", generation, reason: options.reason, retryInMilliseconds } };
}

function afterRefreshFailure(options: Readonly<{ state: DeckConnectionState; failure: SessionRefreshFailure; jitter: number }>): DeckConnectionState {
  const failure = options.failure;
  switch (failure.kind) {
    case "signedOut":
      return { ...options.state, phase: { kind: "closed", reason: "signedOut" }, signInAddress: failure.signInAddress };
    case "unreachable":
      return waitBeforeRetry({ state: options.state, reason: "serverUnreachable", jitter: options.jitter });
    default:
      return assertNever(failure);
  }
}

function afterNetworkChange(options: Readonly<{ state: DeckConnectionState; online: boolean }>): DeckConnectionState {
  const state = { ...options.state, browserOnline: options.online };
  if (options.online) return isWaitingToRetry(state.phase) ? connectNow(state) : state;
  // No network: a running retry timer is pointless, the `online` event reconnects instead.
  return retryTimerGenerationOf(state.phase) === null ? state : { ...state, phase: { kind: "networkLost" } };
}

/** Visible again after being hidden past a heartbeat: a waiting connection retries at once. */
function afterVisibilityChange(options: Readonly<{ state: DeckConnectionState; visible: boolean; at: number }>): DeckConnectionState {
  const state = options.state;
  if (!options.visible) return state.hiddenSince === null ? { ...state, hiddenSince: options.at } : state;
  const hiddenFor = state.hiddenSince === null ? 0 : options.at - state.hiddenSince;
  const shown = { ...state, hiddenSince: null };
  return hiddenFor >= HEARTBEAT_INTERVAL_MILLISECONDS && retryTimerGenerationOf(shown.phase) !== null ? connectNow(shown) : shown;
}
