/**
 * The loaded rooms and everything with a lifetime around them (SPEC.md 21.6, 21.7, 21.16): loading
 * a deck's room from storage on first use, batching its updates into one log record every 250
 * milliseconds, compacting the log, unloading an idle room, and flushing everything on shutdown.
 *
 * Key decisions:
 *
 *  - LEASES AND CONNECTIONS KEEP A ROOM LOADED. A `DeckHandle` (an agent's or an import's) holds a
 *    lease, a socket holds a connection. When both counts reach zero the room unloads 60 seconds
 *    later, or 30 minutes after its last agent edit while an agent history exists (a revert needs
 *    the history, which lives only in memory). Unloading flushes first; a request that arrives
 *    while an unload is flushing waits for it and loads the room again, so no update is lost.
 *  - ONE FLUSH IN FLIGHT PER ROOM. Updates pile up in `pending`; a flush takes them all, merges them
 *    (`mergeDocumentUpdates`, engine) into one record and appends it. Past 500 records or one
 *    megabyte the log is compacted into the snapshot.
 *  - A FAILING DISK DOES NOT STOP THE ROOM. A failed flush puts its batch back, warns, and retries
 *    with backoff from 1 second to 30; after 60 seconds of failures the room closes its sockets
 *    `serverShuttingDown`, so clients keep their edits and resend them when the server recovers.
 *  - THE RECORD IS CACHED AND WRITTEN THROUGH. Every change to a deck's members, sharing or links
 *    goes through `updateRecord`, serialised per deck, which writes `deck.sealed` and the index.
 *  - TIMERS ARE INJECTED (`DeckTimers`), so the lifecycle is tested on a virtual clock.
 */
import type { SchedulerLike } from "rxjs";
import type { CloseReason } from "../engine/src/contracts/collaboration.ts";
import type { DeckMember, DeckRole } from "../engine/src/contracts/deck-access.ts";
import type { DiscussionLogEntry, Person } from "../engine/src/contracts/discussion.ts";
import type { DeckId, RandomSource } from "../engine/src/contracts/ids.ts";
import { createDeckRoom, mergeDocumentUpdates, type DeckRoom, type RoomConnection, type RoomConnectionPort } from "../engine/src/server/index.ts";
import type { AccountId } from "../http/account-vault";
import { indexEntryOf, type DeckRecord } from "./deck-records";
import type { DeckStorage, LogSize } from "./deck-storage";

export type DeckTimers = Readonly<{
  /** Runs `run` once after `delayMilliseconds`; disposing cancels it. */
  schedule(options: Readonly<{ delayMilliseconds: number; run: () => void }>): Disposable;
}>;

/** Production timers: `setTimeout`, unreferenced so a pending flush never keeps the process alive by itself. */
export const REAL_TIMERS: DeckTimers = {
  schedule: ({ delayMilliseconds, run }) => {
    const handle = setTimeout(run, delayMilliseconds);
    handle.unref();
    return { [Symbol.dispose]: () => clearTimeout(handle) };
  },
};

export const DECK_LIFECYCLE = {
  flushIntervalMilliseconds: 250,
  unloadAfterMilliseconds: 60_000,
  unloadAfterAgentEditMilliseconds: 30 * 60_000,
  compactAfterRecords: 500,
  compactAfterBytes: 1024 * 1024,
  retryInitialMilliseconds: 1_000,
  retryMaximumMilliseconds: 30_000,
  closeAfterFailingMilliseconds: 60_000,
} as const;

/** A loaded deck: its room and the record as last written. */
export type LoadedDeck = Readonly<{ deckId: DeckId; room: DeckRoom; record: () => DeckRecord }>;

/** Holding one keeps the room loaded; `release` lets it unload once idle. */
export type DeckLease = Readonly<{ deck: LoadedDeck; release: () => void }>;

