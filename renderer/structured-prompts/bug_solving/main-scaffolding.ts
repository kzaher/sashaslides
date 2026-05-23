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
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
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
  // Env-var overrides so a single skill invocation can target an arbitrary
  // fixture/SxS dir (e.g. the table-only set under /tmp/tables-bs) without
  // touching DEFAULTS in workspace-setup. Each var is optional — when unset
  // workspace-setup keeps its complex-fixture defaults.
  const fixtures_dir = process.env.BUG_SOLVING_FIXTURES_DIR;
  const sxs_dir = process.env.BUG_SOLVING_SXS_DIR;
  const ratings_json = process.env.BUG_SOLVING_RATINGS_JSON;
  // When seeding from a prior bug-solving worktree, that worktree must be
  // exempt from the cleanup sweep that runs at the start of buildTasks —
  // otherwise the source files are gc'd before the seed copy fires.
  const seedFrom = process.env.BUG_SOLVING_SEED_FROM;
  const tasks = buildTasks({
    clusters: CLUSTERS,
    baseline_dir,
    ...(fixtures_dir ? { fixtures_dir: resolve(fixtures_dir) } : {}),
    ...(sxs_dir ? { sxs_dir: resolve(sxs_dir) } : {}),
    ...(ratings_json ? { ratings_json: resolve(ratings_json) } : {}),
    ...(seedFrom ? { preserve_worktrees: [resolve(seedFrom)] } : {}),
  });

  // Seed each worktree with starting-point files. Two env vars:
  //   BUG_SOLVING_SEED_FILES  — comma-separated repo-relative paths.
  //   BUG_SOLVING_SEED_FROM   — source repo root (default: process.cwd()).
  // Use cases:
  //   1. Seed from main's uncommitted edits: SEED_FROM unset → reads cwd.
  //   2. Continue an iteration from a previous wave's worktree by setting
  //      SEED_FROM to that worktree's path. Lets wave-N+1 build on the
  //      worker's end state without forcing a commit between waves.
  const seedSpec = process.env.BUG_SOLVING_SEED_FILES;
  if (seedSpec) {
    const seedPaths = seedSpec.split(",").map((s) => s.trim()).filter(Boolean);
    const seedRoot = seedFrom ? resolve(seedFrom) : process.cwd();
    console.error(`[seed] source: ${seedRoot}`);
    for (const task of tasks) {
      for (const rel of seedPaths) {
        const src = resolve(seedRoot, rel);
        const dst = resolve(task.workspace_dir, rel);
        if (!existsSync(src)) {
          console.error(`[seed] skip (missing in source): ${rel}`);
          continue;
        }
        // copyFileSync follows the worktree's symlink for node_modules; the
        // explicit readFileSync→writeFileSync detour is to avoid corrupting
        // the source file when the worktree happens to symlink into it.
        const data = readFileSync(src);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, data);
        console.error(`[seed] ${task.task_id}: ${rel}`);
      }
    }
  }
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
