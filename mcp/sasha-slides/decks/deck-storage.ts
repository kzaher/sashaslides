/**
 * Where decks live between loads (SPEC.md 21.7): one directory per deck under `/data/decks`, every
 * record sealed with the OWNER's data key (`account-keys.ts`), so "delete my data" makes an
 * owner's decks unreadable and the eraser then removes them.
 *
 *   index.json                 DeckIndex: no personal data in the clear; atomic write, mode 0600
 *   <deckId>/deck.sealed       DeckRecord, sealed JSON
 *   <deckId>/document.snapshot "sasha-deck-snapshot 1 <throughSequence>" + newline + sealed state
 *   <deckId>/document.log      one line per flush: "<sequence> <sealed update>"
 *   <deckId>/discussion.log    one line per entry: "<sequence> <sealed DiscussionLogEntry JSON>"
 *   <deckId>/assets/<sha256>   "<mediaType> <byteLength>" + newline + sealed bytes
 *   ../deck-profiles/<accountId>.sealed   the display name, sealed under that account's own key
 *
 * Key decisions:
 *
 *  - BYTES ARE SEALED AS BASE64URL TEXT, because `AccountVault.seal` takes text.
 *  - APPEND, THEN FSYNC. A log append is one write on a file opened for appending, then `fsync`,
 *    so a flush the caller saw succeed survives a power cut.
 *  - COMPACTION IS TWO CRASH-SAFE RENAMES: the snapshot is written to `.tmp`, fsynced and renamed
 *    over the old one; then the log is replaced by an empty one the same way. A crash between the
 *    two leaves the new snapshot and the old log, and applying a log record the snapshot already
 *    contains changes nothing (Yjs updates are idempotent), so the deck reloads identically.
 *  - A CORRUPT RECORD IS SKIPPED, NEVER FATAL: a line that does not parse, open or decode is
 *    reported with the deck and its sequence, and loading carries on with the rest.
 *  - THE INDEX FILE REFUSES TO LOAD RATHER THAN START EMPTY when it is unreadable, because the next
 *    write would forget every deck (the same rule as the key store).
 *
 * `memoryDeckStorage` keeps the same shapes in memory, unsealed, for tests and for
 * `memory-deck-service.ts`.
 */
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscussionLogEntry } from "../engine/src/contracts/discussion.ts";
import type { AssetMediaType } from "../engine/src/contracts/document.ts";
import { parseAssetId, type AssetId, type DeckId } from "../engine/src/contracts/ids.ts";
import { parseDiscussionLogEntry } from "./deck-wire-values";
import type { AccountId, AccountVault } from "../http/account-vault";
import { EMPTY_DECK_INDEX, parseDeckIndex, parseDeckRecord, type DeckIndex, type DeckRecord } from "./deck-records";

export type DeckStorage = Readonly<{
  /** Where it keeps decks, for the startup banner. */
  description: string;
  readIndex(): DeckIndex;
  /** Applies `change` to the index and writes it (serialised: concurrent changes never lose one another). */
  updateIndex(change: (index: DeckIndex) => DeckIndex): Promise<void>;
  /** Null when the record is missing, does not open (the owner's key was reset) or does not parse. */
  readRecord(options: Readonly<{ deckId: DeckId; ownerAccountId: AccountId }>): Promise<DeckRecord | null>;
  writeRecord(record: DeckRecord): Promise<void>;
  loadDocument(options: DeckLocation): Promise<StoredDocument>;
  /** Appends one record; resolves with what it added to the log (the caller keeps the running size). */
  appendDocument(options: DeckLocation & Readonly<{ sequence: number; update: Uint8Array }>): Promise<LogSize>;
  /** Replaces snapshot and log with `state` (see the header). */
  compactDocument(options: DeckLocation & Readonly<{ state: Uint8Array; throughSequence: number }>): Promise<void>;
  loadDiscussion(options: DeckLocation): Promise<readonly DiscussionLogEntry[]>;
  appendDiscussion(options: DeckLocation & Readonly<{ entry: DiscussionLogEntry }>): Promise<void>;
  putAsset(options: DeckLocation & Readonly<{ assetId: AssetId; mediaType: AssetMediaType; bytes: Uint8Array }>): Promise<void>;
  readAsset(options: DeckLocation & Readonly<{ assetId: AssetId }>): Promise<StoredAsset | null>;
  assetUsage(options: Readonly<{ deckId: DeckId }>): Promise<AssetUsage>;
  deleteDeck(options: Readonly<{ deckId: DeckId }>): Promise<void>;
  readProfile(options: Readonly<{ accountId: AccountId }>): Promise<string | null>;
  writeProfile(options: Readonly<{ accountId: AccountId; displayName: string }>): Promise<void>;
  deleteProfile(options: Readonly<{ accountId: AccountId }>): Promise<void>;
}>;