export type DeckRegistry = Readonly<{
  /** The record, from the cache or storage; null when the deck is unknown or does not open. */
  readRecord(options: Readonly<{ deckId: DeckId }>): Promise<DeckRecord | null>;
  /** Changes and writes the record (and the index); returns the new one, or null when the deck is gone. */
  updateRecord(options: Readonly<{ deckId: DeckId; change: (record: DeckRecord) => DeckRecord }>): Promise<DeckRecord | null>;
  /** Writes a new deck's record and index entry and loads its room, seeded blank. */
  createDeck(options: Readonly<{ record: DeckRecord }>): Promise<DeckLease>;
  acquire(options: Readonly<{ deckId: DeckId }>): Promise<DeckLease | null>;
  /** The room if it is loaded now (no loading). */
  loaded(options: Readonly<{ deckId: DeckId }>): LoadedDeck | null;
  /** Connects a socket to the deck's room (loading it), remembering the account for `closeAccount`. */
  connect(
    options: Readonly<{ deckId: DeckId; accountId: AccountId; person: Person; role: DeckRole; discussionAfter: number; port: RoomConnectionPort }>,
  ): Promise<RoomConnection | null>;
  /** The open connections of an account, with their decks. */
  connectionsOf(options: Readonly<{ accountId: AccountId }>): readonly Readonly<{ deckId: DeckId; connection: RoomConnection }>[];
  /** The open connections to one deck, with their accounts. */
  connectionsOfDeck(options: Readonly<{ deckId: DeckId }>): readonly Readonly<{ accountId: AccountId; connection: RoomConnection }>[];
  /** Closes the sockets, forgets the room without flushing, and deletes the deck's files and index entry. */
  deleteDeck(options: Readonly<{ deckId: DeckId; reason: CloseReason }>): Promise<void>;
  /** Persists every pending update now (tests, and before compaction checks). */
  flushAll(): Promise<void>;
  /** SIGTERM: close every socket `serverShuttingDown`, flush every room, unload them. */
  shutdown(): Promise<void>;
}>;

