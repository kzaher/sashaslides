/**
 * Scaffolding for running the bug_solving structured prompt end-to-end.
 *
 * Parses the cluster list from argv (or falls back to a single smoke-test
 * cluster), builds tasks via workspace-setup, and executes main.ts. The
 * engine keeps its monitor UI on port 4711 by default.
 *
 * Usage (real):
 *   npx tsx build.ts renderer/html2slides/structured-prompts/bug_solving/main-scaffolding.ts \
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

  const engine = new ClaudeEngine({ port: 4711, persist: true });
  const session = new Session({ sessionId: `bug_solving-${Date.now()}` });
  const results = await engine.execute(session, (s) => main({ session: s, tasks }));

  console.error("\n=== RESULTS ===");
  console.error(JSON.stringify(results, null, 2));
  console.error(`\nMonitor still live at ${engine.monitorUrl}`);
  console.error(
    "\nPer-task SxS servers (if step 8 completed successfully):\n" +
    tasks.map(t => `  ${t.task_id} → http://localhost:${t.server_port}`).join("\n"),
  );
  console.error("\nPress Ctrl-C when done reviewing.");
}

run().catch((e) => {
  console.error("bug_solving crashed:", e);
  process.exit(1);
});
