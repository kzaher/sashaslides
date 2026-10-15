// THE ROOM: one loaded deck on the deck server -- the authoritative Y.Doc, a repairing model store
// over it, the discussion authority, the awareness relay and the connections -- with every
// transport injected (`RoomConnectionPort.send` / `close`), so it runs the same under `ws` in the
// connector and under fake connections in a test. SPEC.md 21.4 to 21.6; the wire format is
// collaboration.ts.
//
// Key decisions:
//
//  * EVERY CHANGE TO THE DOCUMENT LEAVES THROUGH ONE OF TWO DOORS. Updates the server's own replica
//    makes (agent edits, imports, repairs, the seed) are broadcast to every connection and handed to
//    `persistUpdate` as Yjs emits them. An editor's update goes through the GUARD: it is applied in
//    its own transaction with the connection's origin, the protected fields are compared before and
//    after (`correctionsFor`), any correction is written in one REPAIR_ORIGIN transaction, and only
//    `Y.mergeUpdates([update, correction])` is relayed and persisted, so no other replica and no
//    file ever holds the forbidden state. The sender gets the correction's update and a
//    `correction` message per broken rule.
//  * READ-ONLY ROLES NEVER WRITE. A viewer's or commenter's sync step 2 or update is checked with
//    `snapshotContainsUpdate` against the server's state: one that adds nothing (the step 2 of a
//    replica that is merely in sync) is accepted silently; one that adds anything is discarded and
//    answered `resynchroniseRequired` (`updateFromReadOnlyRole`), because that replica now holds
//    changes the server will never have.
//  * THE RATE LIMIT COUNTS EVERY INBOUND FRAME, before it is decoded (rate-limit.ts). Over the rate,
//    awareness and text frames are dropped; a document update closes the connection instead,
//    because a dropped one would strand the sender's replica ahead of the server.
//  * DISCUSSION REQUESTS ARE SERIALISED. Each is decided against the authority's state, its entry
//    persisted (`persistDiscussionEntry` resolves once it is on disk, or once the first attempt
//    failed and the storage retries it), then broadcast to every connection, the sender included,
//    and only then answered -- so entries arrive everywhere in sequence order.
//  * NO TIMERS. Heartbeats, unload timers and flush cadences belong to the transport and the deck
//    registry; the room only uses the injected clock (rate limits, discussion times) and the
//    injected scheduler (the model store's repairs).

import type { SchedulerLike } from "rxjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { assertNever } from "../contracts/assert-never.ts";
import {
  BINARY_MESSAGE_TYPE,
  COLLABORATION_LIMITS,
  COLLABORATION_PROTOCOL_VERSION,
  type AgentRevertOutcome,
  type CloseReason,
  type ProtectedFieldCorrection,
  type ResynchroniseReason,
  type ServerMessage,
} from "../contracts/collaboration.ts";
import type { CommandEnvelope, CommandOutcome } from "../contracts/commands.ts";
import { roleAllows, type DeckMember, type DeckRole } from "../contracts/deck-access.ts";
import type { AgentSessionSummary } from "../contracts/deck-api.ts";
import type { DiscussionLogEntry, DiscussionOutcome, DiscussionRequest, DiscussionSnapshot, Person } from "../contracts/discussion.ts";
import type { DocumentStore } from "../contracts/document-store.ts";
import type { DocumentSnapshot } from "../contracts/document.ts";
import type { DeckId, PersonId, RandomSource } from "../contracts/ids.ts";
import { REPAIR_ORIGIN } from "../contracts/yjs-schema.ts";
import { createAgentHistories } from "../model/agent-histories.ts";
import { createDocumentStore } from "../model/document-store.ts";
import { readProtectedFields, writeProtectedFields } from "../model/protected-fields.ts";
import { createAwarenessRelay } from "./awareness-relay.ts";
import { parseClientMessage } from "./client-messages.ts";
import { decideDiscussionRequest, discussionAuthorityFromLog, type DiscussionAuthorityState } from "./discussion-authority.ts";
import { correctionsFor } from "./protected-field-guard.ts";
import { DEFAULT_RATE_LIMIT_POLICY, initialRateLimitState, takeToken, type RateLimitPolicy, type RateLimitState } from "./rate-limit.ts";

