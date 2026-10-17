// TRIAGE: what the site owner decided about each report -- its status and their notes.
//
// IT IS NOT PART OF THE REPORT. A report file is written once and never rewritten (report-store.ts),
// and that property is worth keeping: the evidence a user sent stays byte for byte what they sent.
// So the owner's processing lives beside it, in its own append-only log:
//
//   <dataDir>/triage.jsonl     one line per status change, note or forgetting
//
// Replaying the log gives the current triage of every report, exactly as the index replay gives the
// current set of reports. A crash leaves at worst a trailing partial line, which replay counts and
// skips. `compact` rewrites the log through a `.part` file and a rename, keeping only reports the
// store still holds, so retention bounds this file as well.
//
// SINGLE PROCESS, like the store: the write queue is an in-process promise chain.

import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNever } from "./assert-never.ts";
import { parseReportId, type ReportId } from "./report-id.ts";

/** Where a report is in the owner's process. A closed set: every display and filter switches on it. */
export type ReportStatus = "new" | "triaged" | "fixed" | "wontfix";

/** In the order the owner moves a report through them, which is also the order the pages list them. */
export const REPORT_STATUSES: readonly ReportStatus[] = ["new", "triaged", "fixed", "wontfix"];

export type TriageNote = Readonly<{ at: string; by: string; text: string }>;

export type Triage = Readonly<{
  status: ReportStatus;
  /** Null until somebody changes the status; every report starts `new`. */
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  /** Oldest first. */
  notes: readonly TriageNote[];
}>;

export const UNTRIAGED: Triage = { status: "new", statusChangedAt: null, statusChangedBy: null, notes: [] };

export const TRIAGE_LIMITS = {
  noteBytes: 4 * 1024,
  /** The signed-in owner's address. RFC 5321 caps a path at 256; this is generous. */
  actorBytes: 320,
  notesPerReport: 200,
} as const;

export type TriageWrite =
  | Readonly<{ kind: "ok"; triage: Triage }>
  | Readonly<{ kind: "refused"; detail: string }>
  | Readonly<{ kind: "failed"; detail: string }>;

export type TriageLog = Readonly<{
  /** `UNTRIAGED` for a report nobody has touched. */
  get: (id: ReportId) => Triage;
  setStatus: (options: Readonly<{ id: ReportId; status: ReportStatus; by: string; at: Date }>) => Promise<TriageWrite>;
  addNote: (options: Readonly<{ id: ReportId; text: string; by: string; at: Date }>) => Promise<TriageWrite>;
  /** Drops a report's triage, when the report itself is deleted. */
  forget: (options: Readonly<{ id: ReportId; at: Date }>) => Promise<TriageWrite>;
  /** Rewrites the log with only the reports `keep` accepts. True when the rewrite landed. */
  compact: (options: Readonly<{ keep: (id: ReportId) => boolean }>) => Promise<boolean>;
  /** Log lines that did not parse during replay. */
  unreadableLines: () => number;
}>;

/** Parse-boundary guard: the input is a form field or a log line, so a new status is added by hand. */
export function parseReportStatus(candidate: string): ReportStatus | null {
  if (candidate === "new" || candidate === "triaged" || candidate === "fixed" || candidate === "wontfix") return candidate;
  return null;
}

/** How a status reads on a page. Exhaustive, so a new status cannot render as nothing. */
export function describeStatus(status: ReportStatus): string {
  switch (status) {
    case "new":
      return "New";
    case "triaged":
      return "Triaged";
    case "fixed":
      return "Fixed";
    case "wontfix":
      return "Won't fix";
    default:
      return assertNever(status);
  }
}

type TriageEvent =
  | Readonly<{ kind: "status"; id: ReportId; at: string; by: string; status: ReportStatus }>
  | Readonly<{ kind: "note"; id: ReportId; at: string; by: string; text: string }>
  | Readonly<{ kind: "forgotten"; id: ReportId; at: string }>;

