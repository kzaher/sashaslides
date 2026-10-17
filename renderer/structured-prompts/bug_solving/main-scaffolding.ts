/**
 * Runner for the bug_solving structured prompt.
 *
 * This file OWNS the process — it's what `node dist/main-scaffolding.mjs`
 * actually executes. Its job:
 *   1. Resolve the cluster list the user wants to work on.
 *   2. Pre-flight Google auth + assert a clean converter tree.
 *   3. Build the per-task worktrees + record the BEFORE-state pptx.
 *   4. Boot the ClaudeEngine (prints monitor URL to stderr on bind).
 *   5. Run main() to completion.
 *
 * The rating gate + accept/merge now live INSIDE the graph (see main.ts):
 *   - each SOLVED fork boots its OWN rating UI and BLOCKS on the human rating
 *     (fork-chain.ts steps A1–A3), then writes a rating-outcome.json marker to its
 *     shared dir (outside the overlay, so the final phase can read it);
 *   - AFTER the parallelFork barrier a FINAL merge phase (finalMergePhase) folds
 *     every GREEN cluster together with the SIMPLE LLM MERGE (llm-merge.ts): base
 *     + each fork's converter version → one LLM-merged file, retest, promote onto
 *     the working tree.
 * The scaffolding therefore no longer boots UIs or runs a post-run accept — it
 * just prints the results, the monitor URL, and any failures.
 *
 * ## Rating/merge env gates (handled inside the graph — see main.ts)
 *   BUG_SOLVING_NO_ACCEPT=1          forks boot UIs but SKIP their waits; the
 *                                    final merge phase is a no-op (nothing lands).
 *   BUG_SOLVING_RATING_TIMEOUT_MS=N  per-fork blocking-wait budget, independent
 *       of TTY (rating-gate.ts resolveRatingTimeoutMs): unset or 0 = wait forever,
 *       N>0 = finite, after which still-unrated slides count as NOT-GREEN.
 *
 * ## Clusters
 *   The slides marked BAD in the live SxS ratings.json, one cluster per slide
 *   (clusters.ts clustersFromRatings); `--clusters` (BUG_SOLVING_CLUSTERS) groups
 *   them by hand.
 *
 * ## Build + run
 *   npx tsx structured-prompting/build.ts \
 *       renderer/structured-prompts/bug_solving/main-scaffolding.ts
 *   node structured-prompting/dist/main-scaffolding.mjs
 *
 * ## Direction (--direction=forward|reverse, env BUG_SOLVING_DIRECTION; default forward)
 *   reverse: clusters from .sxs-reverse/ratings-reverse.json (BUG_SOLVING_RATINGS_JSON /
 *   BUG_SOLVING_SXS_DIR override the ratings file / results root, BUG_SOLVING_REVERSE_GOLDENS_DIR
 *   the goldens the gate READS, BUG_SOLVING_REVERSE_CHROME_PORT the Chrome, default the headless 9222).
 *   No BEFORE pptx is recorded (the canonical .sxs-reverse renders are the BEFORE); each
 *   fork runs reverseChain (reverse-run-task.ts). See main.ts's header.
 *
 * ## Monitor URL
 *   Engine prints it on stderr as soon as it binds the port (look for
 *   `┌── structured-prompting monitor`). We echo it again at end of run.
 */
import { execFile, type ExecException } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
const execFileAsync = promisify(execFile);
import { rmSync } from "fs";
import { ClaudeEngine, CodexEngine, Session, branchRunCommand } from "../../../structured-prompting/src/index.js";
import { buildTasks, selectOnlyClusters } from "./workspace-setup.js";
// (stability recording now lives in the main graph — main.ts:stabilityBranch)
import { main, mergeSettingsFor, type TaskResult } from "./main.js";
import {
  clustersFromReverseRatings,
  defaultReversePaths,
  DEFAULT_REVERSE_CHROME_PORT,
  parseSolveDirection,
  reverseBaselineDirectory,
  reverseClusterMemberKey,
  reverseRenderOf,
  REVERSE_SCRIPTS,
  type ReversePaths,
  type SolveDirection,
} from "./reverse-direction.js";
import { cleanupAllOverlays } from "./overlay-cleanup.js";
import {
  detectPriorState,
  decideStartup,
  parseStartupFlags,
  DEFAULT_BRANCHES_ROOT,
  DEFAULT_SHARED_ROOT,
} from "./startup-detection.js";
import { resumeMerge } from "./resume-merge.js";