/** One WebSocket frame, either direction. Binary frames are y-websocket's; text frames are JSON. */
export type RoomFrame = Readonly<{ kind: "binary"; bytes: Uint8Array }> | Readonly<{ kind: "text"; text: string }>;

/** What the transport gives the room for one connection. */
export type RoomConnectionPort = Readonly<{
  send(frame: RoomFrame): void;
  /** The room closed the connection (it has already forgotten it); close with `CLOSE_CODE_BY_REASON[reason]`. */
  close(reason: CloseReason): void;
}>;

/** One connected client, as the transport drives it. */
export type RoomConnection = Readonly<{
  id: number;
  person: Person;
  role(): DeckRole;
  /** An inbound frame from the client. */
  receive(frame: RoomFrame): void;
  /** The member's role changed: the connection acts with it from now on and is told `accessChanged`. */
  setRole(role: DeckRole): void;
  /** The transport closed (the client left, or a heartbeat failed). Idempotent. */
  disconnect(): void;
  /** The server closes this connection for `reason`. Idempotent. */
  closeWith(reason: CloseReason): void;
}>;

export type RoomApplyOutcome =
  | Readonly<{ kind: "applied"; outcome: Extract<CommandOutcome, { kind: "applied" }> }>
  | Readonly<{ kind: "rejected"; outcome: Extract<CommandOutcome, { kind: "rejected" }> }>
  | Readonly<{ kind: "tooLarge"; message: string }>;

export type DeckRoom = Disposable &
  Readonly<{
    deckId: DeckId;
    snapshot(): DocumentSnapshot;
    connect(options: Readonly<{ person: Person; role: DeckRole; discussionAfter: number; port: RoomConnectionPort }>): RoomConnection;
    connections(): readonly RoomConnection[];
    /** Applies an envelope on the server's replica; an agent's lands on its session's history and editors hear `agentEdit`. */
    applyEnvelope(options: Readonly<{ envelope: CommandEnvelope; summaryForCollaborators: string }>): RoomApplyOutcome;
    revertAgentSession(options: Readonly<{ agentSessionId: string }>): AgentRevertOutcome;
    agentSessions(): readonly AgentSessionSummary[];
    hasAgentHistory(): boolean;
    /** The clock time of the last agent edit, or null when there was none since the room loaded. */
    lastAgentEditAt(): number | null;
    discussion(): DiscussionSnapshot;
    /** Every stored entry after `sequence`, in order (the room keeps the whole log in memory). */
    discussionEntriesAfter(sequence: number): readonly DiscussionLogEntry[];
    submitDiscussion(options: Readonly<{ actor: Person; role: DeckRole; request: DiscussionRequest }>): Promise<DiscussionOutcome>;
    /** Called with the snapshot after every appended entry; dispose to stop. */
    onDiscussion(listener: (snapshot: DiscussionSnapshot) => void): Disposable;
    /** The people list changed: mentions are filtered against it and every connection hears `membersChanged`. */
    setMembers(members: readonly DeckMember[]): void;
    /** `Y.encodeStateAsUpdate` of the whole deck: what compaction writes. */
    encodeState(): Uint8Array;
    /** Closes every connection with `reason` (shutdown, deck deleted). */
    closeAll(reason: CloseReason): void;
  }>;

export type CreateDeckRoomOptions = Readonly<{
  deckId: DeckId;
  /** A brand-new deck is seeded blank with this id; a stored one replays `storedUpdates`. */
  seed: Readonly<{ kind: "blankDeck" }> | Readonly<{ kind: "stored"; storedUpdates: readonly Uint8Array[] }>;
  storedDiscussion: readonly DiscussionLogEntry[];
  members: readonly DeckMember[];
  now: () => number;
  scheduler: SchedulerLike;
  random: RandomSource;
  /** Every change that reaches the document after loading, merged with its corrections. */
  persistUpdate: (update: Uint8Array) => void;
  persistDiscussionEntry: (entry: DiscussionLogEntry) => Promise<void>;
  /** The number of connections changed (the registry's unload timer listens). */
  connectionsChanged: (count: number) => void;
  warn: (message: string) => void;
  rateLimitPolicy?: RateLimitPolicy;
}>;

