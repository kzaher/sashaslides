// ONE OPEN DECK'S COLLABORATION CLIENT (SPEC.md 21.4, 21.8): the connection as an RxFeedback
// system (connection-machine.ts decides, the feedbacks below act), y-protocols document sync over
// the socket, presence over awareness, the discussion log, and the `CollaborationSession` the
// editor reads its status and notices from. The page composes one of these per replica; a
// `resynchroniseRequired` makes the page dispose it and compose a fresh one (deck-workspace.ts).
//
// Key decisions:
//
//  * THE SOCKET IS AN EFFECT OF STATE. A `react` feedback keyed on the socket generation opens
//    socket N when a phase asks for it and closes it when the phase moves on, so a reconnect is
//    "the generation changed" and nothing ever holds a stale socket. Everything a live socket does
//    -- the sync handshake, forwarding local updates, the 40 second silence timer, watching
//    `bufferedAmount` drain -- lives inside that one effect and is torn down with it.
//  * REMOTE UPDATES ARE APPLIED UNDER `REMOTE_SYNC_ORIGIN` (yjs-schema.ts), which is how the
//    document store reports them as `{ kind: "remote" }` and how the update listener here knows
//    not to send them back.
//  * NOTHING IS SENT BEFORE THE WELCOME. Until then the role is unknown; local edits made meanwhile
//    stay in the replica and leave in the client's sync step 2 (SPEC.md 21.4 "Offline edits").
//  * EVERY TIMER RUNS ON THE INJECTED SCHEDULER and every random draw on the injected source, so
//    the backoff table and the silence timeout are tested to the millisecond.

import { defer, distinctUntilChanged, from, map, merge, Observable, skip, Subject, timer, type SchedulerAction, type SchedulerLike, type Subscription } from "rxjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type { Doc } from "yjs";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  BINARY_MESSAGE_TYPE,
  CONNECTION_DEAD_AFTER_MILLISECONDS,
  DECK_SYNC_SUBPROTOCOL,
  type AgentRevertOutcome,
  type CollaborationNotice,
  type CollaborationSession,
  type CollaborationStatus,
  type ConnectionState,
  type ResynchroniseReason,
  type ServerMessage,
} from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { syncStepOneFrame, syncUpdateFrame } from "../../shared/sync-frames.ts";
import type { DeckRole } from "../../contracts/deck-access.ts";
import type { DiscussionStore, ReduceDiscussionLog } from "../../contracts/discussion.ts";
import type { DeckId, RandomSource } from "../../contracts/ids.ts";
import type { PresenceChannel } from "../../contracts/presence.ts";
import type { Feedback, RunningSystem } from "../../contracts/rxfeedback.ts";
import { REMOTE_SYNC_ORIGIN } from "../../contracts/yjs-schema.ts";
import { closedReasonOf } from "../../shared/access-refusals.ts";
import { createSystem, react } from "../../state/index.ts";
import { createAwarenessPresence, type AwarenessParticipant } from "./awareness-presence.ts";
import {
  collaborationStatusOf,
  initialConnectionState,
  reduceConnection,
  refreshGenerationOf,
  socketGenerationOf,
  type DeckConnectionEvent,
  type DeckConnectionState,
  type SessionRefreshFailure,
} from "./connection-machine.ts";
import { NORMAL_CLOSE_CODE, type DeckSocket, type OpenDeckSocket } from "./deck-socket.ts";
import { parseServerMessage } from "./server-message.ts";
import { createSocketDiscussionStore, type DiscussionParticipant } from "./socket-discussion-store.ts";

export type SessionRefreshOutcome = Readonly<{ kind: "refreshed" }> | SessionRefreshFailure;

export type DeckCollaborationDependencies = Readonly<{
  deckId: DeckId;
  sharedDocument: Doc;
  /** The role to assume until the welcome says (the deck details' role, or viewer). */
  expectedRole: DeckRole;
  openSocket: OpenDeckSocket;
  /** `wss://<origin>/deck-api/sync/<deckId>?discussionAfter=<sequence>`. */
  syncAddress: (discussionAfter: number) => string;
  /** The embedded editor's bearer token, sent as the second subprotocol; null with the cookie. */
  bearerToken: () => string | null;
  /** After a 4001: GET /deck-api/session (cookie) or POST /deck-api/embed/renew (bearer). */
  refreshSession: () => Promise<SessionRefreshOutcome>;
  revertAgentSession: (agentSessionId: string) => Promise<AgentRevertOutcome>;
  reduceDiscussionLog: ReduceDiscussionLog;
  /** `navigator.onLine` now and on every `online` / `offline` event. */
  browserOnline: Observable<boolean>;
  initiallyOnline: boolean;
  /** `document.visibilityState === "visible"` on every change. */
  pageVisible: Observable<boolean>;
  scheduler: SchedulerLike;
  random: RandomSource;
  now: () => number;
  /** Delivered to the first subscriber of `notices` (the 'resynchronising' notice after a reload). */
  initialNotices: readonly CollaborationNotice[];
  reportError: (error: unknown, context: string) => void;
}>;