import { clustersFromRatings, applyManualClusters } from "./clusters.js";
import http from "node:http";
import { join as pathJoin } from "node:path";
import type { Cluster } from "./workspace-setup.js";

/** At solve start, print the slides you marked BAD (the clusters) with the paths
 *  to each: the source fixture, the TARGET (original) + ATTEMPT (current) renders,
 *  the annotation, and the live comment. */
function printBrokenSlides(clusters: Cluster[], ratingsPath: string, sxsDir: string, fixturesDir: string): void {
  console.error(`\n[scaffold] broken slides marked for solving (from ${ratingsPath}): ${clusters.length ? clusters.map((c) => c.slide_ids.join(",")).join(", ") : "(none)"}`);
  for (const c of clusters) {
    const id = c.slide_ids[0];
    const comment = c.cluster_description.split("\n")[0].replace(/^.*? — /, "");
    console.error(`  ■ ${id} — "${comment}"`);
    console.error(`      fixture:    ${pathJoin(fixturesDir, `${id}.html`)}`);
    console.error(`      TARGET:     ${pathJoin(sxsDir, "originals", `${id}.png`)}`);
    console.error(`      ATTEMPT:    ${pathJoin(sxsDir, "slides", `${id}.png`)}`);
    console.error(`      annotation: ${pathJoin(sxsDir, "annotations", `${id}.png`)}`);
  }
}

/** The reverse twin of printBrokenSlides: Google's thumbnail is the TARGET, the Sasha
 *  render the ATTEMPT, and the exported page is what several comments are about. */
function printBrokenReverseSlides(clusters: Cluster[], paths: ReversePaths): void {
  console.error(`\n[scaffold] REVERSE slides marked for solving (from ${paths.ratingsFile}): ${clusters.length ? clusters.map((c) => c.slide_ids.join(",")).join(", ") : "(none)"}`);
  for (const c of clusters) {
    for (const id of c.slide_ids) {
      const render = reverseRenderOf({ resultsDirectory: paths.resultsRoot, slideId: id });
      console.error(`  ■ ${id} [${c.task_id}]`);
      console.error(`      ATTEMPT:    ${render?.png ?? "(not a reverse id)"}`);
      console.error(`      HTML:       ${render?.html ?? "(not a reverse id)"}`);
      console.error(`      annotation: ${pathJoin(paths.resultsRoot, "annotations", `${id}.png`)}`);
    }
  }
}

/** The reverse inputs, overridable for a run against another (e.g. a test) results tree. */
function reversePathsFromEnvironment(): ReversePaths {
  const defaults = defaultReversePaths(REPO_ROOT);
  const resultsRoot = process.env.BUG_SOLVING_SXS_DIR ?? defaults.resultsRoot;
  return {
    resultsRoot,
    ratingsFile: process.env.BUG_SOLVING_RATINGS_JSON ?? pathJoin(resultsRoot, "ratings-reverse.json"),
    goldensDirectory: process.env.BUG_SOLVING_REVERSE_GOLDENS_DIR ?? defaults.goldensDirectory,
    historyDirectory: defaults.historyDirectory,
  };
}

// Absolute paths to helper scripts. Resolved from the repo root
// (process.cwd()) — the canonical launch command is
//   cd /workspaces/sashaslides && node structured-prompting/dist/main-scaffolding.mjs
// Using process.cwd() keeps the resolution correct whether this file
// runs as a .ts through tsx or as a bundled .mjs in structured-prompting/dist/.
const REPO_ROOT = process.cwd();
// record-pptx.sh was inlined into record-rendering.ts. We invoke the
// WORKTREE's copy (per task) so BEFORE is measured by the exact same
// pipeline as AFTER; this is the repo-root-relative path joined onto each
// task's workspace_dir below.
const RECORD_SCRIPT_REL = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";
// The per-fork rating UIs run INSIDE the graph (fork-chain.ts step A1), in the
// foreground of their node, and exit once every slide is rated — so the
// scaffolding tracks no child servers. An uncaughtException still exits non-zero.
process.on("uncaughtException", (e) => {
  console.error("[scaffolding] uncaughtException:", e);
  process.exit(1);
});

/** Pre-flight the Google OAuth grant by running check-google-auth.ts (which
 *  forces a token refresh). On failure, print the re-auth instructions and exit
 *  non-zero BEFORE any worktrees are created — so a dead token can't silently
 *  produce empty rating servers after a full multi-cluster run. Skippable via
 *  BUG_SOLVING_SKIP_AUTH_PREFLIGHT=1 for solve-only runs that don't render. */
