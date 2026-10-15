// COLLABORATION OVER ONE WEBSOCKET PER OPEN DECK (milestone 2): the wire protocol between the
// browser (the web application, module "web") and the deck server inside the connector (module
// "collaboration server"), and the status the editor shows. SPEC.md "Milestone 2" has the
// sequence diagrams, storage and limits; this file is the source of truth for every message.
//
// Key decisions:
//
//  * TWO FRAME TYPES, NO CUSTOM BINARY ENVELOPE. Binary frames are EXACTLY y-websocket's framing
//    (`varUint(messageType)` then the y-protocols payload: 0 = sync, 1 = awareness), so the
//    battle-tested y-protocols encoders and decoders are used on both ends unchanged. Everything
//    that is not Yjs -- the welcome, the discussion log, access changes, corrections, heartbeats --
//    is a JSON TEXT frame (`ClientMessage` / `ServerMessage`), parsed at the boundary by whoever
//    receives it. The two never mix: a binary frame is never JSON and a text frame is never Yjs.
//
//  * THE SERVER IS THE AUTHORITY FOR WHAT A CLIENT CANNOT BE TRUSTED WITH, AND IT CORRECTS RATHER
//    THAN REJECTS. A Yjs update cannot be partially accepted, and refusing one leaves the sender's
//    replica permanently ahead of everyone else's (every later update depends on it). So the server
//    applies an editor's update in its own transaction, inspects what the transaction changed in
//    the protected fields (`PROTECTED_DOCUMENT_FIELDS`), and when a rule is broken writes the
//    correction in a follow-up transaction and broadcasts the update MERGED with its correction
//    (`Y.mergeUpdates`), so no other replica ever holds the forbidden state, and the offender is
//    told why (`correction`). The rules:
//      - a transition script's `approval` may become `approved` only when the update came from a
//        PERSON whose role may approve, `approvedBy` is that person, and `fingerprint` equals the
//        script's fingerprint after the update; anything else is corrected to `unapproved`;
//      - a script whose text changed records the sender as its `author` (a person cannot sign a
//        script as Claude or as a colleague), and a changed text voids any approval that names
//        another fingerprint (it already cannot run, the presenter checks the fingerprint; the
//        server makes the stored value say so);
//      - `meta.deckId`, `meta.schemaVersion` and `meta.createdAt` never change after creation.
//    Agent edits never travel this path: they are applied by the server's own replica
//    (`deck_apply`), whose model already refuses an agent approval (`approvalNeedsPerson`).
//
//  * DISCUSSION AUTHORSHIP AND TIMES ARE THE SERVER'S. A client sends only a `DiscussionRequest`;
//    the server stamps `actor` (the session's person) and `at` (its clock), checks the role and the
//    authorship rules (discussion.ts), and appends. There is no field a client could forge.
//
//  * VIEWERS AND COMMENTERS NEVER WRITE THE DOCUMENT. Their sync step 2 and update messages are
//    discarded; a non-empty one means the client's replica holds changes the server will never
//    have, so the server answers `resynchroniseRequired` and the client reloads the deck.
//
//  * PRESENCE IDENTITY IS THE SERVER'S. Awareness states are relayed, but the server overwrites the
//    `person` inside every state with the connection's own person and binds each awareness client
//    id to the connection that first used it, so nobody can show a cursor under someone else's name
//    or remove someone else's cursor. A connection's states are removed when it closes.

import type { Observable } from "rxjs";
import type { DeckMember, DeckRole } from "./deck-access.ts";
import type { DiscussionLogEntry, DiscussionOutcome, DiscussionRequest, Person } from "./discussion.ts";
import type { DeckId, TransitionScriptId } from "./ids.ts";
import type { LocalPresence } from "./presence.ts";

/** Bumped when a message changes incompatibly; the server refuses other versions with 4010. */
export const COLLABORATION_PROTOCOL_VERSION = 1;

/** Offered by the client and echoed by the server as `Sec-WebSocket-Protocol`. */
export const DECK_SYNC_SUBPROTOCOL = `sasha-deck.${String(COLLABORATION_PROTOCOL_VERSION)}`;

/**
 * Embedded in the add-on, cookies are third-party and never sent, so the in-memory bearer token
 * travels as a second offered subprotocol `sasha-bearer.<token>` (a browser WebSocket cannot set an
 * Authorization header). The server never echoes it back.
 */