/** The origin a stored update is replayed with: not persisted again, not broadcast. */
export const STORAGE_ORIGIN: Readonly<{ kind: "storage" }> = Object.freeze({ kind: "storage" });

export function createDeckRoom(options: CreateDeckRoomOptions): DeckRoom {
  const { deckId, now, warn } = options;
  const policy = options.rateLimitPolicy ?? DEFAULT_RATE_LIMIT_POLICY;
  const sharedDocument = new Y.Doc();
  for (const [index, update] of (options.seed.kind === "stored" ? options.seed.storedUpdates : []).entries()) {
    try {
      Y.applyUpdate(sharedDocument, update, STORAGE_ORIGIN);
    } catch (cause) {
      warn(`deck ${deckId}: stored update ${String(index)} does not decode and was skipped (${describe(cause)})`);
    }
  }
  const connections = new Map<number, ConnectionRecord>();
  const awareness = createAwarenessRelay();
  const discussionListeners = new Set<(snapshot: DiscussionSnapshot) => void>();
  const discussionLog: DiscussionLogEntry[] = [...options.storedDiscussion];
  let authority: DiscussionAuthorityState = discussionAuthorityFromLog(options.storedDiscussion);
  let discussionTail: Promise<unknown> = Promise.resolve();
  let members: readonly DeckMember[] = options.members;
  let documentBytes = Y.encodeStateAsUpdate(sharedDocument).length;
  let capture: Uint8Array[] | null = null;
  let lastAgentEdit: number | null = null;
  let nextConnectionId = 1;
  let disposed = false;

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === STORAGE_ORIGIN) return;
    if (capture !== null) {
      capture.push(update);
      return;
    }
    documentBytes += update.length;
    broadcast({ frame: syncUpdateFrame(update), except: null, permission: "read" });
    options.persistUpdate(update);
  };
  sharedDocument.on("update", onUpdate);

  const store: DocumentStore = createDocumentStore({
    sharedDocument,
    seed: options.seed.kind === "blankDeck" ? { kind: "blankDeck", deckId } : { kind: "none" },
    now,
    random: options.random,
    scheduler: options.scheduler,
    repairPolicy: "repairAfterTransaction",
    typingMergeWindowMilliseconds: 0,
  });
  const histories = createAgentHistories({ sharedDocument, random: options.random, now, revision: () => store.snapshot().revision });

  function broadcast(options: Readonly<{ frame: RoomFrame; except: number | null; permission: "read" | "editDocument" }>): void {
    for (const record of connections.values()) {
      if (record.id === options.except) continue;
      if (!roleAllows({ role: record.role, permission: options.permission })) continue;
      record.port.send(options.frame);
    }
  }

  function sendMessage(record: ConnectionRecord, message: ServerMessage): void {
    record.port.send({ kind: "text", text: JSON.stringify(message) });
  }

  function membersFor(role: DeckRole): readonly DeckMember[] {
    // Emails are for those who may share (deck-access.ts `DeckMember`).
    return roleAllows({ role, permission: "share" }) ? members : members.map((member) => ({ ...member, email: null }));
  }

  function forget(record: ConnectionRecord): void {
    if (!connections.delete(record.id)) return;
    const removal = awareness.removeConnection(record.id);
    if (removal !== null) broadcast({ frame: awarenessFrame(removal), except: null, permission: "read" });
    options.connectionsChanged(connections.size);
  }

  function receive(record: ConnectionRecord, frame: RoomFrame): void {
    if (!connections.has(record.id)) return;
    const taken = takeToken({ state: record.rateLimit, policy, now: now() });
    record.rateLimit = taken.state;
    switch (taken.verdict.kind) {
      case "accept":
        break;
      case "drop":
        // A dropped document update would leave the sender's replica holding a change the server
        // never gets, and every later update of theirs waiting on it; closing instead makes the
        // client reconnect, and its sync step 2 sends everything again (nothing is lost).
        if (carriesDocumentUpdate(frame)) {
          closeWith(record, "rateLimited");
          return;
        }
        if (taken.verdict.notify) sendMessage(record, { kind: "rateLimited", retryAfterMilliseconds: taken.verdict.retryAfterMilliseconds });
        return;
      case "close":
        closeWith(record, "rateLimited");
        return;
      default:
        assertNever(taken.verdict);
    }
    switch (frame.kind) {
      case "binary":
        receiveBinary(record, frame.bytes);
        return;
      case "text":
        receiveText(record, frame.text);
        return;
      default:
        assertNever(frame);
    }
  }

  function receiveBinary(record: ConnectionRecord, bytes: Uint8Array): void {
    if (bytes.length > COLLABORATION_LIMITS.maximumMessageBytes) {
      requireResynchronise(record, "updateTooLarge");
      return;
    }
    let decoder: decoding.Decoder;
    let messageType: number;
    try {
      decoder = decoding.createDecoder(bytes);
      messageType = decoding.readVarUint(decoder);
    } catch {
      record.ignoredFrames += 1;
      return;
    }
    switch (messageType) {
      case BINARY_MESSAGE_TYPE.sync:
        receiveSync(record, decoder);
        return;
      case BINARY_MESSAGE_TYPE.awareness: {
        let update: Uint8Array;
        try {
          update = decoding.readVarUint8Array(decoder);
        } catch {
          record.ignoredFrames += 1;
          return;
        }
        const relayed = awareness.receive({ connectionId: record.id, person: record.person, update });
        if (relayed !== null) broadcast({ frame: awarenessFrame(relayed), except: record.id, permission: "read" });
        return;
      }
      default:
        record.ignoredFrames += 1;
    }
  }

  function receiveSync(record: ConnectionRecord, decoder: decoding.Decoder): void {
    let syncType: number;
    let payload: Uint8Array;
    try {
      syncType = decoding.readVarUint(decoder);
      payload = decoding.readVarUint8Array(decoder);
    } catch {
      requireResynchronise(record, "updateMalformed");
      return;
    }
    switch (syncType) {
      case syncProtocol.messageYjsSyncStep1: {
        let missing: Uint8Array;
        try {
          missing = Y.encodeStateAsUpdate(sharedDocument, payload);
        } catch {
          requireResynchronise(record, "updateMalformed");
          return;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
        encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
        encoding.writeVarUint8Array(encoder, missing);
        record.port.send({ kind: "binary", bytes: encoding.toUint8Array(encoder) });
        return;
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate:
        receiveDocumentUpdate(record, payload);
        return;
      default:
        record.ignoredFrames += 1;
    }
  }

  function receiveDocumentUpdate(record: ConnectionRecord, update: Uint8Array): void {
    if (!roleAllows({ role: record.role, permission: "editDocument" })) {
      let addsNothing: boolean;
      try {
        addsNothing = Y.snapshotContainsUpdate(Y.snapshot(sharedDocument), update);
      } catch {
        requireResynchronise(record, "updateMalformed");
        return;
      }
      if (!addsNothing) requireResynchronise(record, "updateFromReadOnlyRole");
      return;
    }
    if (wouldPassDocumentLimit(update)) {
      requireResynchronise(record, "updateTooLarge");
      return;
    }
    applyGuarded(record, update);
  }

  /** The guard (see the header): apply, compare, correct, merge, relay, persist. */
  function applyGuarded(record: ConnectionRecord, update: Uint8Array): void {
    const before = readProtectedFields(sharedDocument);
    const captured: Uint8Array[] = [];
    capture = captured;
    let corrections: readonly ProtectedFieldCorrection[] = [];
    let correctionCount = 0;
    const pendingBefore = holdsPendingStructures(sharedDocument);
    // What this connection sent earlier that still waited for its dependencies goes in first.
    const carried = record.carriedPending;
    record.carriedPending = null;
    const incoming = carried === null ? update : Y.mergeUpdates([carried, update]);
    let oversizedPending = false;
    try {
      try {
        Y.applyUpdate(sharedDocument, incoming, record.origin);
      } catch (cause) {
        warn(`deck ${deckId}: an update from connection ${String(record.id)} did not apply (${describe(cause)})`);
        capture = null;
        requireResynchronise(record, "updateMalformed");
        return;
      }
      // Structures whose dependencies are missing would otherwise wait in the shared store and
      // integrate inside a LATER sender's transaction, where the guard would judge them as that
      // sender's: an editor could forge structures under a colleague's client id and see them
      // approved in the colleague's name. So what this update left pending is taken out of the
      // store and carried on THIS connection, retried with its next update and judged as its own.
      // An honest replica only leaves something pending for a moment (an update overtaking its own
      // sync step 2). Pending left by a damaged stored record stays shared: a client's next step 2
      // may fill it (SPEC.md 21.7).
      if (!pendingBefore && holdsPendingStructures(sharedDocument)) {
        const pending = takePendingStructures(sharedDocument);
        oversizedPending = pending.length > COLLABORATION_LIMITS.maximumMessageBytes;
        record.carriedPending = oversizedPending ? null : pending;
      }
      const sent = captured.length;
      const decision = correctionsFor({ before, after: readProtectedFields(sharedDocument), sender: { person: record.person, role: record.role } });
      writeProtectedFields({ sharedDocument, writes: decision.writes, origin: REPAIR_ORIGIN });
      corrections = decision.corrections;
      correctionCount = captured.length - sent;
    } finally {
      capture = null;
    }
    if (oversizedPending) {
      warn(`deck ${deckId}: connection ${String(record.id)} kept sending updates whose dependencies never arrived; they were dropped`);
      requireResynchronise(record, "updateMalformed");
    }
    if (captured.length === 0) return;
    const merged = captured.length === 1 && captured[0] !== undefined ? captured[0] : Y.mergeUpdates(captured);
    documentBytes += merged.length;
    broadcast({ frame: syncUpdateFrame(merged), except: record.id, permission: "read" });
    if (correctionCount > 0) {
      record.port.send(syncUpdateFrame(Y.mergeUpdates(captured.slice(captured.length - correctionCount))));
      for (const correction of corrections) sendMessage(record, { kind: "correction", correction });
    }
    options.persistUpdate(merged);
  }

  function wouldPassDocumentLimit(update: Uint8Array): boolean {
    if (documentBytes + update.length <= COLLABORATION_LIMITS.maximumDocumentBytes) return false;
    // Near the limit the running estimate is replaced by the truth, and only the part of the update
    // the server lacks counts (a step 2 repeats what both sides hold).
    documentBytes = Y.encodeStateAsUpdate(sharedDocument).length;
    const added = Y.diffUpdate(update, Y.encodeStateVector(sharedDocument)).length;
    return documentBytes + added > COLLABORATION_LIMITS.maximumDocumentBytes;
  }

  function receiveText(record: ConnectionRecord, text: string): void {
    if (text.length > COLLABORATION_LIMITS.maximumMessageBytes) {
      record.ignoredFrames += 1;
      return;
    }
    const parsed = parseClientMessage(text);
    switch (parsed.kind) {
      case "unknown":
      case "malformed":
        record.ignoredFrames += 1;
        return;
      case "message":
        break;
      default:
        assertNever(parsed);
    }
    const message = parsed.message;
    switch (message.kind) {
      case "heartbeat":
        return;
      case "discussionRequest":
        void submit({ actor: record.person, role: record.role, request: message.request }).then((outcome) => {
          if (connections.has(record.id)) sendMessage(record, { kind: "discussionOutcome", outcome });
        });
        return;
      default:
        assertNever(message);
    }
  }

  function submit(request: Readonly<{ actor: Person; role: DeckRole; request: DiscussionRequest }>): Promise<DiscussionOutcome> {
    const run = async (): Promise<DiscussionOutcome> => {
      const memberIds = new Set<PersonId>(members.map((member) => member.person.id));
      const decision = decideDiscussionRequest({ state: authority, request: request.request, actor: request.actor, role: request.role, memberIds, now: now() });
      authority = decision.state;
      const entry = decision.entry;
      if (entry === null) return decision.outcome;
      discussionLog.push(entry);
      try {
        await options.persistDiscussionEntry(entry);
      } catch (cause) {
        warn(`deck ${deckId}: discussion entry ${String(entry.sequence)} was not stored yet (${describe(cause)})`);
      }
      const message: ServerMessage = { kind: "discussionEntries", entries: [entry] };
      for (const record of connections.values()) sendMessage(record, message);
      for (const listener of [...discussionListeners]) listener(authority.snapshot);
      return decision.outcome;
    };
    const result = discussionTail.then(run, run);
    discussionTail = result.catch(() => undefined);
    return result;
  }

  function requireResynchronise(record: ConnectionRecord, reason: ResynchroniseReason): void {
    sendMessage(record, { kind: "resynchroniseRequired", reason });
  }

  function closeWith(record: ConnectionRecord, reason: CloseReason): void {
    if (!connections.has(record.id)) return;
    forget(record);
    record.port.close(reason);
  }

  function connectionFor(record: ConnectionRecord): RoomConnection {
    return {
      id: record.id,
      person: record.person,
      role: () => record.role,
      receive: (frame) => receive(record, frame),
      setRole: (nextRole) => {
        if (!connections.has(record.id)) return;
        record.role = nextRole;
        sendMessage(record, { kind: "accessChanged", role: nextRole });
      },
      disconnect: () => forget(record),
      closeWith: (reason) => closeWith(record, reason),
    };
  }

  return {
    deckId,
    snapshot: () => store.snapshot(),
    connect: ({ person, role, discussionAfter, port }) => {
      if (disposed) throw new Error(`deck ${deckId}: the room was unloaded`);
      const id = nextConnectionId;
      nextConnectionId += 1;
      const record: ConnectionRecord = {
        id,
        person,
        role,
        port,
        origin: Object.freeze({ kind: "connection", connectionId: id }),
        rateLimit: initialRateLimitState({ policy, now: now() }),
        carriedPending: null,
        ignoredFrames: 0,
      };
      connections.set(id, record);
      sendMessage(record, {
        kind: "welcome",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        deckId,
        me: person,
        role,
        members: membersFor(role),
        discussionSequence: authority.snapshot.sequence,
      });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
      syncProtocol.writeSyncStep1(encoder, sharedDocument);
      port.send({ kind: "binary", bytes: encoding.toUint8Array(encoder) });
      const states = awareness.statesFor(id);
      if (states !== null) port.send(awarenessFrame(states));
      sendMessage(record, { kind: "discussionEntries", entries: discussionLog.filter((entry) => entry.sequence > discussionAfter) });
      options.connectionsChanged(connections.size);
      return connectionFor(record);
    },
    connections: () => [...connections.values()].map(connectionFor),
    applyEnvelope: ({ envelope, summaryForCollaborators }) => {
      if (documentBytes >= COLLABORATION_LIMITS.maximumDocumentBytes) {
        documentBytes = Y.encodeStateAsUpdate(sharedDocument).length;
        if (documentBytes >= COLLABORATION_LIMITS.maximumDocumentBytes) {
          return { kind: "tooLarge", message: `the deck has reached its ${String(COLLABORATION_LIMITS.maximumDocumentBytes / 1024 / 1024)} megabyte limit` };
        }
      }
      const outcome = histories.apply(envelope);
      switch (outcome.kind) {
        case "rejected":
          return { kind: "rejected", outcome };
        case "applied":
          break;
        default:
          return assertNever(outcome);
      }
      const author = envelope.author;
      switch (author.kind) {
        case "agent":
          lastAgentEdit = now();
          for (const record of connections.values()) {
            if (!roleAllows({ role: record.role, permission: "editDocument" })) continue;
            sendMessage(record, { kind: "agentEdit", agentSessionId: author.agentSessionId, agentName: author.name, summary: summaryForCollaborators });
          }
          break;
        case "person":
          break;
        default:
          return assertNever(author);
      }
      return { kind: "applied", outcome };
    },
    revertAgentSession: ({ agentSessionId }) => {
      const result = histories.revert({ agentSessionId });
      if (result.stepsReverted === 0) return { kind: "nothingToRevert", skippedSteps: result.skippedSteps };
      return { kind: "reverted", stepsReverted: result.stepsReverted, skippedSteps: result.skippedSteps };
    },
    agentSessions: () => histories.sessions(),
    hasAgentHistory: () => histories.hasHistory(),
    lastAgentEditAt: () => lastAgentEdit,
    discussion: () => authority.snapshot,
    discussionEntriesAfter: (sequence) => discussionLog.filter((entry) => entry.sequence > sequence),
    submitDiscussion: (request) => submit(request),
    onDiscussion: (listener) => {
      discussionListeners.add(listener);
      return { [Symbol.dispose]: () => void discussionListeners.delete(listener) };
    },
    setMembers: (next) => {
      members = next;
      for (const record of connections.values()) sendMessage(record, { kind: "membersChanged", members: membersFor(record.role) });
    },
    encodeState: () => Y.encodeStateAsUpdate(sharedDocument),
    closeAll: (reason) => {
      for (const record of [...connections.values()]) closeWith(record, reason);
    },
    [Symbol.dispose]: () => {
      if (disposed) return;
      disposed = true;
      for (const record of [...connections.values()]) closeWith(record, "serverShuttingDown");
      sharedDocument.off("update", onUpdate);
      histories[Symbol.dispose]();
      store[Symbol.dispose]();
      sharedDocument.destroy();
      discussionListeners.clear();
    },
  };
}

/** Mutable on purpose: role, rate limit and counters change while the connection lives, inside this module only. */
type ConnectionRecord = {
  readonly id: number;
  readonly person: Person;
  role: DeckRole;
  readonly port: RoomConnectionPort;
  /** The transaction origin of this connection's updates (an object, compared by identity). */
  readonly origin: object;
  rateLimit: RateLimitState;
  /** What this connection's updates left waiting for dependencies, retried with its next update (`applyGuarded`). */
  carriedPending: Uint8Array | null;
  /** Frames the room could not use: unknown kinds, malformed text, unknown binary types. */
  ignoredFrames: number;
};

function syncUpdateFrame(update: Uint8Array): RoomFrame {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
  syncProtocol.writeUpdate(encoder, update);
  return { kind: "binary", bytes: encoding.toUint8Array(encoder) };
}

function awarenessFrame(update: Uint8Array): RoomFrame {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.awareness);
  encoding.writeVarUint8Array(encoder, update);
  return { kind: "binary", bytes: encoding.toUint8Array(encoder) };
}