async function preflightGoogleAuth(): Promise<void> {
  if (process.env.BUG_SOLVING_SKIP_AUTH_PREFLIGHT === "1") {
    console.error("[scaffold] auth pre-flight skipped (BUG_SOLVING_SKIP_AUTH_PREFLIGHT=1)");
    return;
  }
  const script = resolve(REPO_ROOT, "renderer/structured-prompts/bug_solving/scripts/check-google-auth.ts");
  try {
    const { stdout } = await execFileAsync("npx", ["tsx", script], {
      cwd: resolve(REPO_ROOT, "renderer"), maxBuffer: 4 * 1024 * 1024,
    });
    console.error(stdout.trim() || "[auth-preflight] OK");
  } catch (e) {
    const err = e as ExecException & { stdout?: string; stderr?: string };
    console.error("\n❌ Google OAuth pre-flight FAILED — aborting before creating worktrees.");
    console.error(((err.stdout ?? "") + (err.stderr ?? "")).trim() || err.message);
    console.error("   Re-authorize, then re-run:  npx tsx /workspaces/sashaslides/.auth/generate-token.ts\n");
    process.exit(1);
  }
}

/** Record the BEFORE-state pptx for every task in parallel. These are
 *  side-effect-only script invocations with no model judgement, so we
 *  lift them out of main.ts — keeping the structured-prompt graph
 *  focused on the steps that actually need model calls or typed flow.
 *  Runs once at startup; main.ts records AFTER itself after the fix. */
async function recordBeforePptx(tasks: ReturnType<typeof buildTasks>): Promise<void> {
  console.error(`[scaffolding] recording BEFORE pptx for ${tasks.length} task(s) in parallel...`);
  await Promise.all(tasks.map(async (t) => {
    const ids = t.slides.map(s => s.slide_id).join(",");
    // Record BEFORE INSIDE the task's overlay branch so the pptx lands in the
    // SAME branch scratch the worker (and step-4 diff) later read. Paths are
    // repo-relative, resolved to absolute via $ROOT (= the branch's merged root).
    // This is the UNMODIFIED tree (the worker hasn't run yet), so it's the true
    // BEFORE state. cwd = renderer/ inside the branch for node_modules.
    // Render TWO pristine BEFORE sets, both here (host-level, ONE overlay mount,
    // before the worker touches the converter):
    //   • before      = this cluster's slides   → step 4's pairwise diff.
    //   • before-all  = the WHOLE fixture deck   → step 4b's off-target scan.
    // before-all is staged NOW so step 4b never has to re-render the baseline
    // inside the worker's jail — a nested overlay mount there is kernel-rejected.
    const inner =
      `ROOT="$PWD"; cd "$ROOT/renderer" && ` +
      `npx tsx "$ROOT/${RECORD_SCRIPT_REL}" --mode pptx ` +
      `--fixtures "$ROOT/${t.fixtures_dir}" --slides ${ids} ` +
      `--out "$ROOT/${t.scratch_dir}/before" && ` +
      `ALL=$(ls "$ROOT/${t.fixtures_dir}"/slide_*.html | xargs -n1 basename | sed 's/[.]html$//' | sort -V | paste -sd,) && ` +
      `RECORD_CONCURRENCY=${process.env.MERGE_RENDER_CONCURRENCY || "5"} npx tsx "$ROOT/${RECORD_SCRIPT_REL}" --mode pptx ` +
      `--fixtures "$ROOT/${t.fixtures_dir}" --slides "$ALL" ` +
      `--out "$ROOT/${t.scratch_dir}/before-all"`;
    try {
      const bs = branchRunCommand(t.branch_id, "bash", ["-c", inner]);
      await execFileAsync(bs.command, bs.args, { cwd: REPO_ROOT, env: bs.env, maxBuffer: 32 * 1024 * 1024 });
      console.error(`  [${t.task_id}] before pptx → (branch ${t.branch_id}) ${t.scratch_dir}/before/pptx`);
    } catch (e: unknown) {
      // TS forbids a type annotation on the catch binding (ts(1196)), so the
      // type goes on the narrowing instead. Node decorates the promisified
      // execFile rejection (an ExecException) with the captured stdout/stderr.
      const err = e as ExecException & { stdout?: string; stderr?: string };
      throw new Error(`record-before failed for ${t.task_id}: ${err.message}\nstdout:${err.stdout ?? ""}\nstderr:${err.stderr ?? ""}`);
    }
  }));
}

