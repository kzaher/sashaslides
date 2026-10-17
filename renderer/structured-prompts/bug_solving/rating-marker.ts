/**
 * rating-marker.ts — the rating-outcome marker: one file per fork at `<shared_dir>/rating-outcome.json`.
 *
 * scripts/wait-for-ratings.ts writes it from INSIDE the fork's branch once the rating gate resolves
 * (or is skipped under NO_ACCEPT). The shared dir is OUTSIDE the overlay, so the fork's step A3, the
 * final merge phase (main.ts) and resume-merge.ts read the same file from outside the branch. A file
 * written under the repository-relative scratch would land in the branch's private upper layer and be
 * invisible to them.
 *
 * Leaf module: no runtime imports from main.ts, so the CLI script can import it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RatingOutcomeMarker = Readonly<{
  task_id: string;
  rated: boolean;
  /** rated && nothing bad && nothing unrated. */
  green: boolean;
  good: readonly string[];
  bad: readonly string[];
  unrated: readonly string[];
  slides: readonly string[];
}>;

export const RATING_MARKER_FILE = "rating-outcome.json";

/** Where a task's marker lives: `<shared_dir>/rating-outcome.json`. */
export function ratingMarkerPath(task: Readonly<{ shared_dir: string }>): string {
  return join(task.shared_dir, RATING_MARKER_FILE);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Parse + validate a marker file's text. Null when malformed or `green` is not a boolean. */
export function parseRatingMarker(json: string, fallbackTaskId: string): RatingOutcomeMarker | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.green !== "boolean") return null;
  return {
    task_id: typeof o.task_id === "string" ? o.task_id : fallbackTaskId,
    rated: o.rated === true,
    green: o.green,
    good: stringArray(o.good),
    bad: stringArray(o.bad),
    unrated: stringArray(o.unrated),
    slides: stringArray(o.slides),
  };
}

/** Read a marker file. Null when absent (the fork failed or never rated) or malformed: every
 *  reader treats null as "unrated, not green". */
export function readRatingMarkerFile(file: string, fallbackTaskId: string): RatingOutcomeMarker | null {
  if (!existsSync(file)) return null;
  try { return parseRatingMarker(readFileSync(file, "utf8"), fallbackTaskId); } catch { return null; }
}

export function readRatingMarker(task: Readonly<{ shared_dir: string; task_id: string }>): RatingOutcomeMarker | null {
  return readRatingMarkerFile(ratingMarkerPath(task), task.task_id);
}

export function writeRatingMarker(file: string, marker: RatingOutcomeMarker): void {
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* the write below reports it */ }
  writeFileSync(file, JSON.stringify(marker, null, 2));
}

/** The marker of a gate that did not get a rating (skipped, misconfigured or crashed). */
export function notGreenMarker(taskId: string, slides: readonly string[]): RatingOutcomeMarker {
  return { task_id: taskId, rated: false, green: false, good: [], bad: [], unrated: slides, slides };
}

/** Why a cluster is excluded from the merge: the reason its slides are demoted with. */
export function notGreenReason(marker: RatingOutcomeMarker | null): string {
  if (marker === null) return "no rating marker (fork failed or never rated) — excluded from merge";
  if (marker.bad.length) return `user rated ${marker.bad.join(", ")} bad`;
  if (marker.unrated.length) return `rating incomplete — unrated slide(s) [${marker.unrated.join(", ")}]`;
  return "not green";
}