export type DeckLocation = Readonly<{ deckId: DeckId; ownerAccountId: AccountId }>;

export type StoredDocument = Readonly<{
  /** The snapshot (when there is one) first, then every log record, in order. */
  updates: readonly Uint8Array[];
  /** The highest sequence on disk; the next flush appends `lastSequence + 1`. */
  lastSequence: number;
  logSize: LogSize;
}>;

/** How big `document.log` is, for the compaction thresholds. */
export type LogSize = Readonly<{ records: number; bytes: number }>;

export type StoredAsset = Readonly<{ mediaType: AssetMediaType; bytes: Uint8Array }>;
export type AssetUsage = Readonly<{ count: number; bytes: number; assetIds: readonly AssetId[] }>;

export type DeckStorageLoad = Readonly<{ kind: "ok"; storage: DeckStorage }> | Readonly<{ kind: "failed"; message: string }>;

export function openFileDeckStorage(
  options: Readonly<{ decksDirectory: string; profilesDirectory: string; vault: AccountVault; warn: (message: string) => void }>,
): DeckStorageLoad {
  const { decksDirectory, profilesDirectory, vault, warn } = options;
  const indexPath = join(decksDirectory, "index.json");
  const loaded = loadIndex(indexPath);
  if (loaded.kind === "failed") return loaded;
  let index = loaded.index;
  let indexTail: Promise<unknown> = Promise.resolve();
  const deckDirectory = (deckId: DeckId): string => join(decksDirectory, deckId);

  const seal = (accountId: AccountId, plaintext: string): Promise<string> => vault.seal({ accountId, plaintext });
  const openSealed = (accountId: AccountId, sealed: string): Promise<string | null> => vault.open({ accountId, sealed });

  const storage: DeckStorage = {
    description: decksDirectory,
    readIndex: () => index,
    updateIndex: (change) => {
      const run = async (): Promise<void> => {
        const next = change(index);
        await mkdir(decksDirectory, { recursive: true, mode: 0o700 });
        await writeAtomically({ path: indexPath, text: `${JSON.stringify(next, null, 2)}\n` });
        index = next;
      };
      const result = indexTail.then(run, run);
      indexTail = result.catch(() => undefined);
      return result;
    },
    readRecord: async ({ deckId, ownerAccountId }) => {
      const text = await readIfExists(join(deckDirectory(deckId), "deck.sealed"));
      if (text === null) return null;
      const opened = await openSealed(ownerAccountId, text.trim());
      if (opened === null) return null;
      const record = parseDeckRecord(parseStoredText(opened));
      if (record === null) warn(`deck ${deckId}: deck.sealed opens but does not parse`);
      return record;
    },
    writeRecord: async (record) => {
      await mkdir(deckDirectory(record.deckId), { recursive: true, mode: 0o700 });
      await writeAtomically({ path: join(deckDirectory(record.deckId), "deck.sealed"), text: `${await seal(record.ownerAccountId, JSON.stringify(record))}\n` });
    },
    loadDocument: async ({ deckId, ownerAccountId }) => {
      const updates: Uint8Array[] = [];
      let lastSequence = 0;
      const snapshot = await readIfExists(join(deckDirectory(deckId), "document.snapshot"));
      if (snapshot !== null) {
        const [header, sealed] = snapshot.split("\n");
        const match = SNAPSHOT_HEADER.exec(header ?? "");
        const opened = match === null || sealed === undefined ? null : await openSealed(ownerAccountId, sealed.trim());
        if (match === null || opened === null) warn(`deck ${deckId}: document.snapshot does not open; loading the log alone`);
        else {
          lastSequence = Number(match[1]);
          updates.push(Buffer.from(opened, "base64url"));
        }
      }
      const log = await readIfExists(join(deckDirectory(deckId), "document.log"));
      let records = 0;
      for (const [lineNumber, line] of (log ?? "").split("\n").entries()) {
        if (line.trim() === "") continue;
        records += 1;
        const parsed = parseLogLine(line);
        if (parsed === null) {
          warn(`deck ${deckId}: document.log line ${String(lineNumber + 1)} is not a record; skipped`);
          continue;
        }
        const opened = await openSealed(ownerAccountId, parsed.sealed);
        if (opened === null) {
          warn(`deck ${deckId}: document.log sequence ${String(parsed.sequence)} does not open; skipped`);
          continue;
        }
        lastSequence = Math.max(lastSequence, parsed.sequence);
        updates.push(Buffer.from(opened, "base64url"));
      }
      return { updates, lastSequence, logSize: { records, bytes: Buffer.byteLength(log ?? "", "utf-8") } };
    },
    appendDocument: async ({ deckId, ownerAccountId, sequence, update }) => {
      await mkdir(deckDirectory(deckId), { recursive: true, mode: 0o700 });
      const line = `${String(sequence)} ${await seal(ownerAccountId, Buffer.from(update).toString("base64url"))}\n`;
      await appendDurably({ path: join(deckDirectory(deckId), "document.log"), text: line });
      return { records: 1, bytes: Buffer.byteLength(line, "utf-8") };
    },
    compactDocument: async ({ deckId, ownerAccountId, state, throughSequence }) => {
      const directory = deckDirectory(deckId);
      const sealed = await seal(ownerAccountId, Buffer.from(state).toString("base64url"));
      await writeAtomically({ path: join(directory, "document.snapshot"), text: `sasha-deck-snapshot 1 ${String(throughSequence)}\n${sealed}\n` });
      await writeAtomically({ path: join(directory, "document.log"), text: "" });
    },
    loadDiscussion: async ({ deckId, ownerAccountId }) => {
      const text = await readIfExists(join(deckDirectory(deckId), "discussion.log"));
      const entries: DiscussionLogEntry[] = [];
      for (const [lineNumber, line] of (text ?? "").split("\n").entries()) {
        if (line.trim() === "") continue;
        const parsed = parseLogLine(line);
        const opened = parsed === null ? null : await openSealed(ownerAccountId, parsed.sealed);
        const entry = opened === null ? null : parseDiscussionLogEntry(parseStoredText(opened));
        if (parsed === null || entry === null) {
          warn(`deck ${deckId}: discussion.log ${parsed === null ? `line ${String(lineNumber + 1)}` : `sequence ${String(parsed.sequence)}`} does not open; skipped`);
          continue;
        }
        entries.push(entry);
      }
      return entries;
    },
    appendDiscussion: async ({ deckId, ownerAccountId, entry }) => {
      await mkdir(deckDirectory(deckId), { recursive: true, mode: 0o700 });
      const line = `${String(entry.sequence)} ${await seal(ownerAccountId, JSON.stringify(entry))}\n`;
      await appendDurably({ path: join(deckDirectory(deckId), "discussion.log"), text: line });
    },
    putAsset: async ({ deckId, ownerAccountId, assetId, mediaType, bytes }) => {
      const directory = join(deckDirectory(deckId), "assets");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const sealed = await seal(ownerAccountId, Buffer.from(bytes).toString("base64url"));
      await writeAtomically({ path: join(directory, assetId), text: `${mediaType} ${String(bytes.length)}\n${sealed}\n` });
    },
    readAsset: async ({ deckId, ownerAccountId, assetId }) => {
      const text = await readIfExists(join(deckDirectory(deckId), "assets", assetId));
      if (text === null) return null;
      const [header, sealed] = text.split("\n");
      const [mediaType] = (header ?? "").split(" ");
      const parsedType = parseMediaType(mediaType ?? "");
      const opened = sealed === undefined ? null : await openSealed(ownerAccountId, sealed.trim());
      if (parsedType === null || opened === null) return null;
      return { mediaType: parsedType, bytes: Buffer.from(opened, "base64url") };
    },
    assetUsage: async ({ deckId }) => {
      const directory = join(deckDirectory(deckId), "assets");
      if (!existsSync(directory)) return { count: 0, bytes: 0, assetIds: [] };
      const assetIds: AssetId[] = [];
      let bytes = 0;
      for (const name of await readdir(directory)) {
        const assetId = parseAssetId(name);
        if (assetId === null) continue;
        const text = await readIfExists(join(directory, name));
        const declared = Number((text ?? "").split("\n")[0]?.split(" ")[1] ?? "0");
        bytes += Number.isFinite(declared) ? declared : 0;
        assetIds.push(assetId);
      }
      return { count: assetIds.length, bytes, assetIds };
    },
    deleteDeck: async ({ deckId }) => {
      await rm(deckDirectory(deckId), { recursive: true, force: true });
    },
    readProfile: async ({ accountId }) => {
      const text = await readIfExists(join(profilesDirectory, `${accountId}.sealed`));
      return text === null ? null : openSealed(accountId, text.trim());
    },
    writeProfile: async ({ accountId, displayName }) => {
      await mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
      await writeAtomically({ path: join(profilesDirectory, `${accountId}.sealed`), text: `${await seal(accountId, displayName)}\n` });
    },
    deleteProfile: async ({ accountId }) => {
      await rm(join(profilesDirectory, `${accountId}.sealed`), { force: true });
    },
  };
  return { kind: "ok", storage };
}