/** REVERSE: render every set ONCE from the untouched tree (host-level, before any worker runs)
 *  into the run's shared baseline dir — the "current metrics" and golden-drift baseline every
 *  fork's regression gate compares against. Non-fatal: on failure the gates fall back to the
 *  canonical .sxs-reverse results (which can lag the tree). ~2 min for the three sets. */
async function recordReverseBaseline(tasks: ReturnType<typeof buildTasks>, paths: ReversePaths, chromePort: number): Promise<void> {
  const first = tasks[0];
  if (first === undefined) return;
  const output = reverseBaselineDirectory(first.shared_dir);
  console.error(`[scaffolding] recording the REVERSE baseline (every set, untouched tree) → ${output} …`);
  try {
    await execFileAsync("npx", [
      "tsx", resolve(REPO_ROOT, REVERSE_SCRIPTS.record),
      "--canonical", paths.resultsRoot, "--output", output, "--chrome-port", String(chromePort),
    ], { cwd: resolve(REPO_ROOT, "renderer"), maxBuffer: 32 * 1024 * 1024 });
    console.error(`[scaffolding] reverse baseline ready → ${output}/metrics.json`);
  } catch (e: unknown) {
    // Node decorates the promisified execFile rejection (an ExecException) with stdout/stderr.
    const err = e as ExecException & { stdout?: string; stderr?: string };
    console.error(`[scaffolding] reverse baseline FAILED (non-fatal; gates fall back to ${paths.resultsRoot}): ${err.message}\n${(err.stderr ?? "").slice(-2000)}`);
  }
}

// (The 3× stability classification moved OUT of the scaffolding pre-step and INTO
// the main graph as a parallel "stability" branch — see main.ts:stabilityBranch.
// It no longer blocks startup; it runs concurrently with the solve fork-set.)

