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
import { execFile } from "child_process";
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
const RECORD_SCRIPT = resolve(BS_SCRIPTS, "record-pptx.sh");
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
    try {
      await execFileAsync("bash", [
        RECORD_SCRIPT, "--slides", ids, "--label", "before", "--out", outDir,
      ], { cwd: t.workspace_dir, maxBuffer: 32 * 1024 * 1024 });
      console.error(`  [${t.task_id}] before pptx → ${outDir}`);
    } catch (e: any) {
      throw new Error(`record-before failed for ${t.task_id}: ${e.message}\nstdout:${e.stdout?.toString() ?? ""}\nstderr:${e.stderr?.toString() ?? ""}`);
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

  const tasks = buildTasks({ clusters: CLUSTERS, port_base: portBase });
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
      let parsed: any = null;
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

  // Done. The structured prompt has returned, rating-servers are detached
  // with unref() so they keep running independently, and Node's event loop
  // has no more work — this line runs and the process exits naturally
  // (non-zero iff any task failed). The exit handlers installed earlier
  // are no longer needed for children (they're unrefed and won't die with
  // us) but they stay in place as a safety net for pre-launch crashes.
  if (failures.length) process.exit(1);
}

run().catch((e) => {
  console.error("[scaffolding] crashed:", e);
  process.exit(1);
});
