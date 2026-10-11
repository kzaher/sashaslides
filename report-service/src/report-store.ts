// THE STORE: one file per report, plus an append-only index, on a plain filesystem.
//
// NO DATABASE, and the layout is chosen so that not having one costs nothing:
//
//   <dataDir>/reports/<2-char shard>/<id>.json   the report, written once, never rewritten
//   <dataDir>/index.jsonl                        an append-only log of what exists
//   <dataDir>/incoming/<id>.json.part            the staging name a write passes through
//
// WHY THE INDEX IS A LOG AND NOT A FILE THAT GETS REWRITTEN. A submission appends one line and a
// deletion appends one line; nothing ever edits a line in place. Replaying the log gives the
// current set, so a crash midway through anything leaves a readable index -- the worst case is a
// trailing partial line, which the replay counts and skips. Compaction (during the retention
// sweep) writes a fresh log to a `.part` file and renames it over the old one, which is atomic on
// a POSIX filesystem.
//
// WHY A REPORT FILE IS WRITTEN TO `incoming/` AND RENAMED. A reader must never see half a report.
// `rename(2)` within one filesystem is atomic, so the file either is not there or is complete. The
// index line is appended only AFTER the rename succeeds, so the index can never name a file that
// does not exist. The reverse failure -- a report file with no index line -- is possible if the
// process dies in that window, and is handled by `sweep`, which reports such files as orphans.
//
// WHAT THE INDEX DOES NOT CONTAIN: any part of the submission. Only sizes, hashes, timestamps and
// version strings. This is deliberate and load-bearing for the HTTP layer: `find` returns an index
// entry, there is no function here that returns the submitted HTML, and so there is no code path
// by which a request handler could echo it even by mistake. Reading a report's content is an
// operator action done with `cat`, off the disk, outside this process.
//
// SINGLE PROCESS BY DESIGN. The write mutex is an in-process promise chain. Two instances of this
// service pointed at the same directory would interleave index appends; `O_APPEND` keeps lines
// whole for small writes but the duplicate-suppression map and the byte accounting would diverge.
// If this ever needs to scale out, the index has to move to something with a real lock -- see the
// README.

import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertNever } from "./assert-never.ts";
import { reportSizes, type DefectReport, type ReportVersions } from "./defect-report.ts";
import {
  newDeletionToken,
  newReportId,
  parseReportId,
  type DeletionToken,
  type RandomBytes,
  type ReportId,
} from "./report-id.ts";

/**
 * Everything the service knows about a stored report without opening its file. This is also
 * exactly the receipt `GET /v1/reports/:id` renders, which is why it holds no content.
 */
export type ReportIndexEntry = Readonly<{
  id: ReportId;
  receivedAt: string;
  clientReportedAt: string;
  /** Size of the stored JSON file, which is what counts against the disk budget. */
  storedBytes: number;
  htmlBytes: number;
  converterOutputBytes: number;
  noteBytes: number;
  versions: ReportVersions;
  /** SHA-256 of the canonical payload, used to collapse duplicate submissions. */
  contentHash: string;
  /** SHA-256 of the deletion token. The token itself is never stored. */
  deletionTokenHash: string;
}>;

export type SubmitOutcome =
  | Readonly<{ kind: "stored"; entry: ReportIndexEntry; deletionToken: DeletionToken }>
  /** Byte-identical to something already held. Returns the original id; writes nothing. */
  | Readonly<{ kind: "duplicate"; entry: ReportIndexEntry }>
  | Readonly<{ kind: "capacity-exhausted"; limit: CapacityLimit }>
  | Readonly<{ kind: "write-failed"; detail: string }>;

export type CapacityLimit = "report-count" | "total-bytes";

export type RemoveOutcome =
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "token-mismatch" }>
  | Readonly<{ kind: "remove-failed"; detail: string }>;

export type SweepOutcome = Readonly<{
  expired: number;
  orphanFiles: number;
  compacted: boolean;
}>;

export type StoreStats = Readonly<{
  reportCount: number;
  totalBytes: number;
  /** Index lines that did not parse during replay. Non-zero is worth an operator's attention. */
  unreadableIndexLines: number;
}>;

export type StoreLimits = Readonly<{
  maxReports: number;
  maxTotalBytes: number;
  retentionDays: number;
}>;

export type ReportStore = Readonly<{
  submit: (options: Readonly<{ report: DefectReport; receivedAt: Date }>) => Promise<SubmitOutcome>;
  find: (id: ReportId) => ReportIndexEntry | null;
  remove: (options: Readonly<{ id: ReportId; deletionToken: DeletionToken }>) => Promise<RemoveOutcome>;
  sweep: (options: Readonly<{ now: Date }>) => Promise<SweepOutcome>;
  stats: () => StoreStats;
}>;

