/**
 * accept-orchestration.ts — the POST-RUN, rating-gated accept phase for
 * bug_solving.
 *
 * The accept/merge no longer lives INSIDE the solve graph (main.ts). Instead,
 * after `engine.execute(...)` returns the per-task solve results,
 * main-scaffolding.ts:
 *   1. boots every successful task's rating UI up front (so the human can rate
 *      all of them in parallel), then
 *   2. calls `runAcceptPhase(...)` which, SERIALLY per successful task:
 *        a. BLOCKS on that task's ratings.json until the human has rated every
 *           one of its slides good/bad (the per-thread rating gate), then
 *        b. partitions: ALL-good → GREEN (accept candidate); ANY-bad → RED,
 *           demoted back to the ledger for re-solve (via demoteForResolve), NOT
 *           accepted.
 *   3. Runs the GREEN clusters through the accept engine (`mergePhase` on the
 *      SAME engine/monitor), whose strict pixel-perfect ripple gate auto-
 *      discards+demotes any green cluster that ripples to non-intended slides.
 *
 * This module is the PURE-ISH orchestration so it unit-tests WITHOUT a real
 * engine / git / Chrome: the rating gate, the accept-runner, and the demote are
 * all injected (see accept-orchestration.test.ts). Production wiring lives in
 * main-scaffolding.ts.
 *
 * ## Env gates (documented once, here)
 *   BUG_SOLVING_NO_ACCEPT=1
 *       Skip the whole gate+accept phase. The UIs are still booted (by the
 *       caller) so the human can review; the orchestrator returns immediately
 *       with `skipped:true`. This is the OLD "boot server + exit" behavior.
 *   BUG_SOLVING_RATING_TIMEOUT_MS=<ms>
 *       Bound the per-task blocking wait. Default (unset) = 0 = wait FOREVER,
 *       INDEPENDENT OF TTY. Ratings come from the BROWSER SxS UI, which the human
 *       can reach whether or not the scaffolding has a TTY — and the scaffolding
 *       runs DETACHED (setsid → no TTY) precisely while the human rates in the
 *       browser. A finite non-TTY default made the detached forks stop waiting
 *       and complete UNRATED, so the default is now "wait forever" regardless.
 *       Only an EXPLICIT value bounds the wait (for genuinely unattended CI):
 *       N>0 = finite (unrated at the deadline → RED), 0 = forever, garbage → 0
 *       (forever). TTY is no longer consulted.
 */
import type { RatingSplit } from "./rating-gate.js";

// ---------------------------------------------------------------------------
// Legacy accept-phase types (self-contained). This is the OLD post-run,
// scaffolding-driven accept path; the live flow now folds GREEN clusters INSIDE
// the graph via llm-merge.ts (finalMergePhase). These types are kept only so the
// legacy `runAcceptPhase` orchestration + its unit test still compile — they are
// intentionally decoupled from the new llm-merge MergeReport shape.
// ---------------------------------------------------------------------------

/** A GREEN cluster to fold (legacy shape: identified by its worktree `dir`). */
export interface MergeCluster {
  task: string;
  dir: string;
  slides: string[];
}

/** The legacy accept-engine report shape (opaque to this orchestration). */
export interface MergeReport {
  accepted: string[];
  rejected: Array<{ task: string; reason: string; demotedSlides: string[] }>;
  conflicts: Array<{ task: string; files: string[]; resolved: boolean }>;
  perSlide: Record<string, unknown>;
}

/** A successfully-solved task the accept phase gates on. Minimal projection of
 *  main.ts's `TaskResult` + its `Task` — just what the accept phase needs. */
export interface SuccessfulTask {
  /** stable task slug. */
  task: string;
  /** the task's worktree dir (the "modified" side the merge composes). */
  dir: string;
  /** the task's targeted slides (rated in its UI; the merge's intended set). */
  slides: string[];
  /** absolute path to the ratings.json the task's rating UI writes. */
  ratingsFile: string;
  /** the task's rating UI url (for the "waiting for you to rate …" message). */
  url: string;
}

/** How a single task partitioned after its rating gate resolved. */
export interface TaskPartition {
  task: SuccessfulTask;
  split: RatingSplit;
  /** GREEN = every slide good; RED = at least one bad OR a deadline timeout. */
  color: "green" | "red";
  /** why it went RED (bad slides / timeout), for the demote reason + logs. */
  redReason?: string;
}

/** Injected dependency surface so the orchestrator unit-tests with no real
 *  engine / git / Chrome / timers / filesystem. */
export interface AcceptDeps {
  /** BLOCK until every `slides` entry is rated good/bad in `ratingsFile`, or the
   *  wait is bounded and the deadline passes. Production = rating-gate's
   *  `waitForRatings` wrapped with the timeout policy. Returns the final split
   *  (which may still contain unrated slides IFF a finite timeout elapsed). */
  waitForRatings: (
    task: SuccessfulTask,
    opts: { timeoutMs: number },
  ) => Promise<RatingSplit>;
  /** DEMOTE a RED task's slides back to the ledger for re-solve (mirrors
   *  MergeOps.demoteForResolve). Must be non-throwing + idempotent. */
  demoteForResolve: (slides: string[], task: string, reason: string) => void;
  /** Run the GREEN clusters through the accept engine (mergePhase on the shared
   *  engine). Production wires the staging worktree + realMergeOps via
   *  deriveMergeArgs. Returns the MergeReport (or null if nothing green). */
  runAccept: (green: MergeCluster[]) => Promise<MergeReport | null>;
  /** per-line progress logging (default console.error in prod). */
  log?: (msg: string) => void;
}

