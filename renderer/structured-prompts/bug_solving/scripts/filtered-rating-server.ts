#!/usr/bin/env npx tsx
/**
 * filtered-rating-server.ts — COMPATIBILITY WRAPPER.
 *
 * The bug_solving task-scoped rating UI is no longer a separate server;
 * it lives in the standard `renderer/html2slides/rating-server.ts` behind
 * the flags `--filter-slides`, `--slides-dir`, `--originals-dir`,
 * `--task-analysis`, `--task-diffs`, `--task-title`. That way the
 * task-scoped view keeps every standard rating-UI control (Good / Bad /
 * Skip, annotations, Ctrl-Z undo, diff overlay, etc.) and just gains two
 * extra buttons per slide.
 *
 * This file stays in the tree because the currently-deployed
 * `main-scaffolding.mjs` bundle spawns `npx tsx <FILTERED_SERVER_TS>` with
 * the old argv shape. Rather than kill in-flight clusters and rebuild, we
 * translate the old flags into the new ones and exec rating-server.ts.
 *
 * Old argv (what scaffolding still passes):
 *   --port N --slides csv --analysis md --diffs dir --thumbnails dir
 *   [--originals dir] [--task-title str]
 * New argv (forwarded to rating-server):
 *   <scratch-as-resultsDir> --port N
 *     --filter-slides csv
 *     --slides-dir <old --thumbnails>
 *     --originals-dir <old --originals || /tmp/sxs-complex/originals>
 *     --task-analysis <old --analysis>
 *     --task-diffs <old --diffs>
 *     --task-title <old --task-title>
 */
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const argv = process.argv.slice(2);
const get = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const port = get("--port") ?? "3456";
const slidesCsv = get("--slides") ?? "";
const analysis = get("--analysis");
const diffs = get("--diffs");
const thumbnails = get("--thumbnails");
const title = get("--task-title") ?? "bug_solving";

if (!slidesCsv || !analysis || !diffs || !thumbnails) {
  console.error("filtered-rating-server wrapper: missing required arg (--slides, --analysis, --diffs, --thumbnails)");
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const RATING_SERVER = resolve(REPO, "renderer/html2slides/rating-server.ts");
// The rating server takes a positional `results_dir`; the overrides make it
// irrelevant, but we still pass something reasonable (the scratch dir the
// thumbnails live under) so meta.json / ratings.json persistence works.
const resultsDir = resolve(thumbnails, "..");

// Originals dir: prefer the explicit flag, then the results dir's OWN originals/
// (Chrome screenshots that record-rendering --mode full writes next to thumbs),
// then the legacy shared dir only if it still exists. Never pass a non-existent
// path — a stale /tmp/sxs-complex/originals used to crash the server on an
// unguarded readdir. If none exist, omit the override entirely.
const originals =
  get("--originals") ??
  (existsSync(resolve(resultsDir, "originals")) ? resolve(resultsDir, "originals")
    : existsSync("/tmp/sxs-complex/originals") ? "/tmp/sxs-complex/originals"
      : null);

const forwarded = [
  "tsx", RATING_SERVER, resultsDir,
  "--port", port,
  "--filter-slides", slidesCsv,
  "--slides-dir", thumbnails,
  ...(originals ? ["--originals-dir", originals] : []),
  "--task-analysis", analysis,
  "--task-diffs", diffs,
  "--task-title", title,
];

console.log(`[filtered-rating-server wrapper] exec → npx ${forwarded.join(" ")}`);
const ch = spawn("npx", forwarded, {
  stdio: ["ignore", "inherit", "inherit"],
  detached: false,
});
// Propagate signals and exit codes so scaffolding's exit-handlers reach
// the underlying rating-server child.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { try { ch.kill(sig); } catch {} });
}
ch.on("exit", (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
