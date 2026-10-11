/**
 * A local filesystem stand-in for the Drive staging area.
 *
 * It exists so the whole protocol loop — layout, appProperties, write ordering, PICK
 * round-trip, cleanup — can be asserted with no Google credentials at all, and so the
 * harness's own assertions are exercised before they are ever pointed at real Drive.
 *
 * It persists to disk rather than to memory because each harness phase is independently
 * runnable as its own process (the 30s command cap), so phase N+1 must see what phase N
 * wrote. The metadata index is one JSON file; file contents are blobs keyed by id.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StagedFile } from "./staged-file.ts";
import { rankByCreation } from "./staged-file.ts";
import type { StagingDrive } from "./staging-drive.ts";
import { FOLDER_MIME } from "./protocol-records.ts";

export function fakeStagingDrive(options: Readonly<{ root: string }>): StagingDrive {
  const root = options.root;
  const blobsDir = join(root, "blobs");
  const indexPath = join(root, "index.json");
  mkdirSync(blobsDir, { recursive: true });

  return {
    describe: `fake drive at ${root}`,

    async findFolder({ name, parentId }) {
      const match = loadIndex(indexPath).find(
        (entry) => entry.mimeType === FOLDER_MIME && entry.name === name && entry.parentId === parentId,
      );
      return match === undefined ? null : toStagedFile(match);
    },

    async createFolder({ name, parentId, appProperties }) {
      return toStagedFile(
        append({ indexPath, name, parentId, mimeType: FOLDER_MIME, appProperties }),
      );
    },

    async createFile({ name, parentId, mimeType, content, appProperties }) {
      const entry = append({ indexPath, name, parentId, mimeType, appProperties });
      writeFileSync(join(blobsDir, entry.id), content, "utf-8");
      return toStagedFile(entry);
    },

    async listChildren({ parentId }) {
      const children = loadIndex(indexPath)
        .filter((entry) => entry.parentId === parentId)
        .map(toStagedFileWithoutRank);
      return rankByCreation(children);
    },

    async readFile({ id }) {
      const blob = join(blobsDir, id);
      if (!existsSync(blob)) throw new Error(`fake drive: no content for file id ${id}`);
      return readFileSync(blob, "utf-8");
    },

    async deleteFile({ id }) {
      const index = loadIndex(indexPath);
      const doomed = collectSubtree({ index, rootId: id });
      if (doomed.size === 0) throw new Error(`fake drive: no such file id ${id}`);
      for (const doomedId of doomed) rmSync(join(blobsDir, doomedId), { force: true });
      saveIndex(indexPath, index.filter((entry) => !doomed.has(entry.id)));
    },
  };
}

type IndexEntry = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  mimeType: string;
  appProperties: Readonly<Record<string, string>>;
  createdAtMs: number;
}>;

function append(
  options: Readonly<{
    indexPath: string;
    name: string;
    parentId: string | null;
    mimeType: string;
    appProperties: Readonly<Record<string, string>>;
  }>,
): IndexEntry {
  const index = loadIndex(options.indexPath);
  // Strictly increasing so write order is never ambiguous: a local fake does know the
  // order it was called in, and a tie here would be the harness lying to itself.
  const latest = index.reduce((highest, entry) => Math.max(highest, entry.createdAtMs), 0);
  const entry: IndexEntry = {
    id: `fake_${index.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
    name: options.name,
    parentId: options.parentId,
    mimeType: options.mimeType,
    appProperties: options.appProperties,
    createdAtMs: Math.max(Date.now(), latest + 1),
  };
  saveIndex(options.indexPath, [...index, entry]);
  return entry;
}

function collectSubtree(options: Readonly<{ index: readonly IndexEntry[]; rootId: string }>): Set<string> {
  const found = new Set<string>();
  if (!options.index.some((entry) => entry.id === options.rootId)) return found;
  found.add(options.rootId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of options.index) {
      if (entry.parentId !== null && found.has(entry.parentId) && !found.has(entry.id)) {
        found.add(entry.id);
        grew = true;
      }
    }
  }
  return found;
}

function loadIndex(indexPath: string): readonly IndexEntry[] {
  if (!existsSync(indexPath)) return [];
  // The fake writes this file itself, so its shape is an internal invariant rather than
  // untrusted input; a malformed index means a harness bug and should throw.
  const parsed: unknown = JSON.parse(readFileSync(indexPath, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error(`fake drive: ${indexPath} is not an array`);
  return parsed as readonly IndexEntry[];
}

function saveIndex(indexPath: string, index: readonly IndexEntry[]): void {
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

function toStagedFileWithoutRank(entry: IndexEntry): Omit<StagedFile, "writeSeq"> {
  return {
    id: entry.id,
    name: entry.name,
    mimeType: entry.mimeType,
    appProperties: entry.appProperties,
    createdAtMs: entry.createdAtMs,
  };
}

/** For single-file returns there are no siblings to rank against, so the rank is 0. */
function toStagedFile(entry: IndexEntry): StagedFile {
  return { ...toStagedFileWithoutRank(entry), writeSeq: 0 };
}