/**
 * Creates the directory layout if it is absent and replays the index. Every dependency the store
 * uses -- the directory, the limits, the entropy source -- is passed in; it reaches for nothing.
 */
export async function openReportStore(options: {
  dataDir: string;
  limits: StoreLimits;
  randomBytes: RandomBytes;
}): Promise<ReportStore> {
  const paths = storePathsFor(options.dataDir);
  await mkdir(paths.reportsDir, { recursive: true });
  await mkdir(paths.incomingDir, { recursive: true });

  const replayed = await replayIndex(paths.indexPath);
  const entries = replayed.entries;
  const byContentHash = new Map<string, ReportId>();
  for (const entry of entries.values()) byContentHash.set(entry.contentHash, entry.id);

  let totalBytes = 0;
  for (const entry of entries.values()) totalBytes += entry.storedBytes;
  let unreadableIndexLines = replayed.unreadableLines;

  // Serialises every mutation, so the index, the byte total and the duplicate map can never be
  // observed half-updated by a concurrently handled request.
  let writeQueue: Promise<unknown> = Promise.resolve();
  const serialise = <TResult>(work: () => Promise<TResult>): Promise<TResult> => {
    const result = writeQueue.then(work, work);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const stats = (): StoreStats => ({ reportCount: entries.size, totalBytes, unreadableIndexLines });

  const submit = async ({ report, receivedAt }: Readonly<{ report: DefectReport; receivedAt: Date }>) =>
    serialise(async (): Promise<SubmitOutcome> => {
      const contentHash = contentHashOf(report);
      const existingId = byContentHash.get(contentHash);
      if (existingId !== undefined) {
        const existing = entries.get(existingId);
        if (existing !== undefined) return { kind: "duplicate", entry: existing };
      }

      if (entries.size >= options.limits.maxReports) {
        return { kind: "capacity-exhausted", limit: "report-count" };
      }

      const id = freshId({ randomBytes: options.randomBytes, taken: entries });
      const deletionToken = newDeletionToken({ randomBytes: options.randomBytes });
      const sizes = reportSizes(report);
      const body = `${JSON.stringify(
        {
          id,
          receivedAt: receivedAt.toISOString(),
          contentHash,
          report,
        },
        null,
        2,
      )}\n`;
      const storedBytes = Buffer.byteLength(body, "utf8");
      if (totalBytes + storedBytes > options.limits.maxTotalBytes) {
        return { kind: "capacity-exhausted", limit: "total-bytes" };
      }

      const entry: ReportIndexEntry = {
        id,
        receivedAt: receivedAt.toISOString(),
        clientReportedAt: report.clientReportedAt,
        storedBytes,
        htmlBytes: sizes.htmlBytes,
        converterOutputBytes: sizes.converterOutputBytes,
        noteBytes: sizes.noteBytes,
        versions: report.versions,
        contentHash,
        deletionTokenHash: sha256Hex(deletionToken),
      };

      const written = await writeReportFile({ paths, id, body });
      if (written.kind === "failed") return { kind: "write-failed", detail: written.detail };

      const appended = await appendIndexRecord({ indexPath: paths.indexPath, record: { kind: "stored", entry } });
      if (appended.kind === "failed") {
        // The file landed but the index did not. Roll the file back rather than leave an orphan
        // that only `sweep` would ever notice.
        await rm(reportPathFor({ paths, id }), { force: true });
        return { kind: "write-failed", detail: appended.detail };
      }

      entries.set(id, entry);
      byContentHash.set(contentHash, id);
      totalBytes += storedBytes;
      return { kind: "stored", entry, deletionToken };
    });

  const find = (id: ReportId): ReportIndexEntry | null => entries.get(id) ?? null;

  const remove = async ({ id, deletionToken }: Readonly<{ id: ReportId; deletionToken: DeletionToken }>) =>
    serialise(async (): Promise<RemoveOutcome> => {
      const entry = entries.get(id);
      if (entry === undefined) return { kind: "not-found" };
      if (!digestsMatch({ left: entry.deletionTokenHash, right: sha256Hex(deletionToken) })) {
        return { kind: "token-mismatch" };
      }
      const forgotten = await forget({ paths, entry, at: new Date() });
      if (forgotten.kind === "failed") return { kind: "remove-failed", detail: forgotten.detail };
      entries.delete(id);
      byContentHash.delete(entry.contentHash);
      totalBytes -= entry.storedBytes;
      return { kind: "removed" };
    });

  const sweep = async ({ now }: Readonly<{ now: Date }>) =>
    serialise(async (): Promise<SweepOutcome> => {
      const cutoff = now.getTime() - options.limits.retentionDays * 24 * 60 * 60 * 1000;
      let expired = 0;
      for (const entry of [...entries.values()]) {
        if (Date.parse(entry.receivedAt) > cutoff) continue;
        const forgotten = await forget({ paths, entry, at: now });
        if (forgotten.kind === "failed") continue;
        entries.delete(entry.id);
        byContentHash.delete(entry.contentHash);
        totalBytes -= entry.storedBytes;
        expired += 1;
      }
      const orphanFiles = await countOrphanFiles({ paths, known: entries });
      const compacted = await compactIndex({ paths, entries });
      if (compacted) unreadableIndexLines = 0;
      return { expired, orphanFiles, compacted };
    });

  return Object.freeze({ submit, find, remove, sweep, stats });
}

type StorePaths = Readonly<{
  reportsDir: string;
  incomingDir: string;
  indexPath: string;
}>;

function storePathsFor(dataDir: string): StorePaths {
  return {
    reportsDir: join(dataDir, "reports"),
    incomingDir: join(dataDir, "incoming"),
    indexPath: join(dataDir, "index.jsonl"),
  };
}

/**
 * `id` is a `ReportId`, so its alphabet contains no separator and no dot -- the join below cannot
 * escape `reportsDir`. The shard keeps any one directory to a few hundred entries at the default
 * report cap, which matters on filesystems that walk directories linearly.
 */
function reportPathFor(options: Readonly<{ paths: StorePaths; id: ReportId }>): string {
  const shard = options.id.slice(4, 6);
  return join(options.paths.reportsDir, shard, `${options.id}.json`);
}

type FileWrite = Readonly<{ kind: "ok" }> | Readonly<{ kind: "failed"; detail: string }>;

async function writeReportFile(
  options: Readonly<{ paths: StorePaths; id: ReportId; body: string }>,
): Promise<FileWrite> {
  const finalPath = reportPathFor({ paths: options.paths, id: options.id });
  const stagingPath = join(options.paths.incomingDir, `${options.id}.json.part`);
  try {
    await mkdir(dirname(finalPath), { recursive: true });
    // `wx` fails rather than truncating if the name somehow already exists, which would mean the
    // id generator collided and is a bug worth surfacing, not overwriting.
    await writeFile(stagingPath, options.body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(stagingPath, finalPath);
    return { kind: "ok" };
  } catch (caught) {
    await rm(stagingPath, { force: true });
    return { kind: "failed", detail: describeError(caught) };
  }
}

async function forget(
  options: Readonly<{ paths: StorePaths; entry: ReportIndexEntry; at: Date }>,
): Promise<FileWrite> {
  try {
    await rm(reportPathFor({ paths: options.paths, id: options.entry.id }), { force: true });
  } catch (caught) {
    return { kind: "failed", detail: describeError(caught) };
  }
  return appendIndexRecord({
    indexPath: options.paths.indexPath,
    record: { kind: "removed", id: options.entry.id, at: options.at.toISOString() },
  });
}

/**
 * One line of the index. A union rather than a mutable row so that replay is a fold and adding a
 * third kind of event fails to compile at the replay switch.
 */
type IndexRecord =
  | Readonly<{ kind: "stored"; entry: ReportIndexEntry }>
  | Readonly<{ kind: "removed"; id: ReportId; at: string }>;

async function appendIndexRecord(
  options: Readonly<{ indexPath: string; record: IndexRecord }>,
): Promise<FileWrite> {
  try {
    // One `write` of one line under `O_APPEND`: the kernel will not interleave it with another
    // append, so a line is never torn even though nothing here locks the file.
    await appendFile(options.indexPath, `${JSON.stringify(options.record)}\n`, { encoding: "utf8", mode: 0o600 });
    return { kind: "ok" };
  } catch (caught) {
    return { kind: "failed", detail: describeError(caught) };
  }
}

async function replayIndex(
  indexPath: string,
): Promise<Readonly<{ entries: Map<ReportId, ReportIndexEntry>; unreadableLines: number }>> {
  const entries = new Map<ReportId, ReportIndexEntry>();
  const raw = await readFileOrNull(indexPath);
  if (raw === null) return { entries, unreadableLines: 0 };

  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseIndexRecord(line);
    if (record === null) {
      unreadableLines += 1;
      continue;
    }
    switch (record.kind) {
      case "stored":
        entries.set(record.entry.id, record.entry);
        break;
      case "removed":
        entries.delete(record.id);
        break;
      default:
        assertNever(record);
    }
  }
  return { entries, unreadableLines };
}

/**
 * The index is this service's own file, but it is still a file on a disk somebody else can touch,
 * so it is parsed rather than cast. An unreadable line is dropped and counted; it is never guessed
 * at, because a half-read entry would corrupt the byte accounting the disk cap depends on.
 */
function parseIndexRecord(line: string): IndexRecord | null {
  const parsed = parseJsonObject(line);
  if (parsed === null) return null;
  const kind = parsed["kind"];
  if (kind === "removed") {
    const id = parseReportId(stringOrEmpty(parsed["id"]));
    const at = parsed["at"];
    if (id === null || typeof at !== "string") return null;
    return { kind: "removed", id, at };
  }
  if (kind !== "stored") return null;
  const entry = parseIndexEntry(parsed["entry"]);
  if (entry === null) return null;
  return { kind: "stored", entry };
}

function parseIndexEntry(candidate: unknown): ReportIndexEntry | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const record = candidate as Readonly<Record<string, unknown>>;
  const id = parseReportId(stringOrEmpty(record["id"]));
  const receivedAt = record["receivedAt"];
  const clientReportedAt = record["clientReportedAt"];
  const contentHash = record["contentHash"];
  const deletionTokenHash = record["deletionTokenHash"];
  const storedBytes = integerOrNull(record["storedBytes"]);
  const htmlBytes = integerOrNull(record["htmlBytes"]);
  const converterOutputBytes = integerOrNull(record["converterOutputBytes"]);
  const noteBytes = integerOrNull(record["noteBytes"]);
  const versions = parseVersions(record["versions"]);
  if (id === null || versions === null) return null;
  if (typeof receivedAt !== "string" || typeof clientReportedAt !== "string") return null;
  if (typeof contentHash !== "string" || typeof deletionTokenHash !== "string") return null;
  if (storedBytes === null || htmlBytes === null || converterOutputBytes === null || noteBytes === null) return null;
  return {
    id,
    receivedAt,
    clientReportedAt,
    storedBytes,
    htmlBytes,
    converterOutputBytes,
    noteBytes,
    versions,
    contentHash,
    deletionTokenHash,
  };
}

