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
 *     (runTask steps A1–A3), then writes a rating-outcome.json marker to its
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
 *   BUG_SOLVING_RATING_TIMEOUT_MS=N  per-fork blocking-wait budget.
 *       Default (unset): 0 = wait FOREVER when stdin is a TTY; a finite
 *       default (30 min) when NOT a TTY, after which still-unrated slides
 *       are treated as NOT-GREEN so an unattended run can't hang.
 *       An explicit value applies regardless of TTY; 0 = forever always.
 *
 * ## Filling in task data (required before build)
 *   The `CLUSTERS` import below points at `./clusters.ts`, which DOES NOT
 *   EXIST in the repo. Create it with your actual bug clusters:
 *
 *     // renderer/structured-prompts/bug_solving/clusters.ts
 *     import type { Cluster } from "./workspace-setup.js";
 *     export const CLUSTERS: Cluster[] = [
 *       {
 *         task_id: "clipping-curves",
 *         cluster_description: "overflow:hidden + border-radius not honored",
 *         slide_ids: ["slide_11", "slide_12", "slide_14", "slide_28"],
 *       },
 *     ];
 *
 *   Until you create that file, the build will fail with
 *   "Could not resolve './clusters.js'" — this is intentional. It prevents
 *   accidental runs of an empty or demo cluster list.
 *
 * ## Build + run
 *   npx tsx structured-prompting/build.ts \
 *       renderer/structured-prompts/bug_solving/main-scaffolding.ts
 *   node structured-prompting/dist/main-scaffolding.mjs
 *
 * ## Monitor URL
 *   Engine prints it on stderr as soon as it binds the port (look for
 *   `┌── structured-prompting monitor`). We echo it again at end of run.
 */
import { execFile, type ExecException } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
const execFileAsync = promisify(execFile);
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { ClaudeEngine, CodexEngine, Session, WORKSPACE_SCRIPT } from "../../../structured-prompting/src/index.js";
import { buildTasks, selectOnlyClusters } from "./workspace-setup.js";
// (stability recording now lives in the main graph — main.ts:stabilityBranch)
import { main, type TaskResult } from "./main.js";
import { cleanupAllOverlays } from "./overlay-cleanup.js";
import {
  detectPriorState,
  decideStartup,
  parseStartupFlags,
  DEFAULT_BRANCHES_ROOT,
  DEFAULT_SHARED_ROOT,
} from "./startup-detection.js";
import { resumeMerge } from "./resume-merge.js";

// ❌ DO NOT REMOVE this import or replace with a dummy. Create the sibling
// `./clusters.ts` file with your actual cluster definitions. esbuild will
// refuse to build until that file exists — by design, to prevent
// accidental smoke runs. See header for the file template.
import { clustersFromRatings } from "./generate-clusters.js";
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
// The COW-workspace runner (absolute), owned by the structured-prompting
// library. A bug_solving branch is just a CowWorkspace over the repo.
const OVERLAY_BRANCH_SH = WORKSPACE_SCRIPT;
// Keep fileURLToPath import reachable even if we stop using HERE later.
const _HERE = dirname(fileURLToPath(import.meta.url)); void _HERE;

// The per-fork rating UIs are now booted INSIDE the graph (runTask step A1,
// detached via setsid), not here — so the scaffolding tracks no child servers.
// An uncaughtException still exits non-zero. Those detached servers survive
// scaffolding exit; the user kills them with `lsof -ti:4720-4800 | xargs -r kill`.
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
    const inner =
      `ROOT="$PWD"; cd "$ROOT/renderer" && ` +
      `npx tsx "$ROOT/${RECORD_SCRIPT_REL}" --mode pptx ` +
      `--fixtures "$ROOT/${t.fixtures_dir}" --slides ${ids} ` +
      `--out "$ROOT/${t.scratch_dir}/before"`;
    try {
      await execFileAsync("bash", [
        OVERLAY_BRANCH_SH, "run", t.branch_id, "bash", "-c", inner,
      ], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 });
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
  const monitorPort = isCodex ? 4712 : 4711;
  const portBase = isCodex ? 4760 : 4720;
  console.error(`[scaffold] engine: ${engineKind} (monitor :${monitorPort}, task ports ${portBase}-${portBase + 39})`);

  // JAIL ON for solve + merge. Set BEFORE any workspace.sh run (recordBeforePptx,
  // the engine's per-fork solve commands, and the final merge). Every `run` then
  // sandboxes the worker CLI + retest: the base REPO is overlay copy-on-write,
  // /tmp is a disposable tmpfs, everything else read-only.
  process.env.COW_WORKSPACE_JAIL = "1";
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
    await resumeMerge({ repo: REPO_ROOT, engine: engineKind });
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
  // No clusters.ts, no ledger reconciliation that could let a stale history
  // override your current ratings.
  const ratingsPath = process.env.BUG_SOLVING_RATINGS_JSON ?? "/tmp/sxs-complex/ratings.json";
  const sxsDir = process.env.BUG_SOLVING_SXS_DIR ?? "/tmp/sxs-complex";
  const fixturesDir = process.env.BUG_SOLVING_FIXTURES_DIR ?? "renderer/html2slides/e2e/fixtures";
  const liveClusters = clustersFromRatings(ratingsPath, { retryBudget });
  printBrokenSlides(liveClusters, ratingsPath, sxsDir, fixturesDir);
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
  console.error(`[scaffolding] built ${tasks.length} task(s):`);
  for (const t of tasks) {
    console.error(`  ${t.task_id} @ ${t.workspace_dir} (server port ${t.server_port})`);
  }

  await recordBeforePptx(tasks);

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
  const results = await engine.execute(session, (s) => main({ session: s, tasks }));

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

  console.error(`\n[scaffolding] per-fork rating servers were booted inside the graph (detached via setsid).`);
  console.error(`They will survive scaffolding exit; kill them with: lsof -ti:4720-4800 | xargs -r kill`);

  // Done. The structured prompt has returned and rating-servers are detached.
  // On failure we DELIBERATELY do not process.exit(1) while the monitor is
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