export type DeckCollaboration = Disposable &
  Readonly<{
    session: CollaborationSession;
    discussionStore: DiscussionStore;
    presence: PresenceChannel;
    /** The whole connection state: the page waits for `everOnline`, reads `signInAddress`. */
    connection: RunningSystem<DeckConnectionState, DeckConnectionEvent>;
    /** One value per `resynchroniseRequired` frame; the page then recomposes (deck-workspace.ts). */
    resynchroniseRequired: Observable<ResynchroniseReason>;
  }>;

export function createDeckCollaboration(dependencies: DeckCollaborationDependencies): DeckCollaboration {
  const notices = new Subject<CollaborationNotice>();
  const resynchronise = new Subject<ResynchroniseReason>();
  const awareness = createAwarenessPresence({ sharedDocument: dependencies.sharedDocument, now: dependencies.now });
  const discussion = createSocketDiscussionStore({ reduceDiscussionLog: dependencies.reduceDiscussionLog });
  const participants: SocketParticipants = { awareness: awareness.participant, discussion: discussion.participant, notices, resynchronise };

  const connection = createSystem<DeckConnectionState, DeckConnectionEvent>({
    initial: initialConnectionState({ role: dependencies.expectedRole, browserOnline: dependencies.initiallyOnline }),
    reduce: reduceConnection,
    feedbacks: [
      socketFeedback({ dependencies, participants }),
      retryFeedback(dependencies.scheduler),
      sessionRefreshFeedback(dependencies),
      browserFeedback(dependencies),
      localChangesFeedback(dependencies.sharedDocument),
    ],
    onReducerError: (error, event) => dependencies.reportError(error, `deck connection: reducing ${event.kind}`),
    onFeedbackError: (error, feedbackIndex) => dependencies.reportError(error, `deck connection: feedback ${feedbackIndex} stopped`),
    eventLogCapacity: 200,
    now: dependencies.now,
  });

  // A connection closed for good refuses the discussion requests still waiting (DiscussionStore
  // "never throws: transport failures resolve as rejected").
  const stopWatch = connection.state$.subscribe((state) => {
    const closedReason = closedReasonOf(collaborationStatusOf(state));
    if (closedReason !== null) discussion.participant.stopped(`The connection to this deck closed (${closedReason}).`);
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopWatch.unsubscribe();
    connection[Symbol.dispose]();
    discussion.store[Symbol.dispose]();
    awareness[Symbol.dispose]();
    notices.complete();
    resynchronise.complete();
  };

  const pendingNotices = [...dependencies.initialNotices];
  const session: CollaborationSession = {
    status: () => collaborationStatusOf(connection.currentState()),
    statusChanges: connection.state$.pipe(map(collaborationStatusOf), distinctUntilChanged(sameStatus), skip(1)),
    notices: merge(
      defer(() => from(pendingNotices.splice(0))),
      notices,
    ),
    reconnectNow: () => connection.dispatch({ kind: "reconnectRequested" }),
    revertAgentSession: (agentSessionId) =>
      dependencies.revertAgentSession(agentSessionId).catch((error: unknown): AgentRevertOutcome => ({ kind: "failed", message: error instanceof Error ? error.message : String(error) })),
    // The page owns the collaboration; an editor disposing its session ends it all the same.
    [Symbol.dispose]: dispose,
  };

  return {
    session,
    discussionStore: discussion.store,
    presence: awareness.channel,
    connection,
    resynchroniseRequired: resynchronise.asObservable(),
    [Symbol.dispose]: dispose,
  };
}

/** The status the editor shows changed: a deep comparison of the small `connection` value. */
export function sameStatus(previous: CollaborationStatus, next: CollaborationStatus): boolean {
  return (
    previous.role === next.role &&
    previous.members === next.members &&
    previous.unsentChanges === next.unsentChanges &&
    connectionKey(previous.connection) === connectionKey(next.connection)
  );
}

type SocketParticipants = Readonly<{
  awareness: AwarenessParticipant;
  discussion: DiscussionParticipant;
  notices: Subject<CollaborationNotice>;
  resynchronise: Subject<ResynchroniseReason>;
}>;

function connectionKey(connection: ConnectionState): string {
  switch (connection.kind) {
    case "local":
    case "synchronising":
    case "online":
      return connection.kind;
    case "connecting":
      return `connecting ${connection.attempt}`;
    case "offline":
      return `offline ${connection.reason} ${connection.attempt} ${String(connection.retryInMilliseconds)}`;
    case "closed":
      return `closed ${connection.reason}`;
    default:
      return assertNever(connection);
  }
}

// --- the socket ---------------------------------------------------------------------------------

function socketFeedback(options: Readonly<{ dependencies: DeckCollaborationDependencies; participants: SocketParticipants }>): Feedback<DeckConnectionState, DeckConnectionEvent> {
  return react<DeckConnectionState, number, DeckConnectionEvent>({
    query: (state) => socketGenerationOf(state.phase),
    areEqual: (previous, next) => previous === next,
    effects: (generation) => liveSocket({ ...options, generation }),
  });
}

/** Socket number `generation`, from opening to teardown (see the header). */
function liveSocket(options: Readonly<{ dependencies: DeckCollaborationDependencies; participants: SocketParticipants; generation: number }>): Observable<DeckConnectionEvent> {
  const { dependencies, participants, generation } = options;
  const document = dependencies.sharedDocument;
  return new Observable<DeckConnectionEvent>((subscriber) => {
    const emit = (event: DeckConnectionEvent): void => subscriber.next(event);
    let closed = false;
    let welcomed = false;
    let stepTwoSent = false;
    let silence: Subscription | null = null;
    let drainCheck: Subscription | null = null;

    const armSilence = (): void => {
      silence?.unsubscribe();
      silence = dependencies.scheduler.schedule(() => emit({ kind: "heartbeatMissed", generation }), CONNECTION_DEAD_AFTER_MILLISECONDS);
    };

    const bearer = dependencies.bearerToken();
    const socket: DeckSocket = dependencies.openSocket({
      address: dependencies.syncAddress(participants.discussion.knownSequence()),
      protocols: bearer === null ? [DECK_SYNC_SUBPROTOCOL] : [DECK_SYNC_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${bearer}`],
      listener: {
        opened: () => armSilence(),
        received: (frame) => {
          if (closed) return;
          armSilence();
          if (typeof frame === "string") receiveText(frame);
          else receiveBinary(frame);
        },
        closed: (code) => {
          if (closed) return;
          closed = true;
          emit({ kind: "socketClosed", generation, code, jitter: dependencies.random() });
        },
      },
    });
    const send = (frame: string | Uint8Array): void => {
      if (!closed) socket.send(frame);
    };

    // `bufferedAmount` is polled, never assumed: the browser offers no event for "drained".
    const scheduleDrainCheck = (): void => {
      if (!stepTwoSent || drainCheck !== null) return;
      drainCheck = dependencies.scheduler.schedule(function check(this: SchedulerAction<undefined>) {
        if (closed) return;
        if (socket.bufferedAmount() > 0) {
          this.schedule(undefined, DRAIN_POLL_MILLISECONDS);
          return;
        }
        drainCheck = null;
        emit({ kind: "outboundDrained", generation });
      }, 0);
    };

    const onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE_SYNC_ORIGIN || closed) return;
      send(syncUpdateFrame(update));
      if (socket.bufferedAmount() > 0) emit({ kind: "outboundBacklogged", generation });
      scheduleDrainCheck();
    };

    const welcome = (message: Extract<ServerMessage, { kind: "welcome" }>): void => {
      if (welcomed) return;
      welcomed = true;
      emit({ kind: "welcomeReceived", generation, me: message.me, role: message.role, members: message.members });
      send(syncStepOneFrame(document));
      document.on("update", onLocalUpdate);
      participants.awareness.connected(send);
      participants.discussion.connected(send);
    };

    const receiveText = (text: string): void => {
      const message = parseServerMessage(text);
      if (message === null) {
        emit({ kind: "malformedFrameIgnored" });
        return;
      }
      switch (message.kind) {
        case "welcome":
          welcome(message);
          return;
        case "discussionEntries":
          participants.discussion.received(message.entries);
          return;
        case "discussionOutcome":
          participants.discussion.settled(message.outcome);
          return;
        case "accessChanged":
          emit({ kind: "accessChanged", role: message.role });
          return;
        case "membersChanged":
          emit({ kind: "membersChanged", members: message.members });
          return;
        case "agentEdit":
          participants.notices.next({ kind: "agentEdit", agentSessionId: message.agentSessionId, agentName: message.agentName, summary: message.summary });
          return;
        case "correction":
          participants.notices.next({ kind: "correction", correction: message.correction });
          return;
        case "rateLimited":
          participants.notices.next({ kind: "rateLimited", retryAfterMilliseconds: message.retryAfterMilliseconds });
          return;
        case "heartbeat":
          return;
        case "resynchroniseRequired":
          participants.resynchronise.next(message.reason);
          return;
        default:
          assertNever(message);
      }
    };

    const receiveBinary = (frame: Uint8Array): void => {
      try {
        const decoder = decoding.createDecoder(frame);
        const messageType = decoding.readVarUint(decoder);
        if (messageType === BINARY_MESSAGE_TYPE.awareness) {
          participants.awareness.received(decoding.readVarUint8Array(decoder));
          return;
        }
        if (messageType !== BINARY_MESSAGE_TYPE.sync) {
          emit({ kind: "malformedFrameIgnored" });
          return;
        }
        receiveSync(decoder);
      } catch (error) {
        dependencies.reportError(error, "deck connection: a binary frame could not be read");
        emit({ kind: "malformedFrameIgnored" });
      }
    };

    const receiveSync = (decoder: decoding.Decoder): void => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, document, REMOTE_SYNC_ORIGIN, (error: Error) =>
        dependencies.reportError(error, "deck connection: a remote update could not be applied"),
      );
      if (encoding.length(encoder) > 1) {
        // The answer to the server's step 1: our step 2, carrying every local change it lacks.
        send(encoding.toUint8Array(encoder));
        stepTwoSent = true;
        scheduleDrainCheck();
      }
      if (syncType === syncProtocol.messageYjsSyncStep2 && welcomed) emit({ kind: "serverSynchronised", generation });
    };

    armSilence();
    return () => {
      silence?.unsubscribe();
      drainCheck?.unsubscribe();
      document.off("update", onLocalUpdate);
      if (welcomed) {
        participants.awareness.disconnected();
        participants.discussion.disconnected();
      }
      if (closed) return;
      closed = true;
      socket.close(NORMAL_CLOSE_CODE);
    };
  });
}

const DRAIN_POLL_MILLISECONDS = 100;

// --- the other effects ------------------------------------------------------------------------

/** The full-jitter wait of a `waiting` phase, keyed on its generation. */
function retryFeedback(scheduler: SchedulerLike): Feedback<DeckConnectionState, DeckConnectionEvent> {
  return react<DeckConnectionState, Readonly<{ generation: number; delay: number }>, DeckConnectionEvent>({
    query: (state) => retryRequestOf(state),
    areEqual: (previous, next) => previous.generation === next.generation,
    effects: (request) => timer(request.delay, scheduler).pipe(map((): DeckConnectionEvent => ({ kind: "retryDue", generation: request.generation }))),
  });
}

function retryRequestOf(state: DeckConnectionState): Readonly<{ generation: number; delay: number }> | null {
  const phase = state.phase;
  switch (phase.kind) {
    case "waiting":
      return { generation: phase.generation, delay: phase.retryInMilliseconds };
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

/** After a 4001: ask for a fresh session, then reconnect (reconnect-policy.ts `CLOSE_HANDLING`). */
function sessionRefreshFeedback(dependencies: DeckCollaborationDependencies): Feedback<DeckConnectionState, DeckConnectionEvent> {
  return react<DeckConnectionState, number, DeckConnectionEvent>({
    query: (state) => refreshGenerationOf(state.phase),
    areEqual: (previous, next) => previous === next,
    effects: (generation) =>
      from(
        dependencies.refreshSession().then(
          (outcome): DeckConnectionEvent => refreshEvent({ generation, outcome, jitter: dependencies.random() }),
          (): DeckConnectionEvent => ({ kind: "sessionRefreshFailed", generation, failure: { kind: "unreachable" }, jitter: dependencies.random() }),
        ),
      ),
  });
}

function refreshEvent(options: Readonly<{ generation: number; outcome: SessionRefreshOutcome; jitter: number }>): DeckConnectionEvent {
  const outcome = options.outcome;
  switch (outcome.kind) {
    case "refreshed":
      return { kind: "sessionRefreshed", generation: options.generation };
    case "signedOut":
    case "unreachable":
      return { kind: "sessionRefreshFailed", generation: options.generation, failure: outcome, jitter: options.jitter };
    default:
      return assertNever(outcome);
  }
}

/** The browser's `online` / `offline` events and the page's visibility, stamped with the scheduler's clock. */
function browserFeedback(dependencies: DeckCollaborationDependencies): Feedback<DeckConnectionState, DeckConnectionEvent> {
  return () =>
    merge(
      dependencies.browserOnline.pipe(map((online): DeckConnectionEvent => ({ kind: "networkChanged", online }))),
      dependencies.pageVisible.pipe(map((visible): DeckConnectionEvent => ({ kind: "visibilityChanged", visible, at: dependencies.scheduler.now() }))),
    );
}

/** Every local transaction, whatever the phase: what `unsentChanges` is raised from. */
function localChangesFeedback(document: Doc): Feedback<DeckConnectionState, DeckConnectionEvent> {
  return () =>
    new Observable<DeckConnectionEvent>((subscriber) => {
      const onUpdate = (_update: Uint8Array, origin: unknown): void => {
        if (origin !== REMOTE_SYNC_ORIGIN) subscriber.next({ kind: "localChangeMade" });
      };
      document.on("update", onUpdate);
      return () => document.off("update", onUpdate);
    });
}
