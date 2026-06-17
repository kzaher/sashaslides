/**
 * Runner for the bug_solving structured prompt.
 *
 * This file OWNS the process — it's what `node dist/main-scaffolding.mjs`
 * actually executes. Its job:
 *   1. Resolve the cluster list the user wants to work on.
 *   2. Boot the ClaudeEngine (prints monitor URL to stderr on bind).
 *   3. Run main() to completion.
 *   4. For every successful TaskResult, spawn the filtered rating server
 *      as a DIRECT child of this Node process (not nohup/disown) so the
 *      servers die with the scaffolding on Ctrl-C / SIGTERM / exit.
 *   5. Echo the engine URL + per-task SxS URLs one more time at the end.
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
import { spawn, type ChildProcess } from "child_process";
import { execFile, type ExecException } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
const execFileAsync = promisify(execFile);
import { ClaudeEngine, CodexEngine, Session } from "../../../structured-prompting/src/index.js";
import { buildTasks } from "./workspace-setup.js";
import { main, type TaskResult, type SxsServerSpec } from "./main.js";

// ❌ DO NOT REMOVE this import or replace with a dummy. Create the sibling
// `./clusters.ts` file with your actual cluster definitions. esbuild will
// refuse to build until that file exists — by design, to prevent
// accidental smoke runs. See header for the file template.
import { CLUSTERS } from "./clusters.js";

// Absolute paths to helper scripts. Resolved from the repo root
// (process.cwd()) — the canonical launch command is
//   cd /workspaces/sashaslides && node structured-prompting/dist/main-scaffolding.mjs
// Using process.cwd() keeps the resolution correct whether this file
// runs as a .ts through tsx or as a bundled .mjs in structured-prompting/dist/.
const REPO_ROOT = process.cwd();
const BS_SCRIPTS = resolve(REPO_ROOT, "renderer/structured-prompts/bug_solving/scripts");
const FILTERED_SERVER_TS = resolve(BS_SCRIPTS, "filtered-rating-server.ts");
// record-pptx.sh was inlined into record-rendering.ts. We invoke the
// WORKTREE's copy (per task) so BEFORE is measured by the exact same
// pipeline as AFTER; this is the repo-root-relative path joined onto each
// task's workspace_dir below.
const RECORD_SCRIPT_REL = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";
// Keep fileURLToPath import reachable even if we stop using HERE later.
const _HERE = dirname(fileURLToPath(import.meta.url)); void _HERE;

// Loose registry of launched children — we don't kill them on exit (they
// are detached + unref()'d on purpose), we only track them for the end-of-
// run summary count. Entries auto-drop if the OS cleans them up before we
// print the summary.
const children = new Set<ChildProcess>();

function trackChild(ch: ChildProcess): void {
  children.add(ch);
  ch.on("exit", () => children.delete(ch));
}

// Rating servers are launched detached + unref()'d — they're meant to
// survive scaffolding exit. We deliberately do NOT kill them from
// process.on("exit" | "SIGINT" | "SIGTERM"); Ctrl-C on scaffolding
// leaves the servers alive for continued review. The user kills them
// with `lsof -ti:4720-4800 | xargs -r kill` when done. An
// uncaughtException still exits non-zero but without touching children.
process.on("uncaughtException", (e) => {
  console.error("[scaffolding] uncaughtException:", e);
  process.exit(1);
});

function launchFilteredServer(spec: SxsServerSpec): ChildProcess {
  const args = [
    "tsx", FILTERED_SERVER_TS,
    "--port", String(spec.port),
    "--slides", spec.slides.join(","),
    "--analysis", spec.analysis_md,
    "--diffs", spec.diffs_dir,
    "--thumbnails", spec.thumbnails_dir,
    "--task-title", spec.task_title,
  ];
  // Rating servers are post-run artifacts — the scaffolding should NOT
  // wait for them, and killing the scaffolding shouldn't kill them.
  // `detached: true` starts the child in a NEW process group so a SIGINT
  // to this shell doesn't propagate, and `child.unref()` removes it from
  // Node's event-loop refcount so `main()` returning lets the scaffolding
  // exit while the server keeps running. The child's stdout/stderr go to
  // a log file since we're about to exit and wouldn't read them anyway.
  const ch = spawn("npx", args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  ch.unref();
  trackChild(ch);
  return ch;
}

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
    const outDir = resolve(t.scratch_dir, "before");
    const recScript = resolve(t.workspace_dir, RECORD_SCRIPT_REL);
    const fixturesDir = resolve(t.workspace_dir, t.fixtures_dir);
    try {
      // cwd = <workspace>/renderer so tsx + convert-pptx node_modules resolve.
      // record-rendering writes pptx to <outDir>/pptx/<slide_id>.pptx.
      await execFileAsync("npx", [
        "tsx", recScript,
        "--mode", "pptx", "--fixtures", fixturesDir,
        "--slides", ids, "--out", outDir,
      ], { cwd: resolve(t.workspace_dir, "renderer"), maxBuffer: 32 * 1024 * 1024 });
      console.error(`  [${t.task_id}] before pptx → ${outDir}/pptx`);
    } catch (e: unknown) {
      // TS forbids a type annotation on the catch binding (ts(1196)), so the
      // type goes on the narrowing instead. Node decorates the promisified
      // execFile rejection (an ExecException) with the captured stdout/stderr.
      const err = e as ExecException & { stdout?: string; stderr?: string };
      throw new Error(`record-before failed for ${t.task_id}: ${err.message}\nstdout:${err.stdout ?? ""}\nstderr:${err.stderr ?? ""}`);
    }
  }));
}

async function run(): Promise<void> {
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

  // Fixtures / SxS / ratings dirs are overridable via env so a run can target
  // a different fixture set (e.g. fixtures-basic) without code edits. Each
  // falls back to buildTasks' own default when the env var is unset.
  const buildOpts: Parameters<typeof buildTasks>[0] = { clusters: CLUSTERS, port_base: portBase };
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

  const tasks = buildTasks(buildOpts);
  console.error(`[scaffolding] built ${tasks.length} task(s):`);
  for (const t of tasks) {
    console.error(`  ${t.task_id} @ ${t.workspace_dir} (server port ${t.server_port})`);
  }

  await recordBeforePptx(tasks);

  const engine = isCodex
    ? new CodexEngine({ port: monitorPort, persist: true })
    : new ClaudeEngine({ port: monitorPort, persist: true });
  const session = new Session({ sessionId: `bug_solving-${Date.now()}` });
  const results = await engine.execute(session, (s) => main({ session: s, tasks }));

  console.error("\n=== RESULTS ===");
  console.error(JSON.stringify(results, null, 2));

  // Launch filtered rating servers for every successful task, tracked so
  // they die with this Node process on Ctrl-C / exit / SIGTERM.
  const launchedUrls: string[] = [];
  const failures: { idx: number; error: string }[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if ("error" in r) {
      failures.push({ idx: i, error: String((r as { error: string }).error) });
      continue;
    }
    const spec: SxsServerSpec = (r as TaskResult).sxs_server_spec;
    launchFilteredServer(spec);
    launchedUrls.push(`  ${(r as TaskResult).task_id} → http://localhost:${spec.port}`);
  }

  // Re-print the engine URL and every server URL at the end so the
  // reviewer never has to scroll back through logs to find them.
  console.error("\n=== MONITOR & SxS URLs ===");
  if (engine.monitorUrl) console.error(`  engine monitor → ${engine.monitorUrl}`);
  if (launchedUrls.length) {
    console.error(`  filtered rating servers:`);
    for (const u of launchedUrls) console.error(u);
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

  console.error(`\n[scaffolding] ${children.size} detached server(s) running.`);
  if (children.size) console.error(`They will survive scaffolding exit; kill them with: lsof -ti:4720-4800 | xargs -r kill`);

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
