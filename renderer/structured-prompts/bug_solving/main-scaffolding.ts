/**
 * Scaffolding for running the bug_solving structured prompt end-to-end.
 *
 * Parses the cluster list from argv (or falls back to a single smoke-test
 * cluster), builds tasks via workspace-setup, and executes main.ts. The
 * engine keeps its monitor UI on port 4711 by default.
 *
 * Usage (real):
 *   npx tsx build.ts renderer/structured-prompts/bug_solving/main-scaffolding.ts \
 *     && node dist/main-scaffolding.mjs
 */
import { mkdirSync } from "fs";
import { resolve } from "path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import { buildTasks } from "./workspace-setup.js";
// clusters.ts is the per-wave input — edit it to redeclare what you want
// solved, then rebuild + run. Kept as a separate import (not inline) so
// the build fails loudly when someone deletes it by mistake rather than
// silently running an obsolete smoke cluster.
import { CLUSTERS } from "./clusters.js";
import { main } from "./main.js";

/**
 * Choose a baseline directory path WITHOUT recording into it — the recording
 * itself is a graph node (see main.ts step 0) so it shows up in the monitor.
 * BUG_SOLVING_BASELINE_DIR overrides; scratch dir is created so the
 * baseline-record script can write into it.
 */
function chooseBaselineDir(): string {
  const reuse = process.env.BUG_SOLVING_BASELINE_DIR;
  if (reuse) {
    mkdirSync(reuse, { recursive: true });
    return resolve(reuse);
  }
  const out = resolve(`/tmp/bs-baseline-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  return out;
}

async function run() {
  const baseline_dir = chooseBaselineDir();
  const tasks = buildTasks({ clusters: CLUSTERS, baseline_dir });
  console.error(`built ${tasks.length} task(s) with baseline=${baseline_dir}:`);
  for (const t of tasks) {
    console.error(`  ${t.task_id} @ ${t.workspace_dir} (port ${t.server_port})`);
  }

  // Graph persistence: every mutation writes a JSON snapshot to
  // /tmp/bug_solving-graph-<ts>.json (overridable via env SP_GRAPH_PATH).
  // After a crash, point `npx tsx structured-prompting/src/server/view-graph.ts <path>`
  // at that file to re-attach the monitor + ask follow-ups against any
  // node that still has a sessionId.
  const graphPath = process.env.SP_GRAPH_PATH ?? `/tmp/bug_solving-graph-${Date.now()}.json`;
  const engine = new ClaudeEngine({ port: 4711, persist: true, graphPersistPath: graphPath });
  console.error(`[scaffold] graph persistence: ${graphPath}`);
  const session = new Session({ sessionId: `bug_solving-${Date.now()}` });
  let results: unknown;
  try {
    results = await engine.execute(session, (s) => main({ session: s, tasks }));
  } catch (e) {
    // Log the error in detail (was silently empty `{}` before because
    // some thrown values are plain objects without enumerable props).
    console.error("\n=== ENGINE THREW ===");
    const err = e as { name?: string; message?: string; stack?: string; data?: unknown };
    console.error(`name: ${err?.name ?? "<unknown>"}`);
    console.error(`message: ${err?.message ?? String(e)}`);
    if (err?.stack) console.error(`stack:\n${err.stack}`);
    if (err?.data !== undefined) try { console.error(`data: ${JSON.stringify(err.data, null, 2)}`); } catch { /* ignore */ }
    console.error(`graph snapshot persisted at: ${graphPath}`);
    console.error("To re-attach the monitor against the saved graph:");
    console.error(`  npx tsx structured-prompting/src/server/view-graph.ts ${graphPath}`);
    console.error(`Monitor still live at ${engine.monitorUrl} for as long as this process runs.`);
    return;
  }

  console.error("\n=== RESULTS ===");
  console.error(JSON.stringify(results, null, 2));
  console.error(`\nMonitor still live at ${engine.monitorUrl}`);
  console.error(`Graph snapshot persisted at: ${graphPath}`);
  console.error(
    "\nPer-task SxS servers (if step 8 completed successfully):\n" +
    tasks.map(t => `  ${t.task_id} → http://localhost:${t.server_port}`).join("\n"),
  );
  console.error("\nPress Ctrl-C when done reviewing.");
}

run().catch((e) => {
  // Surface FULL diagnostics — was previously empty `{}` for non-Error throws.
  const err = e as { name?: string; message?: string; stack?: string };
  console.error("bug_solving scaffold-level crash:");
  console.error(`  name: ${err?.name ?? "<unknown>"}`);
  console.error(`  message: ${err?.message ?? String(e)}`);
  if (err?.stack) console.error(`  stack:\n${err.stack}`);
  process.exit(1);
});
