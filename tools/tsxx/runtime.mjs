// tsxx runtime — imported (once, by URL) into every instrumented module.
// Hot-path tick() pushes onto a single array. On exit, write NDJSON +
// human-readable profile and aggregate-by-location summary.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ticks = [];
const t0 = performance.now();

export const __tsxx = {
  tick(file, line, col, preview) {
    ticks.push({
      f: file,
      l: line,
      c: col,
      p: preview,
      t: performance.now() - t0,
    });
  },
};

const dir = mkdtempSync(join(tmpdir(), "tsxx-"));
const ndjsonPath = join(dir, "profile.ndjson");
const summaryPath = join(dir, "profile.txt");

// Minimum duration (ms) below which a tick is hidden from the human-readable
// profile.txt. Configurable via TSXX_MIN_MS env var. Default 100ms — at this
// threshold sub-millisecond statement noise drops away and only the work
// that actually matters survives. Pass `TSXX_MIN_MS=0` to see every tick.
// The NDJSON file is NEVER filtered — downstream tooling can pick its own
// threshold against the raw record.
const MIN_MS = (() => {
  const raw = process.env.TSXX_MIN_MS;
  if (raw === undefined || raw === "") return 100;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 100;
})();

let wrote = false;
function writeReport() {
  if (wrote) return;
  wrote = true;

  const totalElapsed = performance.now() - t0;
  const enriched = ticks.map((t, i) => {
    const next = ticks[i + 1];
    const dur = (next ? next.t : totalElapsed) - t.t;
    return { ...t, dur };
  });

  // NDJSON — one record per tick (always unfiltered).
  writeFileSync(ndjsonPath, enriched.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // Human-readable trace + aggregated top-N. Both views honor MIN_MS:
  //   * Sequential trace drops any tick whose duration is below the threshold.
  //   * Top-N drops any (file:line:col) whose summed total is below it.
  const trace = [];
  const banner =
    MIN_MS > 0
      ? `tsxx profile — ${enriched.length} statements, total ${totalElapsed.toFixed(2)}ms (filter: TSXX_MIN_MS=${MIN_MS}ms)`
      : `tsxx profile — ${enriched.length} statements, total ${totalElapsed.toFixed(2)}ms`;
  trace.push(banner);
  trace.push("");
  trace.push("=== Sequential trace ===");
  let shownTicks = 0;
  for (const r of enriched) {
    if (r.dur < MIN_MS) continue;
    trace.push(`[+${r.dur.toFixed(3).padStart(10, " ")}ms] ${r.f}:${r.l}:${r.c}  ${r.p}`);
    shownTicks += 1;
  }
  if (MIN_MS > 0) {
    trace.push(`(${enriched.length - shownTicks} tick(s) below ${MIN_MS}ms hidden)`);
  }

  const agg = new Map();
  for (const r of enriched) {
    const key = `${r.f}:${r.l}:${r.c}`;
    const e = agg.get(key) ?? { key, preview: r.p, count: 0, total: 0 };
    e.count += 1;
    e.total += r.dur;
    agg.set(key, e);
  }
  const sortedAll = [...agg.values()].sort((a, b) => b.total - a.total);
  const sortedFiltered = sortedAll.filter((e) => e.total >= MIN_MS).slice(0, 50);
  trace.push("");
  trace.push(
    MIN_MS > 0
      ? `=== Top ${sortedFiltered.length} lines by total time (≥ ${MIN_MS}ms) ===`
      : `=== Top 50 lines by total time ===`,
  );
  for (const e of sortedFiltered) {
    trace.push(
      `${e.total.toFixed(2).padStart(10, " ")}ms  (${String(e.count).padStart(5, " ")}× avg ${(e.total / e.count).toFixed(2)}ms)  ${e.key}  ${e.preview}`,
    );
  }
  if (MIN_MS > 0) {
    const hiddenAgg = sortedAll.length - sortedFiltered.length;
    if (hiddenAgg > 0) {
      trace.push(`(${hiddenAgg} location(s) with total < ${MIN_MS}ms hidden)`);
    }
  }

  writeFileSync(summaryPath, trace.join("\n") + "\n");
}

process.on("exit", () => {
  try {
    writeReport();
  } catch (e) {
    process.stderr.write(`tsxx: failed to write report: ${e}\n`);
    return;
  }
  process.stderr.write(`\ntsxx: profile stored to ${summaryPath}\n`);
  process.stderr.write(`tsxx: raw NDJSON at  ${ndjsonPath}\n`);
});

// Make sure SIGINT/SIGTERM still triggers 'exit' (default behavior is to
// terminate without firing exit listeners on uncaught signal in some envs).
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