/** A binary sync step 2 or update: the frames that change the document. */
function carriesDocumentUpdate(frame: RoomFrame): boolean {
  if (frame.kind !== "binary") return false;
  // Message and sync types are small variable-length integers, one byte each.
  const [messageType, syncType] = frame.bytes;
  return messageType === BINARY_MESSAGE_TYPE.sync && (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate);
}

/** Whether Yjs holds structures or deletions that wait for dependencies it does not have yet. */
function holdsPendingStructures(sharedDocument: Y.Doc): boolean {
  return sharedDocument.store.pendingStructs !== null || sharedDocument.store.pendingDs !== null;
}

/** Removes what waits in the store and returns it as one update (Yjs keeps it in the version 2 format). */
function takePendingStructures(sharedDocument: Y.Doc): Uint8Array {
  const store = sharedDocument.store;
  const parts: Uint8Array[] = [];
  if (store.pendingStructs !== null) parts.push(Y.convertUpdateFormatV2ToV1(store.pendingStructs.update));
  if (store.pendingDs !== null) parts.push(Y.convertUpdateFormatV2ToV1(store.pendingDs));
  store.pendingStructs = null;
  store.pendingDs = null;
  return parts.length === 1 && parts[0] !== undefined ? parts[0] : Y.mergeUpdates(parts);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}






