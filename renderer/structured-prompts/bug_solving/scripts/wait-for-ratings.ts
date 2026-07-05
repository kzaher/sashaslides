#!/usr/bin/env npx tsx
/**
 * wait-for-ratings.ts — the per-fork BLOCKING rating gate CLI.
 *
 * This is invoked as an `executeShell` node from INSIDE each SOLVED fork
 * (main.ts runTask step A2): after the fork has booted its OWN rating server
 * (step A1), it BLOCKS here until the human has rated every one of the cluster's
 * slides good/bad in that UI. Only once the wait resolves does the fork write
 * its rating-outcome marker and finish; the final merge phase (after the
 * parallelFork barrier) reads those markers to decide which clusters to fold.
 *
 * Interface (all flags required except --history-dir / --poll-ms):
 *   --results-dir <dir>   the rating server's resultsDir (= <scratch>/thumbnails).
 *                         resolveRatingIo derives ratings.json from it.
 *   --slides csv          the cluster's slide ids to wait on.
 *   --task-id <slug>      the cluster slug (recorded in the marker).
 *   --marker <file>       where to WRITE the outcome marker
 *                         (= <scratch>/rating-outcome.json).
 *   --history-dir <dir>   optional; passed through to resolveRatingIo (unused by
 *                         the gate itself, kept for symmetry / future use).
 *   --poll-ms <n>         optional poll interval (default 2000).
 *
 * Env policy (shared with the old post-run accept):
 *   BUG_SOLVING_NO_ACCEPT=1        → skip the wait ENTIRELY. Writes a marker with
 *                                    green:false + rated:false (the merge phase is
 *                                    a no-op under NO_ACCEPT anyway) and exits 0.
 *   BUG_SOLVING_RATING_TIMEOUT_MS  → bound the wait (resolveRatingTimeoutMs).
 *                                    UNSET = wait forever (ratings arrive from
 *                                    the browser UI, reachable regardless of
 *                                    TTY). On an explicit finite deadline,
 *                                    still-unrated slides make green:false; the
 *                                    marker lists them under `unrated`.
 *
 * The marker (rating-outcome.json):
 *   { task_id, rated:boolean, green:boolean, good:string[], bad:string[],
 *     unrated:string[], slides:string[] }
 *   green === (rated && bad.length===0 && unrated.length===0).
 *
 * ALWAYS exits 0 — a timeout / no-accept is a valid outcome the marker encodes,
 * NOT a shell failure (a non-zero exit would fail the executeShell node and
 * abort the already-SOLVED fork).
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveRatingIo } from "../sxs-io.js";
import { waitForRatings, readRatings, type RatingSplit } from "../rating-gate.js";
import { resolveRatingTimeoutMs, acceptDisabled } from "../accept-orchestration.js";

interface RatingOutcome {
  task_id: string;
  rated: boolean;
  green: boolean;
  good: string[];
  bad: string[];
  unrated: string[];
  slides: string[];
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function writeMarker(markerFile: string, outcome: RatingOutcome): void {
  try { mkdirSync(dirname(markerFile), { recursive: true }); } catch { /* */ }
  writeFileSync(markerFile, JSON.stringify(outcome, null, 2));
}

async function main(): Promise<void> {
  const resultsDir = arg("--results-dir");
  const slidesCsv = arg("--slides") ?? "";
  const taskId = arg("--task-id") ?? "unknown";
  const markerFile = arg("--marker");
  const historyDir = arg("--history-dir");
  const pollMs = Number(arg("--poll-ms") ?? "2000");

  if (!resultsDir || !markerFile) {
    console.error("wait-for-ratings: --results-dir and --marker are REQUIRED");
    // Still exit 0 with a best-effort not-green marker if we at least know where.
    if (markerFile) {
      writeMarker(markerFile, {
        task_id: taskId, rated: false, green: false,
        good: [], bad: [], unrated: slidesCsv ? slidesCsv.split(",") : [],
        slides: slidesCsv ? slidesCsv.split(",") : [],
      });
    }
    process.exit(0);
  }

  const slides = slidesCsv ? slidesCsv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const io = resolveRatingIo({ resultsDir, historyDir: historyDir ?? null, filterSlides: slides.length ? slides : null });

  // NO_ACCEPT → skip the wait entirely. The final merge phase is a no-op under
  // NO_ACCEPT, and the fork already booted its UI for review; don't block.
  if (acceptDisabled(process.env)) {
    console.error(`[wait-for-ratings] BUG_SOLVING_NO_ACCEPT=1 → skipping wait for ${taskId}; marker green:false.`);
    writeMarker(markerFile, {
      task_id: taskId, rated: false, green: false,
      good: [], bad: [], unrated: slides, slides,
    });
    process.exit(0);
  }

  const timeoutMs = resolveRatingTimeoutMs(process.env);
  console.error(
    `[wait-for-ratings] ${taskId}: blocking on ${io.ratingsFile} for ${slides.length} slide(s) ` +
    `(timeout=${timeoutMs === 0 ? "∞ (forever)" : `${timeoutMs}ms`}).`,
  );

  // Race the real gate against a finite deadline (0 = forever). On the deadline
  // read the current split so still-unrated slides surface as green:false — an
  // unattended run must not hang forever.
  const gate = waitForRatings(io.ratingsFile, slides, {
    pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 2000,
    deps: {
      onTick: (split) => {
        if (split.unrated.length) {
          console.error(`[wait-for-ratings] ${taskId}: ${split.good.length} good / ${split.bad.length} bad / ${split.unrated.length} unrated — waiting…`);
        }
      },
    },
  });

  let split: RatingSplit;
  if (timeoutMs === 0) {
    split = await gate;
  } else {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<RatingSplit>((res) => {
      timer = setTimeout(() => {
        console.error(`[wait-for-ratings] ${taskId}: rating deadline (${timeoutMs}ms) elapsed — recording unrated slides as not-green.`);
        res(readRatings(io.ratingsFile, slides));
      }, timeoutMs);
    });
    try { split = await Promise.race([gate, deadline]); }
    finally { if (timer) clearTimeout(timer); }
  }

  const green = split.allRated && split.bad.length === 0 && split.unrated.length === 0;
  const outcome: RatingOutcome = {
    task_id: taskId,
    rated: split.allRated,
    green,
    good: split.good,
    bad: split.bad,
    unrated: split.unrated,
    slides,
  };
  writeMarker(markerFile, outcome);
  console.error(
    `[wait-for-ratings] ${taskId}: ${green ? "GREEN (all good)" : "NOT GREEN"} — ` +
    `good=[${split.good.join(",")}] bad=[${split.bad.join(",")}] unrated=[${split.unrated.join(",")}] → ${markerFile}`,
  );
  process.exit(0);
}

main().catch((e) => {
  // A crash must still not fail the executeShell node — write a best-effort
  // not-green marker and exit 0.
  const markerFile = arg("--marker");
  const taskId = arg("--task-id") ?? "unknown";
  const slidesCsv = arg("--slides") ?? "";
  const slides = slidesCsv ? slidesCsv.split(",") : [];
  console.error(`[wait-for-ratings] ${taskId}: FATAL ${(e as Error)?.message ?? String(e)} — marker green:false.`);
  if (markerFile) {
    writeMarker(markerFile, {
      task_id: taskId, rated: false, green: false, good: [], bad: [], unrated: slides, slides,
    });
  }
  process.exit(0);
});
