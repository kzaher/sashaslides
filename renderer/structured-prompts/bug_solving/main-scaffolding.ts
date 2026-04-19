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
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import { buildTasks, Cluster } from "./workspace-setup.js";
import { main } from "./main.js";

// For smoke-testing we run a single tiny cluster. In production, edit this
// or pass a JSON file via argv.
const SMOKE_CLUSTERS: Cluster[] = [
  {
    task_id: "smoke-clipping",
    cluster_description:
      "Smoke test: verify the pipeline runs end-to-end on a single 2-slide cluster. " +
      "The real fix is not expected to land here.",
    slide_ids: ["slide_11", "slide_12"],
  },
];

async function run() {
  const tasks = buildTasks({ clusters: SMOKE_CLUSTERS });
  console.error(`built ${tasks.length} task(s):`);
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