export const BEARER_SUBPROTOCOL_PREFIX = "sasha-bearer.";

/** `wss://<origin>/deck-api/sync/<deckId>?discussionAfter=<sequence>`. */
export const DECK_SYNC_PATH_PREFIX = "/deck-api/sync/";

/** The first varUint of a binary frame (y-websocket's numbering). */
export const BINARY_MESSAGE_TYPE = { sync: 0, awareness: 1 } as const;

/** The field of a Yjs awareness state that holds this protocol's presence. */
export const AWARENESS_PRESENCE_FIELD = "presence";

/** What a client puts in its awareness state; `person` is overwritten by the server. */
export type AwarenessPresenceState = Readonly<{ presence: LocalPresence }>;

// --- text frames ------------------------------------------------------------------------------

/** Every JSON text frame a client sends. */
export type ClientMessage =
  /** Answered by exactly one `discussionOutcome` with the same `requestId`. */
  | Readonly<{ kind: "discussionRequest"; request: DiscussionRequest }>
  /** Optional keepalive from a client whose page is hidden; the server answers nothing. */
  | Readonly<{ kind: "heartbeat" }>;

/** Every JSON text frame the server sends. */
export type ServerMessage =
  /** First frame on every connection, before any binary frame. */
  | Readonly<{
      kind: "welcome";
      protocolVersion: number;
      deckId: DeckId;
      me: Person;
      role: DeckRole;
      members: readonly DeckMember[];
      /** The last discussion sequence the server holds; entries after the client's `discussionAfter` follow. */
      discussionSequence: number;
    }>
  /** Log entries in sequence order, with no gaps after the client's `discussionAfter`. */
  | Readonly<{ kind: "discussionEntries"; entries: readonly DiscussionLogEntry[] }>
  | Readonly<{ kind: "discussionOutcome"; outcome: DiscussionOutcome }>
  /** This connection's role changed (the owner changed it, or link sharing changed). */
  | Readonly<{ kind: "accessChanged"; role: DeckRole }>
  | Readonly<{ kind: "membersChanged"; members: readonly DeckMember[] }>
  /** An agent applied edits through the connector; the editor offers "Undo Claude's edit". */
  | Readonly<{ kind: "agentEdit"; agentSessionId: string; agentName: string; summary: string }>
  /** The server corrected a protected field this client wrote (see the header). */
  | Readonly<{ kind: "correction"; correction: ProtectedFieldCorrection }>
  /** Messages above the rate are being dropped; slow down until the time has passed. */
  | Readonly<{ kind: "rateLimited"; retryAfterMilliseconds: number }>
  /** Every `HEARTBEAT_INTERVAL_MILLISECONDS`; silence for `CONNECTION_DEAD_AFTER_MILLISECONDS` means dead. */
  | Readonly<{ kind: "heartbeat" }>
  /** This client's replica holds changes the server refused: discard it and load the deck again. */
  | Readonly<{ kind: "resynchroniseRequired"; reason: ResynchroniseReason }>;

export type ResynchroniseReason =
  /** A viewer or commenter sent a non-empty document update. */
  | "updateFromReadOnlyRole"
  /** An update above `COLLABORATION_LIMITS.maximumMessageBytes`, or one that would grow the deck past its limit. */
  | "updateTooLarge"
  /** An update Yjs could not decode. */
  | "updateMalformed";

/** What the server wrote back after a client broke a rule (see the header). */
export type ProtectedFieldCorrection =
  | Readonly<{ kind: "approvalRevoked"; scriptId: TransitionScriptId; reason: ApprovalRevocationReason }>
  | Readonly<{ kind: "scriptAuthorRestored"; scriptId: TransitionScriptId }>
  | Readonly<{ kind: "metaRestored"; key: ProtectedMetaKey }>;

export type ApprovalRevocationReason =
  /** `approvedBy` named someone other than the sender. */
  | "approvedByAnotherPerson"
  /** `fingerprint` did not match the script text after the update. */
  | "fingerprintMismatch"
  /** The sender's role may not approve (cannot happen for an editor; kept for a role change in flight). */
  | "notPermitted";

export type ProtectedMetaKey = "deckId" | "schemaVersion" | "createdAt";