async function run(): Promise<void> {
  // NOTE: overlays now PERSIST across crashes/exit — there is NO auto-reap
  // startup sweep and NO death handlers (see cow-workspace.ts's PERSISTENCE
  // CONTRACT). Removal is EXPLICIT only: on a successful merge (per-cluster, in
  // llm-merge.ts), or via --clean/--continue below. So instead of registering a
  // reaper here, we DETECT prior overlay state and refuse to clobber it.

  // `--engine=codex|claude` (or env BUG_SOLVING_ENGINE) selects the model
  // backend. Both are the same `Engine` composed with a different
  // `ModelDriver`, so the graph/monitor/interpreter behaviour is identical;
  // only the CLI the workers call changes. Defaults to claude.
  //
  // Ports are split by engine so a claude run and a codex run can run in
  // PARALLEL without colliding: monitor 4711 (claude) / 4712 (codex), and the
  // per-task SxS server range [4720,4800) is halved — [4720,4760) for claude,
  // [4760,4800) for codex.
  const engineArg =
    process.argv.find((a) => a.startsWith("--engine="))?.slice("--engine=".length)
    ?? process.env.BUG_SOLVING_ENGINE
    ?? "claude";
  const engineKind = engineArg.toLowerCase();
  if (engineKind !== "claude" && engineKind !== "codex") {
    throw new Error(`--engine must be "claude" or "codex" (got "${engineArg}")`);
  }
  const isCodex = engineKind === "codex";

  // --direction=forward|reverse (solve.sh --direction → BUG_SOLVING_DIRECTION).
  const direction: SolveDirection = parseSolveDirection(
    process.argv.find((a) => a.startsWith("--direction="))?.slice("--direction=".length)
      ?? process.env.BUG_SOLVING_DIRECTION
      ?? "forward",
  );
  const reversePaths: ReversePaths | null = direction === "reverse" ? reversePathsFromEnvironment() : null;
  const reverseChromePort = Number(process.env.BUG_SOLVING_REVERSE_CHROME_PORT ?? DEFAULT_REVERSE_CHROME_PORT);
  console.error(`[scaffold] direction: ${direction}${reversePaths ? ` (results ${reversePaths.resultsRoot}, ratings ${reversePaths.ratingsFile}, goldens ${reversePaths.goldensDirectory} read-only, chrome :${reverseChromePort})` : ""}`);
  const monitorPort = isCodex ? 4712 : 4711;
  const portBase = isCodex ? 4760 : 4720;
  console.error(`[scaffold] engine: ${engineKind} (monitor :${monitorPort}, task ports ${portBase}-${portBase + 39})`);

  // JAIL ON for solve + merge. Set BEFORE any branch run (recordBeforePptx,
  // the engine's per-fork solve commands, and the final merge). Every `run` then
  // sandboxes the worker CLI + retest: the base REPO is overlay copy-on-write,
  // /tmp is a disposable tmpfs, everything else read-only.
  process.env.COW_WORKSPACE_JAIL = "1";
  // cow-workspace now dispatches every branch command on COW_WORKSPACE_PROVIDER (Linux overlayfs vs
  // Windows VHDX, since its 520b54f "Consolidate Windows workspaces on VHDX"); a launcher that builds
  // the env by hand must name it, or every fork dies at its first command with "COW_WORKSPACE_PROVIDER
  // must be 'overlayfs' or 'vhdx'" (measured 2026-10-16: all four reverse clusters failed that way).
  process.env.COW_WORKSPACE_PROVIDER = process.env.COW_WORKSPACE_PROVIDER ?? (process.platform === "win32" ? "vhdx" : "overlayfs");
  // The worker CLI's OWN state (~/.claude / ~/.codex sessions) must PERSIST to
  // the real fs — the monitor + `claude --resume` read it from there. So it is
  // SHARED read-write (NOT copy-on-write); only the repo is sandboxed. (Overlaying
  // it isolated the session files in the fork's private upper → the monitor's
  // transcripts came up empty.) Include BOTH dirs; a missing one is harmless.
  process.env.COW_WORKSPACE_SHARE_RW =
    process.env.COW_WORKSPACE_SHARE_RW ?? "/home/node/.claude:/home/node/.codex";
  // The jail runs the worker inside `unshare --map-root-user`, so the CLI sees
  // itself as root and refuses `--dangerously-skip-permissions` ("cannot be used
  // with root/sudo") — which is TRUE, we ARE sandboxing it. IS_SANDBOX=1 tells the
  // CLI it's in a sandbox so it allows skip-permissions. Proven: claude edits a
  // file inside the jail with IS_SANDBOX=1 (see claude-in-jail.e2e.test.ts).
  process.env.IS_SANDBOX = process.env.IS_SANDBOX ?? "1";
  console.error(`[scaffold] jail ON (COW_WORKSPACE_JAIL=1, IS_SANDBOX=1, share-rw=${process.env.COW_WORKSPACE_SHARE_RW})`);

  // STARTUP DETECTION — overlays persist, so a fresh run must not clobber prior
  // state. --clean discards it; --continue resumes merging it; neither + state
  // present → hard error naming both options.
  const flags = parseStartupFlags(process.argv, process.env);
  const prior = detectPriorState(DEFAULT_BRANCHES_ROOT, DEFAULT_SHARED_ROOT);
  const decision = decideStartup(prior, flags);
  if (decision.action === "error") {
    console.error(`\n❌ ${decision.message}`);
    process.exit(2);
  } else if (decision.action === "resume") {
    console.error("[scaffold] --continue → RESUME-MERGE on persisted overlays (skipping solve).");
    await resumeMerge({ repo: REPO_ROOT, engine: engineKind, merge: mergeSettingsFor(direction, reversePaths) });
    console.error("[scaffold] resume-merge done.");
    return;
  } else if (decision.action === "clean") {
    console.error("[scaffold] --clean → discarding ALL prior overlay state, then FRESH solve.");
    cleanupAllOverlays();
    try { rmSync(DEFAULT_SHARED_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  // action === "fresh" (or post-clean) → continue below.

  // Fixtures / SxS / ratings dirs are overridable via env so a run can target
  // a different fixture set (e.g. fixtures-basic) without code edits. Each
  // falls back to buildTasks' own default when the env var is unset.
  // BUG_SOLVING_RETRY_BUDGET (solve.sh --attempts) OVERRIDES the per-cluster
  // retry_budget for the whole run, so the attempt count is a run-level knob.
  const retryBudget = process.env.BUG_SOLVING_RETRY_BUDGET
    ? Number(process.env.BUG_SOLVING_RETRY_BUDGET) : undefined;

  // Clusters come DIRECTLY from the live SxS ratings — the slides you actually
  // marked BAD (with their live comments) are the source of truth at solve start.
  // No ledger reconciliation that could let a stale history override your
  // current ratings.
  const ratingsPath = reversePaths?.ratingsFile ?? process.env.BUG_SOLVING_RATINGS_JSON ?? "/tmp/sxs-complex/ratings.json";
  const sxsDir = reversePaths?.resultsRoot ?? process.env.BUG_SOLVING_SXS_DIR ?? "/tmp/sxs-complex";
  const fixturesDir = process.env.BUG_SOLVING_FIXTURES_DIR ?? "renderer/html2slides/e2e/fixtures";
  let liveClusters = reversePaths
    ? clustersFromReverseRatings({ ratingsPath, retryBudget: retryBudget ?? null })
    : clustersFromRatings(ratingsPath, { retryBudget });
  // --clusters (BUG_SOLVING_CLUSTERS): manually GROUP the auto per-slide clusters,
  // e.g. --clusters="[['slide_35','slide_36','slide_37','slide_38']]" solves those
  // four as ONE cluster (one root cause + one fork) instead of four issues.
  const manualClusterSpec = (process.env.BUG_SOLVING_CLUSTERS || "").trim();
  if (manualClusterSpec) {
    liveClusters = applyManualClusters(
      liveClusters,
      manualClusterSpec,
      reversePaths ? { memberKey: reverseClusterMemberKey(liveClusters.flatMap((c) => c.slide_ids)) } : {},
    );
    console.error(
      `[scaffold] --clusters applied → ${liveClusters.length} cluster(s): ` +
        liveClusters.map((c) => `${c.task_id}[${c.slide_ids.join(",")}]`).join(" · "),
    );
  }
  if (reversePaths) printBrokenReverseSlides(liveClusters, reversePaths);
  else printBrokenSlides(liveClusters, ratingsPath, sxsDir, fixturesDir);
  if (liveClusters.length === 0) {
    console.error(`\n❌ No slides marked BAD in ${ratingsPath} — nothing to solve. Rate slides bad in the SxS UI first.`);
    process.exit(2);
  }

  // --only (BUG_SOLVING_ONLY): limit the run to ONE cluster for fast E2E testing.
  // Matches on exact task_id, a substring of it, or a slide id in the cluster.
  const only = (process.env.BUG_SOLVING_ONLY || "").trim();
  const baseClusters = selectOnlyClusters(liveClusters, only);
  if (only && baseClusters.length === 0) {
    console.error(`\n❌ --only "${only}" matched no marked-bad slide. Available: ${liveClusters.map((c) => c.task_id).join(", ")}`);
    process.exit(2);
  }
  if (only) console.error(`[scaffold] --only "${only}" → solving ${baseClusters.length} cluster(s): ${baseClusters.map((c) => c.task_id).join(", ")}`);
  const clusters = (retryBudget && retryBudget >= 1)
    ? baseClusters.map((c) => ({ ...c, retry_budget: retryBudget }))
    : baseClusters;
  const buildOpts: Parameters<typeof buildTasks>[0] = { clusters, port_base: portBase };
  if (retryBudget && retryBudget >= 1) {
    buildOpts.retry_budget = retryBudget;
    console.error(`[scaffold] retry budget (attempts) override: ${retryBudget}`);
  }
  if (process.env.BUG_SOLVING_FIXTURES_DIR) buildOpts.fixtures_dir = process.env.BUG_SOLVING_FIXTURES_DIR;
  if (process.env.BUG_SOLVING_SXS_DIR) buildOpts.sxs_dir = process.env.BUG_SOLVING_SXS_DIR;
  if (process.env.BUG_SOLVING_RATINGS_JSON) buildOpts.ratings_json = process.env.BUG_SOLVING_RATINGS_JSON;
  buildOpts.direction = direction;
  buildOpts.reverse_paths = reversePaths;
  console.error(`[scaffold] fixtures_dir: ${buildOpts.fixtures_dir ?? "(default fixtures/)"}`);

  // Pre-flight Google OAuth BEFORE creating worktrees. A dead grant makes every
  // step-7 `record-rendering --mode full` upload fail with invalid_grant, which
  // `|| true` swallows — leaving empty rating servers after a whole run. Fail
  // loudly up front instead. Bypass with BUG_SOLVING_SKIP_AUTH_PREFLIGHT=1
  // (e.g. a solve-only run that won't render thumbnails).
  await preflightGoogleAuth();

  // (The old assertCleanTree "no dirty files" gate was DELETED: the overlay
  // lower IS the working tree, so uncommitted converter changes ride into every
  // branch naturally — the gate is obsolete.)

  // Notify config. Each successfully-solved thread boots its OWN rating UI and
  // blocks until you've rated every slide good/bad; the UI pings you when it
  // comes up. Make the mechanism explicit AT START: a stdout notice is the
  // guaranteed baseline (always printed), and BUG_SOLVING_NOTIFY_CMD layers a
  // real notifier (desktop toast / webhook / etc.) on top. Tokens {url} {title}
  // {slides} {port} {dir} are substituted per UI. Announce to STDOUT so the human
  // (and any log-watcher) knows how they'll be told a cluster is ready.
  const notifyCmd = process.env.BUG_SOLVING_NOTIFY_CMD;
  if (notifyCmd) console.log(`🔔 NOTIFY USER: notify command DEFINED → ${notifyCmd}`);
  else console.log(`🔔 NOTIFY USER: stdout-only (set BUG_SOLVING_NOTIFY_CMD='<cmd with {url} {title} {slides}>' for a real notifier)`);

  const tasks = buildTasks(buildOpts);
  // Do NOT print a live-looking URL here — the server isn't up yet. Just show
  // the RESERVED port per cluster; the actual clickable URL is printed the
  // moment the UI is listening (a "✅ RATING UI READY → open http://…" line
  // from the rating-gate node — see main.ts), so you open it when it's real,
  // not when it's merely reserved.
  console.error(`[scaffolding] built ${tasks.length} task(s). Each cluster boots its OWN read-only rating UI WHEN it solves — watch for a "✅ RATING UI READY" line with the URL, then open it and mark GOOD/BAD. Reserved ports (not live yet):`);
  for (const t of tasks) {
    console.error(`  ${t.slides.map((s) => s.slide_id).join(",").padEnd(24)} :${t.server_port}   [${t.task_id}]  (opens on solve)`);
  }

  // Forward only: the reverse BEFORE is the canonical .sxs-reverse render the user rated.
  if (reversePaths === null) await recordBeforePptx(tasks);
  else await recordReverseBaseline(tasks, reversePaths, reverseChromePort);

  // NOTE: the 3× whole-deck stability classification is NO LONGER a blocking
  // pre-step here. It now runs INSIDE the main graph as its own "stability"
  // branch, CONCURRENTLY with the solve fork-set (main.ts's outer parallelFork
  // over ["forks","stability"]), joined at the barrier before the final merge.
  // This removed the ~5-min startup stall and makes stability a monitor-visible
  // thread. See main.ts:stabilityBranch.

  const engine = isCodex
    ? new CodexEngine({ port: monitorPort, persist: true })
    : new ClaudeEngine({ port: monitorPort, persist: true });
  // BUG_SOLVING_USE_SCHEDULER=1 drives the graph via the new state-machine
  // scheduler instead of the legacy one-shot interpreter (enables
  // restart-from-node). Default off — the legacy path is unchanged.
  if (process.env.BUG_SOLVING_USE_SCHEDULER === "1") {
    engine.useScheduler = true;
    console.error("[scaffold] useScheduler=true (state-machine scheduler path)");
  }
  // Worker model: BUG_SOLVING_MODEL (e.g. "opus" for Opus 4.8, "fable", "sonnet",
  // "haiku") overrides the engine default. ctx.model is sticky (engine fix), so
  // every send — fix, verify, fix-summary — uses this exact model.
  const bsModel = process.env.BUG_SOLVING_MODEL as ("opus" | "sonnet" | "haiku" | "fable" | undefined);
  const session = new Session({ sessionId: `bug_solving-${Date.now()}`, ...(bsModel ? { model: bsModel } : {}) });
  if (bsModel) console.error(`[scaffold] worker model override: ${bsModel}`);

  // Announce each cluster's rating UI to STDERR (what the human watching this
  // process actually sees) the MOMENT its port starts listening — not at start.
  // The UIs boot deep inside the engine graph where their own stdout is captured
  // and never reaches the terminal, so the orchestrator watches the ports itself.
  const announcedPorts = new Set<number>();
  const portWatch = setInterval(() => {
    for (const t of tasks) {
      if (announcedPorts.has(t.server_port)) continue;
      const req = http.get({ host: "127.0.0.1", port: t.server_port, path: "/", timeout: 800 }, (res) => {
        if (!announcedPorts.has(t.server_port)) {
          announcedPorts.add(t.server_port);
          console.error(
            `\n✅ RATING UI READY → open http://localhost:${t.server_port} and mark GOOD/BAD  ` +
              `[${t.task_id}: ${t.slides.map((s) => s.slide_id).join(",")}]\n`,
          );
        }
        res.resume();
      });
      req.on("error", () => { /* not up yet */ });
      req.on("timeout", () => req.destroy());
    }
  }, 1500);
  portWatch.unref?.();

  let results;
  try {
    results = await engine.execute(session, (s) => main({
      session: s,
      tasks,
      direction,
      reverse: reversePaths ? { paths: reversePaths, chromePort: reverseChromePort } : null,
    }));
  } finally {
    clearInterval(portWatch);
  }

  console.error("\n=== RESULTS ===");
  console.error(JSON.stringify(results, null, 2));

  // Tally per-task success/failure for the end-of-run banner. The rating UIs +
  // the accept/merge all ran INSIDE the graph already (each solved fork booted
  // its own UI, blocked on the human rating, and the final merge phase folded the
  // GREEN clusters). The scaffolding just summarizes and preserves the monitor.
  const failures: { idx: number; error: string }[] = [];
  const succeeded: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // Defensive: a result can be null/undefined if the engine's result
    // propagation drops a task's return (observed under the state-machine
    // scheduler). `"error" in r` throws on null — the very crash that turned a
    // whole solved run into an unrecoverable one.
    if (r == null || typeof r !== "object") {
      failures.push({ idx: i, error: `task produced no result (got ${r === null ? "null" : typeof r}) — likely a scheduler result-propagation drop` });
      continue;
    }
    if ("error" in r) {
      failures.push({ idx: i, error: String((r as { error: string }).error) });
      continue;
    }
    const tr = r as TaskResult;
    succeeded.push(`  ${tr.task_id} → rated=${tr.rated} green=${tr.green}${tr.bad_slides.length ? ` bad=[${tr.bad_slides.join(",")}]` : ""} (port ${tr.sxs_server_spec.port})`);
  }

  console.error("\n=== MONITOR & PER-FORK SxS URLs ===");
  if (engine.monitorUrl) console.error(`  engine monitor → ${engine.monitorUrl}`);
  if (succeeded.length) {
    console.error(`  solved forks (rating UIs were booted + gated inside the graph):`);
    for (const u of succeeded) console.error(u);
  }

  // Loud failure reporting — previously a zero-success run silently exited
  // 0, which is indistinguishable from a dry-run. Print a big banner with
  // every failure's task_id + truncated error, and exit non-zero if there
  // were ANY failures so the caller (or a watching shell script) notices.
  if (failures.length) {
    console.error(`\n❌ ${failures.length} of ${results.length} task(s) FAILED:`);
    for (const f of failures) {
      const tid = tasks[f.idx]?.task_id ?? `#${f.idx}`;
      // Compress multiline JSON errors into a one-line-per-failure summary,
      // then include the full error on the next indented line.
      // f.error may be a JSON-serialized Error ({message,stack}) or a plain
      // string; parse defensively and read only those two optional fields.
      let parsed: { message?: string; stack?: string } | null = null;
      try { parsed = JSON.parse(f.error); } catch { /* fall through */ }
      const msg = parsed?.message ?? f.error;
      console.error(`  - ${tid}: ${String(msg).split("\n")[0].slice(0, 200)}`);
      if (parsed?.stack) {
        const firstFrame = String(parsed.stack).split("\n").slice(0, 3).join("\n    ");
        console.error(`    ${firstFrame}`);
      }
    }
    console.error(`\n  Inspect the computation graph at ${engine.monitorUrl ?? "(engine gone)"} for the full trace.`);
  }

  // Done. The structured prompt has returned; each fork's rating server exited
  // when its slides were rated. On failure we DELIBERATELY do not process.exit(1) while the monitor is
  // still serving (persist:true): the in-process monitor IS the trace, and
  // exiting would tear it down exactly when you want to inspect the failure.
  // The listening monitor keeps the event loop alive, so the process stays up
  // and the computation graph remains viewable until you Ctrl-C. Only exit
  // non-zero when there is no monitor to preserve (non-persistent / CI runs).
  if (failures.length) {
    if (engine.monitorUrl) {
      console.error(`\n⚠  ${failures.length} task(s) failed — keeping the monitor ALIVE so you can inspect the trace:`);
      console.error(`     ${engine.monitorUrl}`);
      console.error(`     (the process stays up; Ctrl-C / kill it when done.)`);
    } else {
      process.exit(1);
    }
  }
}

run().catch((e) => {
  console.error("[scaffolding] crashed:", e);
  process.exit(1);
});