/** Tests and `memory-deck-service.ts`: the same behaviour, in memory, unsealed. */
export function memoryDeckStorage(): DeckStorage {
  let index: DeckIndex = EMPTY_DECK_INDEX;
  const records = new Map<DeckId, DeckRecord>();
  const documents = new Map<DeckId, { snapshot: Uint8Array | null; throughSequence: number; log: { sequence: number; update: Uint8Array }[] }>();
  const discussions = new Map<DeckId, DiscussionLogEntry[]>();
  const assets = new Map<DeckId, Map<AssetId, StoredAsset>>();
  const profiles = new Map<AccountId, string>();
  const documentOf = (deckId: DeckId) => {
    const existing = documents.get(deckId);
    if (existing !== undefined) return existing;
    const created = { snapshot: null, throughSequence: 0, log: [] };
    documents.set(deckId, created);
    return created;
  };
  const logSize = (deckId: DeckId): LogSize => {
    const log = documentOf(deckId).log;
    return { records: log.length, bytes: log.reduce((total, record) => total + record.update.length, 0) };
  };
  return {
    description: "in memory (lost on restart)",
    readIndex: () => index,
    updateIndex: (change) => {
      index = change(index);
      return Promise.resolve();
    },
    readRecord: ({ deckId }) => Promise.resolve(records.get(deckId) ?? null),
    writeRecord: (record) => {
      records.set(record.deckId, record);
      return Promise.resolve();
    },
    loadDocument: ({ deckId }) => {
      const document = documentOf(deckId);
      const updates = [...(document.snapshot === null ? [] : [document.snapshot]), ...document.log.map((record) => record.update)];
      const lastSequence = Math.max(document.throughSequence, ...document.log.map((record) => record.sequence));
      return Promise.resolve({ updates, lastSequence, logSize: logSize(deckId) });
    },
    appendDocument: ({ deckId, sequence, update }) => {
      documentOf(deckId).log.push({ sequence, update });
      return Promise.resolve({ records: 1, bytes: update.length });
    },
    compactDocument: ({ deckId, state, throughSequence }) => {
      const document = documentOf(deckId);
      document.snapshot = state;
      document.throughSequence = throughSequence;
      document.log = [];
      return Promise.resolve();
    },
    loadDiscussion: ({ deckId }) => Promise.resolve([...(discussions.get(deckId) ?? [])]),
    appendDiscussion: ({ deckId, entry }) => {
      discussions.set(deckId, [...(discussions.get(deckId) ?? []), entry]);
      return Promise.resolve();
    },
    putAsset: ({ deckId, assetId, mediaType, bytes }) => {
      const deckAssets = assets.get(deckId) ?? new Map<AssetId, StoredAsset>();
      deckAssets.set(assetId, { mediaType, bytes: Uint8Array.from(bytes) });
      assets.set(deckId, deckAssets);
      return Promise.resolve();
    },
    readAsset: ({ deckId, assetId }) => {
      const stored = assets.get(deckId)?.get(assetId);
      return Promise.resolve(stored === undefined ? null : { mediaType: stored.mediaType, bytes: Uint8Array.from(stored.bytes) });
    },
    assetUsage: ({ deckId }) => {
      const deckAssets = [...(assets.get(deckId) ?? new Map<AssetId, StoredAsset>()).entries()];
      return Promise.resolve({
        count: deckAssets.length,
        bytes: deckAssets.reduce((total, [, asset]) => total + asset.bytes.length, 0),
        assetIds: deckAssets.map(([assetId]) => assetId),
      });
    },
    deleteDeck: ({ deckId }) => {
      records.delete(deckId);
      documents.delete(deckId);
      discussions.delete(deckId);
      assets.delete(deckId);
      return Promise.resolve();
    },
    readProfile: ({ accountId }) => Promise.resolve(profiles.get(accountId) ?? null),
    writeProfile: ({ accountId, displayName }) => {
      profiles.set(accountId, displayName);
      return Promise.resolve();
    },
    deleteProfile: ({ accountId }) => {
      profiles.delete(accountId);
      return Promise.resolve();
    },
  };
}

