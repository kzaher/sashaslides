/**
 * rating-gate.ts — the per-thread human rating gate.
 *
 * Each successfully-solved cluster boots its OWN rating UI (rating-server.ts,
 * which pings the human via the notify hook on boot) and the orchestrator then
 * BLOCKS here until every one of that cluster's slides is rated good or bad.
 * Only once the human has rated all of them does the accept step run:
 *   - all good  → the fix is accepted → composed onto the target (a strict
 *                 pixel-perfect ripple gate still guards unrelated slides).
 *   - any bad   → the fix is rejected/demoted so clustering can re-solve it.
 *
 * This module is deliberately pure I/O over the rating ledger + injectable deps
 * (read/sleep) so it unit-tests without real timers, filesystem, or a browser.
 */
import { readFileSync, existsSync } from "fs";
import type { RatingIoConfig } from "./sxs-io.js";

export interface RatingSplit {
  /** true once every requested slide has a good|bad verdict (none unrated). */
  allRated: boolean;
  good: string[];
  bad: string[];
  unrated: string[];
}

/** Read the current good/bad/unrated split for `slides` from a rating server's
 *  ratings.json. A slide with status !== "good"|"bad" (or absent, or a
 *  mid-write unparseable file) counts as UNRATED — we never treat a missing
 *  verdict as acceptance. */
export function readRatings(ratingsFile: string, slides: string[]): RatingSplit {
  let ratings: Record<string, { status?: string }> = {};
  try {
    if (existsSync(ratingsFile)) ratings = JSON.parse(readFileSync(ratingsFile, "utf8"));
  } catch { /* file mid-write → treat as all-unrated this tick */ }
  const good: string[] = [], bad: string[] = [], unrated: string[] = [];
  for (const sid of slides) {
    const st = ratings[sid]?.status;
    if (st === "good") good.push(sid);
    else if (st === "bad") bad.push(sid);
    else unrated.push(sid);
  }
  return { allRated: unrated.length === 0, good, bad, unrated };
}

export interface WaitDeps {
  /** override the ledger reader (default: readRatings). */
  read?: (file: string, slides: string[]) => RatingSplit;
  /** override the delay between polls (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** called once per poll with the current split — progress logging in prod,
   *  assertions in tests. */
  onTick?: (split: RatingSplit) => void;
  /** abort the wait early (e.g. process shutdown). When it returns true the
   *  wait rejects with an Error("rating wait aborted"). */
  aborted?: () => boolean;
}

/** BLOCK until every slide in `slides` is rated good or bad in `ratingsFile`.
 *  Returns the final split (allRated === true). An empty `slides` list returns
 *  immediately (nothing to wait for). Polls every `pollMs` (default 2s). */
export async function waitForRatings(
  ratingsFile: string,
  slides: string[],
  opts: { pollMs?: number; deps?: WaitDeps } = {},
): Promise<RatingSplit> {
  const pollMs = opts.pollMs ?? 2000;
  const read = opts.deps?.read ?? readRatings;
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (slides.length === 0) return { allRated: true, good: [], bad: [], unrated: [] };
  for (;;) {
    if (opts.deps?.aborted?.()) throw new Error("rating wait aborted");
    const split = read(ratingsFile, slides);
    opts.deps?.onTick?.(split);
    if (split.allRated) return split;
    await sleep(pollMs);
  }
}

/** Config-driven convenience: block on the ratings.json named by the documented
 *  I/O contract ({@link RatingIoConfig.ratingsFile}) rather than a bare path, so
 *  callers pass the same config the rating server was booted with. */
export function waitForRatingsIo(
  cfg: RatingIoConfig,
  slides: string[],
  opts: { pollMs?: number; deps?: WaitDeps } = {},
): Promise<RatingSplit> {
  return waitForRatings(cfg.ratingsFile, slides, opts);
}