function parseVersions(candidate: unknown): ReportVersions | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const record = candidate as Readonly<Record<string, unknown>>;
  const addon = record["addon"];
  const converter = record["converter"];
  const protocol = integerOrNull(record["protocol"]);
  if (typeof addon !== "string" || typeof converter !== "string" || protocol === null) return null;
  return { addon, converter, protocol };
}

function parseJsonObject(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function compactIndex(
  options: Readonly<{ paths: StorePaths; entries: Map<ReportId, ReportIndexEntry> }>,
): Promise<boolean> {
  const stagingPath = `${options.paths.indexPath}.part`;
  const lines = [...options.entries.values()].map((entry) =>
    JSON.stringify({ kind: "stored", entry } satisfies IndexRecord),
  );
  try {
    await writeFile(stagingPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(stagingPath, options.paths.indexPath);
    return true;
  } catch {
    await rm(stagingPath, { force: true });
    return false;
  }
}

/**
 * Report files with no index line: the crash window between `rename` and the index append. They
 * are counted, not deleted -- a file holding a user's report is not something a background task
 * should remove on a guess.
 */
async function countOrphanFiles(
  options: Readonly<{ paths: StorePaths; known: Map<ReportId, ReportIndexEntry> }>,
): Promise<number> {
  let orphans = 0;
  const shards = await readdirOrEmpty(options.paths.reportsDir);
  for (const shard of shards) {
    for (const name of await readdirOrEmpty(join(options.paths.reportsDir, shard))) {
      const id = parseReportId(name.replace(/\.json$/, ""));
      if (id === null || !options.known.has(id)) orphans += 1;
    }
  }
  return orphans;
}

async function readdirOrEmpty(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** `readFile` owns the descriptor for the whole call, so there is no handle to scope-bind here. */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, { encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * Hashes the fields that make two submissions the same report, in a fixed order. `clientReportedAt`
 * is excluded on purpose: a retry of the same evidence a second later is the same report, and
 * including the timestamp would defeat the duplicate suppression that bounds a retry loop's cost.
 */
function contentHashOf(report: DefectReport): string {
  return sha256Hex(
    JSON.stringify([
      report.schemaVersion,
      report.note,
      report.document.html,
      report.converterOutput.format,
      report.converterOutput.text,
      report.versions.addon,
      report.versions.converter,
      report.versions.protocol,
    ]),
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant time, so a wrong deletion token leaks nothing about the right one through timing. */
function digestsMatch(options: Readonly<{ left: string; right: string }>): boolean {
  const left = Buffer.from(options.left, "utf8");
  const right = Buffer.from(options.right, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function freshId(options: Readonly<{ randomBytes: RandomBytes; taken: Map<ReportId, ReportIndexEntry> }>): ReportId {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newReportId({ randomBytes: options.randomBytes });
    if (!options.taken.has(id)) return id;
  }
  throw new Error("report id generator produced eight collisions; the entropy source is broken");
}

function describeError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "unknown filesystem error";
}