export async function openTriageLog(options: Readonly<{ dataDir: string }>): Promise<TriageLog> {
  const logPath = join(options.dataDir, "triage.jsonl");
  const replayed = await replay(logPath);
  const triages = replayed.triages;
  let unreadable = replayed.unreadableLines;

  let writeQueue: Promise<unknown> = Promise.resolve();
  const serialise = <TResult>(work: () => Promise<TResult>): Promise<TResult> => {
    const result = writeQueue.then(work, work);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const record = (event: TriageEvent): Promise<TriageWrite> =>
    serialise(async (): Promise<TriageWrite> => {
      try {
        await appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (caught) {
        return { kind: "failed", detail: caught instanceof Error ? caught.message : "unknown filesystem error" };
      }
      apply({ triages, event });
      return { kind: "ok", triage: triages.get(event.id) ?? UNTRIAGED };
    });

  const actorProblem = (by: string): string | null =>
    by === "" || Buffer.byteLength(by, "utf8") > TRIAGE_LIMITS.actorBytes ? "the actor must be a signed-in address" : null;

  return Object.freeze({
    get: (id: ReportId): Triage => triages.get(id) ?? UNTRIAGED,
    setStatus: async ({ id, status, by, at }) => {
      const problem = actorProblem(by);
      if (problem !== null) return { kind: "refused", detail: problem };
      return record({ kind: "status", id, at: at.toISOString(), by, status });
    },
    addNote: async ({ id, text, by, at }) => {
      const problem = actorProblem(by);
      if (problem !== null) return { kind: "refused", detail: problem };
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "refused", detail: "a note needs some text" };
      if (Buffer.byteLength(trimmed, "utf8") > TRIAGE_LIMITS.noteBytes) {
        return { kind: "refused", detail: `a note is at most ${String(TRIAGE_LIMITS.noteBytes)} bytes` };
      }
      if ((triages.get(id)?.notes.length ?? 0) >= TRIAGE_LIMITS.notesPerReport) {
        return { kind: "refused", detail: `a report holds at most ${String(TRIAGE_LIMITS.notesPerReport)} notes` };
      }
      return record({ kind: "note", id, at: at.toISOString(), by, text: trimmed });
    },
    forget: ({ id, at }) => record({ kind: "forgotten", id, at: at.toISOString() }),
    compact: ({ keep }) =>
      serialise(async (): Promise<boolean> => {
        const lines: string[] = [];
        for (const [id, triage] of triages) {
          if (!keep(id)) continue;
          for (const event of eventsOf({ id, triage })) lines.push(JSON.stringify(event));
        }
        const stagingPath = `${logPath}.part`;
        try {
          await writeFile(stagingPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(stagingPath, logPath);
        } catch {
          await rm(stagingPath, { force: true });
          return false;
        }
        for (const id of [...triages.keys()]) if (!keep(id)) triages.delete(id);
        unreadable = 0;
        return true;
      }),
    unreadableLines: () => unreadable,
  });
}

/** The fold. A status line replaces the status, a note line appends, a forgetting drops the lot. */
function apply(options: Readonly<{ triages: Map<ReportId, Triage>; event: TriageEvent }>): void {
  const { triages, event } = options;
  const current = triages.get(event.id) ?? UNTRIAGED;
  switch (event.kind) {
    case "status":
      triages.set(event.id, { ...current, status: event.status, statusChangedAt: event.at, statusChangedBy: event.by });
      return;
    case "note":
      triages.set(event.id, { ...current, notes: [...current.notes, { at: event.at, by: event.by, text: event.text }] });
      return;
    case "forgotten":
      triages.delete(event.id);
      return;
    default:
      assertNever(event);
  }
}

/** The shortest event sequence that replays to `triage`, for compaction. */
function eventsOf(options: Readonly<{ id: ReportId; triage: Triage }>): readonly TriageEvent[] {
  const { id, triage } = options;
  const events: TriageEvent[] = [];
  if (triage.statusChangedAt !== null && triage.statusChangedBy !== null) {
    events.push({ kind: "status", id, at: triage.statusChangedAt, by: triage.statusChangedBy, status: triage.status });
  }
  for (const note of triage.notes) events.push({ kind: "note", id, at: note.at, by: note.by, text: note.text });
  return events;
}

async function replay(
  logPath: string,
): Promise<Readonly<{ triages: Map<ReportId, Triage>; unreadableLines: number }>> {
  const triages = new Map<ReportId, Triage>();
  let raw: string;
  try {
    raw = await readFile(logPath, { encoding: "utf8" });
  } catch {
    return { triages, unreadableLines: 0 };
  }
  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseEvent(line);
    if (event === null) {
      unreadableLines += 1;
      continue;
    }
    apply({ triages, event });
  }
  return { triages, unreadableLines };
}

/** The log is this process's own file, but it is still parsed rather than cast. */
function parseEvent(line: string): TriageEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const id = typeof record["id"] === "string" ? parseReportId(record["id"]) : null;
  const at = record["at"];
  if (id === null || typeof at !== "string") return null;
  const by = record["by"];
  switch (record["kind"]) {
    case "status": {
      const status = typeof record["status"] === "string" ? parseReportStatus(record["status"]) : null;
      if (status === null || typeof by !== "string") return null;
      return { kind: "status", id, at, by, status };
    }
    case "note": {
      const text = record["text"];
      if (typeof text !== "string" || typeof by !== "string") return null;
      return { kind: "note", id, at, by, text };
    }
    case "forgotten":
      return { kind: "forgotten", id, at };
    default:
      return null;
  }
}