export const ASSET_MEDIA_TYPES: readonly AssetMediaType[] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];

export function parseMediaType(candidate: string): AssetMediaType | null {
  return ASSET_MEDIA_TYPES.find((mediaType) => mediaType === candidate) ?? null;
}

const SNAPSHOT_HEADER = /^sasha-deck-snapshot 1 (\d+)$/u;

type IndexLoad = Readonly<{ kind: "ok"; index: DeckIndex }> | Readonly<{ kind: "failed"; message: string }>;

function loadIndex(path: string): IndexLoad {
  if (!existsSync(path)) return { kind: "ok", index: EMPTY_DECK_INDEX };
  const index = parseDeckIndex(parseStoredText(readFileSync(path, "utf-8")));
  if (index === null) return { kind: "failed", message: `${path} is not a version 1 deck index; refusing to start without it` };
  return { kind: "ok", index };
}

function parseLogLine(line: string): Readonly<{ sequence: number; sealed: string }> | null {
  const space = line.indexOf(" ");
  if (space <= 0) return null;
  const sequence = Number(line.slice(0, space));
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return { sequence, sealed: line.slice(space + 1).trim() };
}

function parseStoredText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
}

function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

/** One append on a file opened for appending, then fsync (see the header). */
async function appendDurably(options: Readonly<{ path: string; text: string }>): Promise<void> {
  const handle = await open(options.path, "a", 0o600);
  try {
    await handle.write(options.text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Temp file, fsync, rename over the target, fsync the directory: a crash leaves the old file or the new one. */
async function writeAtomically(options: Readonly<{ path: string; text: string }>): Promise<void> {
  const temporary = `${options.path}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.write(options.text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, options.path);
  const directory = await open(join(options.path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