/** The accept phase's outcome (returned for logging + the end-of-run summary). */
export interface AcceptPhaseResult {
  /** true if BUG_SOLVING_NO_ACCEPT=1 skipped the whole phase. */
  skipped: boolean;
  partitions: TaskPartition[];
  green: MergeCluster[];
  red: SuccessfulTask[];
  report: MergeReport | null;
}

/** Resolve the per-task blocking-wait budget from the env ALONE (no TTY).
 *  Ratings come from the browser SxS UI, which is reachable regardless of TTY,
 *  and the scaffolding runs DETACHED (no TTY) while the human rates — so the
 *  unset default must be "wait forever", NOT a finite non-TTY timeout (that made
 *  detached forks complete UNRATED).
 *  - explicit BUG_SOLVING_RATING_TIMEOUT_MS wins: N>0 = finite, 0 = forever.
 *  - unset (or garbage) → 0 = wait forever.
 *  Exported for the scaffolding + tests. */
export function resolveRatingTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.BUG_SOLVING_RATING_TIMEOUT_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n; // 0 = forever, N>0 = finite
  }
  return 0; // unset/garbage → wait forever (ratings arrive from the browser UI)
}

/** Is the accept phase disabled (opt-out)? */
export function acceptDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.BUG_SOLVING_NO_ACCEPT === "1";
}

/**
 * The rating-gated accept orchestration. Pure-ish: every side-effect is on
 * `deps`. SERIALLY, for each successful task in order:
 *   1. print "waiting for you to rate <task> (<n> slides) at <url>",
 *   2. BLOCK on its rating gate (bounded by the resolved timeout),
 *   3. partition GREEN (all good) / RED (any bad, or a deadline timeout),
 *   4. RED → demoteForResolve (feed back for re-solve), NOT accepted.
 * Then run the GREEN set through the accept engine once.
 *
 * @param tasks  successful tasks (UIs already booted by the caller).
 * @param deps   injected gate / demote / accept-runner / log / tty.
 * @param env    process.env (injected for tests).
 */
export async function runAcceptPhase(
  tasks: SuccessfulTask[],
  deps: AcceptDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptPhaseResult> {
  const log = deps.log ?? ((m: string) => console.error(m));

  if (acceptDisabled(env)) {
    log("[accept] BUG_SOLVING_NO_ACCEPT=1 → skipping rating-gate + accept; UIs left up for review.");
    return { skipped: true, partitions: [], green: [], red: [], report: null };
  }

  const timeoutMs = resolveRatingTimeoutMs(env);
  log(
    `[accept] rating gate: timeout=${timeoutMs === 0 ? "∞ (wait forever)" : `${timeoutMs}ms`}. ` +
    `Rate every slide good/bad in each task's UI (browser) to unblock it.`,
  );

  const partitions: TaskPartition[] = [];
  const green: MergeCluster[] = [];
  const red: SuccessfulTask[] = [];

  // SERIAL gate: block on each task in order. The UIs are already all up, so the
  // human can rate them in any order; we simply consume them one at a time.
  for (const task of tasks) {
    log(`[accept] waiting for you to rate ${task.task} (${task.slides.length} slide(s)) at ${task.url}`);
    const split = await deps.waitForRatings(task, { timeoutMs });

    if (split.allRated && split.bad.length === 0) {
      // GREEN — every slide good.
      partitions.push({ task, split, color: "green" });
      green.push({ task: task.task, dir: task.dir, slides: task.slides });
      log(`[accept] ${task.task} → GREEN (all ${split.good.length} slide(s) good) — accept candidate.`);
    } else {
      // RED — a bad slide, or the deadline elapsed with slides still unrated.
      const reason = split.bad.length
        ? `user rated ${split.bad.join(", ")} bad`
        : `rating deadline elapsed with unrated slide(s) [${split.unrated.join(", ")}] — deferred as RED`;
      partitions.push({ task, split, color: "red", redReason: reason });
      red.push(task);
      log(`[accept] ${task.task} → RED (${reason}) — demoting for re-solve, NOT accepting.`);
      // Demote the whole targeted set so re-clustering re-solves it. Non-throwing.
      try {
        deps.demoteForResolve(task.slides, task.task, reason);
      } catch (e) {
        log(`[accept] demoteForResolve threw for ${task.task} (continuing): ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }

  let report: MergeReport | null = null;
  if (green.length) {
    log(`[accept] running accept engine over ${green.length} GREEN cluster(s): ${green.map((g) => g.task).join(", ")}`);
    report = await deps.runAccept(green);
  } else {
    log("[accept] no GREEN clusters — nothing to accept.");
  }

  return { skipped: false, partitions, green, red, report };
}