/** The document paths the server guards, for SPEC.md and the server's tests. */
export const PROTECTED_DOCUMENT_FIELDS: readonly string[] = [
  "meta/deckId",
  "meta/schemaVersion",
  "meta/createdAt",
  "transitionScripts/<id>/approval",
  "transitionScripts/<id>/author",
];

// --- closing ------------------------------------------------------------------------------------

/** Why the server closed a connection; each has its own close code (`CLOSE_CODE_BY_REASON`). */
export type CloseReason =
  /** The session expired or was never valid: refresh the session (GET /deck-api/session), then reconnect. */
  | "unauthenticated"
  | "accessRevoked"
  | "deckNotFound"
  | "deckDeleted"
  /** Over the rate for `rateLimitCloseAfterMilliseconds` continuously: reconnect with backoff. */
  | "rateLimited"
  | "protocolVersionUnsupported"
  /** The deck's `meta.schemaVersion` is newer than this client understands: open read-only, never retry. */
  | "documentSchemaTooNew"
  /** Too many connections to this deck or for this account: retry with backoff. */
  | "tooManyConnections"
  /** The server is restarting: reconnect with backoff. */
  | "serverShuttingDown";

/** Application close codes (4000-4999 are reserved for applications by RFC 6455). Total over reasons. */
export const CLOSE_CODE_BY_REASON: Readonly<Record<CloseReason, number>> = {
  unauthenticated: 4001,
  accessRevoked: 4003,
  deckNotFound: 4004,
  deckDeleted: 4005,
  rateLimited: 4008,
  protocolVersionUnsupported: 4010,
  documentSchemaTooNew: 4011,
  tooManyConnections: 4012,
  serverShuttingDown: 4013,
};

/** What the client does after each close reason. Total, so a new reason must decide. */
export const RECONNECT_AFTER_CLOSE: Readonly<Record<CloseReason, "refreshSessionThenReconnect" | "reconnectWithBackoff" | "stop">> = {
  unauthenticated: "refreshSessionThenReconnect",
  accessRevoked: "stop",
  deckNotFound: "stop",
  deckDeleted: "stop",
  rateLimited: "reconnectWithBackoff",
  protocolVersionUnsupported: "stop",
  documentSchemaTooNew: "stop",
  tooManyConnections: "reconnectWithBackoff",
  serverShuttingDown: "reconnectWithBackoff",
};

// --- timing and limits --------------------------------------------------------------------------

export const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;
/** No frame at all for this long (hidden-tab timer throttling included) and the client reconnects. */
export const CONNECTION_DEAD_AFTER_MILLISECONDS = 40_000;

/** Full-jitter exponential backoff: delay = random(0, min(maximum, initial * multiplier^attempt)). */
export const RECONNECT_POLICY = {
  initialDelayMilliseconds: 500,
  multiplier: 2,
  maximumDelayMilliseconds: 30_000,
} as const;

/**
 * Enforced by the server; the client respects the ones it can know in advance (message size, body
 * length) so a user sees a notice instead of a refusal.
 */
export const COLLABORATION_LIMITS = {
  /** Any single WebSocket frame, either direction; larger inbound frames close nothing, they are refused (`updateTooLarge`). */
  maximumMessageBytes: 4 * 1024 * 1024,
  /** `Y.encodeStateAsUpdate` of the whole deck; an update that would pass it is refused. */
  maximumDocumentBytes: 32 * 1024 * 1024,
  /** Token bucket per connection over every inbound frame (awareness included). */
  messagesPerSecond: 20,
  messageBurst: 100,
  /**
   * Continuously over the rate this long and the connection is closed `rateLimited`. "Continuously"
   * is an overload EPISODE (server/rate-limit.ts): it lasts while dropped frames arrive less than
   * one second apart, even when accepted frames come in between, and ends after a quiet second.
   */
  rateLimitCloseAfterMilliseconds: 10_000,
  maximumConnectionsPerDeck: 50,
  maximumConnectionsPerAccount: 20,
  maximumAwarenessStateBytes: 8 * 1024,
  maximumDiscussionBodyCharacters: 10_000,
  maximumMarkingsPerThread: 50,
  maximumPointsPerMarking: 2_000,
  maximumThreadsPerDeck: 5_000,
  maximumMentionsPerMessage: 20,
  /** One uploaded image. */
  maximumAssetBytes: 25 * 1024 * 1024,
  maximumAssetBytesPerDeck: 512 * 1024 * 1024,
  maximumDecksPerAccount: 500,
  maximumMembersPerDeck: 100,
  maximumInvitationsPerAccountPerDay: 100,
  /** Commands in one `deck_apply` envelope (assistant-deck-tools.ts). */
  maximumCommandsPerAgentApply: 200,
  /** Idempotency window: a repeated discussion `requestId` among this many recent ones gets its first outcome again. */
  rememberedDiscussionRequestIds: 1_000,
} as const;

