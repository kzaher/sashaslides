#!/usr/bin/env npx tsx
/**
 * view-graph.ts — Boot the structured-prompting monitor server against a
 * graph snapshot persisted by a previous engine run.
 *
 * Use case: an engine run finished (or the host process was restarted),
 * but you still want to inspect the tree and ask follow-up questions
 * against the original send sessions. Each /api/ask call still works
 * because it just resumes the node's stored sessionId with
 * --fork-session — the engine itself is not needed.
 *
 * The loaded graph keeps writing follow-ups back to the same file, so
 * you can re-launch view-graph again later and find your earlier
 * follow-ups still attached.
 *
 * Usage:
 *   npx tsx src/view-graph.ts <snapshot.json> [--port 4711]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ComputationGraph } from "./graph.js";
import { startMonitor } from "./server.js";

async function main() {
  const args = process.argv.slice(2);
  const path = args[0];
  if (!path) {
    console.error("Usage: npx tsx src/view-graph.ts <snapshot.json> [--port N]");
    process.exit(2);
  }
  let port = 4711;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port") port = parseInt(args[++i], 10);
  }

  const abs = resolve(path);
  const snap = JSON.parse(readFileSync(abs, "utf-8"));
  const graph = ComputationGraph.fromSnapshot(snap);
  // Re-enable persistence to the same file so any follow-ups asked here
  // accumulate alongside the original run's nodes.
  graph.enablePersistence(abs);

  const monitor = await startMonitor({ graph, port });
  console.error(`\n┌── view-graph (read-only restore from ${abs})`);
  console.error(`│ ${monitor.url}`);
  console.error(`│ ${graph.allNodes().length} nodes loaded`);
  console.error(`└──\n`);

  // Stay alive until SIGINT/SIGTERM.
  const stop = async () => {
    try { await monitor.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