export function createDeckRegistry(
  options: Readonly<{
    storage: DeckStorage;
    timers: DeckTimers;
    now: () => number;
    scheduler: SchedulerLike;
    random: RandomSource;
    /** The people list a room shows (display names, roles and, for sharers, emails). */
    membersOf: (record: DeckRecord) => Promise<readonly DeckMember[]>;
    warn: (message: string) => void;
  }>,
): DeckRegistry {
  const { storage, timers, now, warn } = options;
  const records = new Map<DeckId, DeckRecord>();
  const recordTails = new Map<DeckId, Promise<unknown>>();
  const entries = new Map<DeckId, RoomEntry>();
  const loading = new Map<DeckId, Promise<RoomEntry | null>>();
  const unloading = new Map<DeckId, Promise<void>>();

  const readRecord = async ({ deckId }: Readonly<{ deckId: DeckId }>): Promise<DeckRecord | null> => {
    const cached = records.get(deckId);
    if (cached !== undefined) return cached;
    const entry = storage.readIndex().decks[deckId];
    if (entry === undefined) return null;
    const record = await storage.readRecord({ deckId, ownerAccountId: entry.ownerAccountId });
    if (record !== null) records.set(deckId, record);
    return record;
  };

  const writeRecord = async (record: DeckRecord): Promise<void> => {
    await storage.writeRecord(record);
    await storage.updateIndex((index) => ({ version: 1, decks: { ...index.decks, [record.deckId]: indexEntryOf(record) } }));
    records.set(record.deckId, record);
  };

  const updateRecord = ({ deckId, change }: Readonly<{ deckId: DeckId; change: (record: DeckRecord) => DeckRecord }>): Promise<DeckRecord | null> => {
    const run = async (): Promise<DeckRecord | null> => {
      const current = await readRecord({ deckId });
      if (current === null) return null;
      const next = change(current);
      if (next === current) return current;
      await writeRecord(next);
      const entry = entries.get(deckId);
      const peopleChanged = JSON.stringify([current.members, current.invitations]) !== JSON.stringify([next.members, next.invitations]);
      if (entry !== undefined && peopleChanged) entry.room.setMembers(await options.membersOf(next));
      return next;
    };
    const result = (recordTails.get(deckId) ?? Promise.resolve()).then(run, run);
    recordTails.set(deckId, result.catch(() => undefined));
    return result;
  };

  const loadEntry = async (deckId: DeckId, seed: "blankDeck" | "stored"): Promise<RoomEntry | null> => {
    const pendingUnload = unloading.get(deckId);
    if (pendingUnload !== undefined) await pendingUnload;
    const existing = entries.get(deckId);
    if (existing !== undefined) return existing;
    const record = await readRecord({ deckId });
    if (record === null) return null;
    const location = { deckId, ownerAccountId: record.ownerAccountId };
    const stored = seed === "stored" ? await storage.loadDocument(location) : { updates: [], lastSequence: 0, logSize: { records: 0, bytes: 0 } };
    const discussion = seed === "stored" ? await storage.loadDiscussion(location) : [];
    const members = await options.membersOf(record);
    const entry: RoomEntry = {
      deckId,
      ownerAccountId: record.ownerAccountId,
      pending: [],
      sequence: stored.lastSequence,
      logSize: stored.logSize,
      flushTimer: null,
      flushing: null,
      failingSince: null,
      retryDelay: DECK_LIFECYCLE.retryInitialMilliseconds,
      leases: 0,
      connections: new Map(),
      unloadTimer: null,
      lastRecordTouch: now(),
      // Replaced just below by the room itself. During `createDeckRoom` the room only calls
      // `persistUpdate` (the blank deck's seed), which touches `pending` and the flush timer and
      // never `room`; every other callback needs a connection, which needs the room returned.
      room: null as unknown as DeckRoom,
    };
    entry.room = createDeckRoom({
      deckId,
      seed: seed === "blankDeck" ? { kind: "blankDeck" } : { kind: "stored", storedUpdates: stored.updates },
      storedDiscussion: discussion,
      members,
      now,
      scheduler: options.scheduler,
      random: options.random,
      persistUpdate: (update) => {
        entry.pending.push(update);
        scheduleFlush(entry, DECK_LIFECYCLE.flushIntervalMilliseconds);
      },
      persistDiscussionEntry: (discussionEntry) => persistDiscussion(entry, discussionEntry),
      connectionsChanged: () => scheduleUnloadCheck(entry),
      warn,
    });
    entries.set(deckId, entry);
    return entry;
  };

  const ensureEntry = (deckId: DeckId, seed: "blankDeck" | "stored"): Promise<RoomEntry | null> => {
    const existing = entries.get(deckId);
    if (existing !== undefined && !unloading.has(deckId)) return Promise.resolve(existing);
    const inFlight = loading.get(deckId);
    if (inFlight !== undefined) return inFlight;
    const started = loadEntry(deckId, seed).finally(() => loading.delete(deckId));
    loading.set(deckId, started);
    return started;
  };

  const persistDiscussion = async (entry: RoomEntry, discussionEntry: DiscussionLogEntry): Promise<void> => {
    try {
      await storage.appendDiscussion({ deckId: entry.deckId, ownerAccountId: entry.ownerAccountId, entry: discussionEntry });
    } catch (cause) {
      warn(`deck ${entry.deckId}: discussion entry ${String(discussionEntry.sequence)} was not stored (${describe(cause)}); retrying`);
      const retry = (): void => {
        storage.appendDiscussion({ deckId: entry.deckId, ownerAccountId: entry.ownerAccountId, entry: discussionEntry }).catch(() => {
          timers.schedule({ delayMilliseconds: DECK_LIFECYCLE.retryMaximumMilliseconds, run: retry });
        });
      };
      timers.schedule({ delayMilliseconds: DECK_LIFECYCLE.retryInitialMilliseconds, run: retry });
    }
  };

  function scheduleFlush(entry: RoomEntry, delayMilliseconds: number): void {
    if (entry.flushTimer !== null || entry.flushing !== null) return;
    entry.flushTimer = timers.schedule({
      delayMilliseconds,
      run: () => {
        entry.flushTimer = null;
        void flush(entry);
      },
    });
  }

  function flush(entry: RoomEntry): Promise<void> {
    if (entry.flushing !== null) return entry.flushing;
    entry.flushTimer?.[Symbol.dispose]();
    entry.flushTimer = null;
    /** Resolves with the delay before the next attempt when this one failed, else null. */
    const run = async (): Promise<number | null> => {
      const batch = entry.pending.splice(0);
      if (batch.length === 0) return null;
      const sequence = entry.sequence + 1;
      const location = { deckId: entry.deckId, ownerAccountId: entry.ownerAccountId };
      try {
        const appended = await storage.appendDocument({ ...location, sequence, update: mergeDocumentUpdates(batch) });
        entry.sequence = sequence;
        entry.logSize = { records: entry.logSize.records + appended.records, bytes: entry.logSize.bytes + appended.bytes };
        entry.failingSince = null;
        entry.retryDelay = DECK_LIFECYCLE.retryInitialMilliseconds;
        if (entry.logSize.records >= DECK_LIFECYCLE.compactAfterRecords || entry.logSize.bytes > DECK_LIFECYCLE.compactAfterBytes) {
          await storage.compactDocument({ ...location, state: entry.room.encodeState(), throughSequence: entry.sequence });
          entry.logSize = { records: 0, bytes: 0 };
        }
        await touchRecord(entry);
      } catch (cause) {
        entry.pending.unshift(...batch);
        entry.failingSince = entry.failingSince ?? now();
        warn(`deck ${entry.deckId}: flushing ${String(batch.length)} update(s) failed (${describe(cause)}); retrying in ${String(entry.retryDelay)} ms`);
        if (now() - entry.failingSince >= DECK_LIFECYCLE.closeAfterFailingMilliseconds) entry.room.closeAll("serverShuttingDown");
        const delay = entry.retryDelay;
        entry.retryDelay = Math.min(DECK_LIFECYCLE.retryMaximumMilliseconds, entry.retryDelay * 2);
        return delay;
      }
      return null;
    };
    const flushing = run().then((retryDelay) => {
      if (entry.flushing === flushing) entry.flushing = null;
      if (entry.pending.length > 0) scheduleFlush(entry, retryDelay ?? DECK_LIFECYCLE.flushIntervalMilliseconds);
    });
    entry.flushing = flushing;
    return flushing;
  }

  /** Keeps the list's title and "edited" time current without rewriting the record on every keystroke. */
  async function touchRecord(entry: RoomEntry): Promise<void> {
    const title = entry.room.snapshot().title;
    const record = records.get(entry.deckId);
    if (record === undefined) return;
    const stale = now() - entry.lastRecordTouch >= RECORD_TOUCH_INTERVAL_MILLISECONDS;
    if (record.title === title && !stale) return;
    entry.lastRecordTouch = now();
    await updateRecord({ deckId: entry.deckId, change: (current) => ({ ...current, title, updatedAt: now() }) });
  }

  function scheduleUnloadCheck(entry: RoomEntry): void {
    entry.unloadTimer?.[Symbol.dispose]();
    entry.unloadTimer = null;
    if (entry.leases > 0 || entry.connections.size > 0 || entries.get(entry.deckId) !== entry) return;
    const lastAgentEdit = entry.room.lastAgentEditAt();
    const delayMilliseconds = entry.room.hasAgentHistory()
      ? Math.max(DECK_LIFECYCLE.unloadAfterMilliseconds, (lastAgentEdit ?? now()) + DECK_LIFECYCLE.unloadAfterAgentEditMilliseconds - now())
      : DECK_LIFECYCLE.unloadAfterMilliseconds;
    entry.unloadTimer = timers.schedule({
      delayMilliseconds,
      run: () => {
        entry.unloadTimer = null;
        if (entry.leases > 0 || entry.connections.size > 0) return;
        void unload(entry);
      },
    });
  }

  function unload(entry: RoomEntry): Promise<void> {
    const existing = unloading.get(entry.deckId);
    if (existing !== undefined) return existing;
    const run = async (): Promise<void> => {
      await flush(entry);
      if (entry.pending.length > 0) await flush(entry);
      entry.flushTimer?.[Symbol.dispose]();
      entry.unloadTimer?.[Symbol.dispose]();
      if (entries.get(entry.deckId) === entry) entries.delete(entry.deckId);
      entry.room[Symbol.dispose]();
    };
    const result = run().finally(() => unloading.delete(entry.deckId));
    unloading.set(entry.deckId, result);
    return result;
  }

  const leaseOf = (entry: RoomEntry): DeckLease => {
    entry.leases += 1;
    scheduleUnloadCheck(entry);
    let released = false;
    return {
      deck: loadedDeckOf(entry),
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        scheduleUnloadCheck(entry);
      },
    };
  };

  const loadedDeckOf = (entry: RoomEntry): LoadedDeck => ({
    deckId: entry.deckId,
    room: entry.room,
    record: () => {
      const record = records.get(entry.deckId);
      if (record === undefined) throw new Error(`deck ${entry.deckId}: a loaded deck lost its record`);
      return record;
    },
  });

  return {
    readRecord,
    updateRecord,
    createDeck: async ({ record }) => {
      await writeRecord(record);
      const entry = await ensureEntry(record.deckId, "blankDeck");
      if (entry === null) throw new Error(`deck ${record.deckId}: written but not loadable`);
      return leaseOf(entry);
    },
    acquire: async ({ deckId }) => {
      const entry = await ensureEntry(deckId, "stored");
      return entry === null ? null : leaseOf(entry);
    },
    loaded: ({ deckId }) => {
      const entry = entries.get(deckId);
      return entry === undefined || unloading.has(deckId) ? null : loadedDeckOf(entry);
    },
    connect: async ({ deckId, accountId, person, role, discussionAfter, port }) => {
      const entry = await ensureEntry(deckId, "stored");
      if (entry === null) return null;
      let connection: RoomConnection | null = null;
      const tracked: RoomConnectionPort = {
        send: port.send,
        close: (reason) => {
          if (connection !== null) entry.connections.delete(connection.id);
          port.close(reason);
          scheduleUnloadCheck(entry);
        },
      };
      connection = entry.room.connect({ person, role, discussionAfter, port: tracked });
      const opened = connection;
      entry.connections.set(opened.id, { accountId, connection: opened });
      return {
        ...opened,
        disconnect: () => {
          entry.connections.delete(opened.id);
          opened.disconnect();
          scheduleUnloadCheck(entry);
        },
      };
    },
    connectionsOf: ({ accountId }) =>
      [...entries.values()].flatMap((entry) =>
        [...entry.connections.values()].filter((tracked) => tracked.accountId === accountId).map((tracked) => ({ deckId: entry.deckId, connection: tracked.connection })),
      ),
    connectionsOfDeck: ({ deckId }) => [...(entries.get(deckId)?.connections.values() ?? [])],
    deleteDeck: async ({ deckId, reason }) => {
      const entry = entries.get(deckId);
      if (entry !== undefined) {
        entry.room.closeAll(reason);
        entry.flushTimer?.[Symbol.dispose]();
        entry.unloadTimer?.[Symbol.dispose]();
        entry.pending.splice(0);
        entries.delete(deckId);
        entry.room[Symbol.dispose]();
      }
      records.delete(deckId);
      await storage.deleteDeck({ deckId });
      await storage.updateIndex((index) => ({ version: 1, decks: Object.fromEntries(Object.entries(index.decks).filter(([candidate]) => candidate !== deckId)) }));
    },
    flushAll: async () => {
      for (const entry of [...entries.values()]) await flush(entry);
    },
    shutdown: async () => {
      for (const entry of [...entries.values()]) entry.room.closeAll("serverShuttingDown");
      for (const entry of [...entries.values()]) await unload(entry);
    },
  };
}

/** How often the record's "edited" time is refreshed while a deck is being edited. */
const RECORD_TOUCH_INTERVAL_MILLISECONDS = 60_000;

/** Mutable on purpose: the registry's own bookkeeping for one loaded room, never handed out. */
type RoomEntry = {
  readonly deckId: DeckId;
  readonly ownerAccountId: AccountId;
  room: DeckRoom;
  readonly pending: Uint8Array[];
  sequence: number;
  logSize: LogSize;
  flushTimer: Disposable | null;
  flushing: Promise<void> | null;
  failingSince: number | null;
  retryDelay: number;
  leases: number;
  readonly connections: Map<number, Readonly<{ accountId: AccountId; connection: RoomConnection }>>;
  unloadTimer: Disposable | null;
  lastRecordTouch: number;
};

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