// --- what the editor sees -------------------------------------------------------------------------

/** The connection as the editor shows it (top bar indicator, read-only banner). */
export type ConnectionState =
  /** No server at all: the demo and the tests. Never offline, never read-only for this reason. */
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "connecting"; attempt: number }>
  /** Open, welcome received, waiting for the server's sync step 2. */
  | Readonly<{ kind: "synchronising" }>
  | Readonly<{ kind: "online" }>
  /** Will retry by itself; `retryInMilliseconds` is null while the browser reports no network at all. */
  | Readonly<{ kind: "offline"; reason: OfflineReason; attempt: number; retryInMilliseconds: number | null }>
  /** Will not retry; the editor becomes read-only and says why. */
  | Readonly<{ kind: "closed"; reason: ClosedReason }>;

export type OfflineReason = "networkLost" | "serverUnreachable" | "heartbeatMissed" | "rateLimited" | "tooManyConnections" | "serverRestarting";

export type ClosedReason = "accessRevoked" | "deckNotFound" | "deckDeleted" | "signedOut" | "protocolVersionUnsupported" | "documentSchemaTooNew";

/** Everything the collaboration session tells the editor, as one value. */
export type CollaborationStatus = Readonly<{
  connection: ConnectionState;
  /** This person's role; `owner` for a local deck. The editor hides what the role cannot do. */
  role: DeckRole;
  /** For mentions and the people list; empty for a local deck. */
  members: readonly DeckMember[];
  /** Local document changes the server has not received yet (offline edits, a backlog on a slow link). */
  unsentChanges: boolean;
}>;

export const LOCAL_COLLABORATION_STATUS: CollaborationStatus = {
  connection: { kind: "local" },
  role: "owner",
  members: [],
  unsentChanges: false,
};

/** One-off things the server said that the editor turns into notices. */
export type CollaborationNotice =
  | Readonly<{ kind: "agentEdit"; agentSessionId: string; agentName: string; summary: string }>
  | Readonly<{ kind: "correction"; correction: ProtectedFieldCorrection }>
  | Readonly<{ kind: "rateLimited"; retryAfterMilliseconds: number }>
  | Readonly<{ kind: "resynchronising"; reason: ResynchroniseReason }>;

export type AgentRevertOutcome =
  | Readonly<{ kind: "reverted"; stepsReverted: number; skippedSteps: number }>
  | Readonly<{ kind: "nothingToRevert"; skippedSteps: number }>
  | Readonly<{ kind: "notPermitted" }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * The editor's view of the collaboration session (EditorDependencies.collaboration). The web
 * module implements it over the deck's WebSocket and the deck API; the state module's feedbacks
 * turn `statusChanges` into `collaborationChanged`, `notices` into notices, and call the two
 * methods from the reconnect and "Undo Claude's edit" actions. The document, the discussion and
 * presence do NOT go through here: they keep their own milestone 1 interfaces (DocumentStore,
 * DiscussionStore, PresenceChannel), implemented over the same socket.
 */
export interface CollaborationSession extends Disposable {
  status(): CollaborationStatus;
  /** Hot; emits every new status (not the current one on subscribe -- read `status()`). */
  readonly statusChanges: Observable<CollaborationStatus>;
  readonly notices: Observable<CollaborationNotice>;
  /** Skip the backoff wait ("Try now", the browser's `online` event). No-op unless offline. */
  reconnectNow(): void;
  /** POST /deck-api/decks/<id>/agent-sessions/<agentSessionId>/revert. Never throws. */
  revertAgentSession(agentSessionId: string): Promise<AgentRevertOutcome>;
}
