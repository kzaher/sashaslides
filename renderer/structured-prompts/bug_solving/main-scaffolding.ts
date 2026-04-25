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
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
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
 * Record the shared baseline ONCE for every unique slide in the wave.
 * Every task then references this path instead of rebuilding its own
 * "before" pptx inside its worktree. Re-uses an existing baseline if
 * BUG_SOLVING_BASELINE_DIR is set in the env — useful when re-running
 * the wave after a cluster fails.
 */
function recordSharedBaseline(): string {
  const reuse = process.env.BUG_SOLVING_BASELINE_DIR;
  if (reuse && existsSync(reuse)) {
    console.error(`[baseline] reusing ${reuse}`);
    return reuse;
  }
  const all = new Set<string>();
  for (const c of CLUSTERS) for (const id of c.slide_ids) all.add(id);
  const slides = [...all].sort();
  const ts = Date.now();
  const out = resolve(`/tmp/bs-baseline-${ts}`);
  mkdirSync(out, { recursive: true });
  console.error(`[baseline] recording ${slides.length} slide(s) → ${out}`);
  execSync(
    `npx tsx renderer/structured-prompts/bug_solving/scripts/baseline-record.ts ` +
    `--slides ${slides.join(",")} --out ${out}`,
    { stdio: "inherit" },
  );
  return out;
}

async function run() {
  const baseline_dir = recordSharedBaseline();
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
