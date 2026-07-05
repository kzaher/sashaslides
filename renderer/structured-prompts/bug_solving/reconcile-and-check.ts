#!/usr/bin/env npx tsx
/**
 * reconcile-and-check.ts — the bug_solving RESTART PREFLIGHT.
 *
 * Reads the four ledgers → reconcileLedgers → checkReconciled → prints the
 * reconciled bad set (per-slide status / issue / conflicts), the check
 * failures + warnings, and (with --emit-clusters) the generated clusters.ts.
 *
 * EXITS NON-ZERO when the check is NOT ok (a missing fixture, an empty issue, an
 * unresolved conflict, a bad id) so a restart script can gate on it and fail
 * EARLY rather than launching a solve against a wrong bad set.
 *
 * Flags (all optional; sensible defaults):
 *   --candidates <path>   default .bug-solving-history/candidates.json
 *   --baseline   <path>   default renderer/html2slides/e2e/.ratings-complex.json
 *   --history    <path>   default .bug-solving-history/ratings.json
 *   --live       <path>   default /tmp/sxs-complex/ratings.json
 *   --fixtures   <dir>    default renderer/html2slides/e2e/fixtures-complex
 *   --images     <dir>    default /tmp/sxs-complex
 *   --retry-budget <n>    default 5 (for --emit-clusters)
 *   --emit-clusters       also print the generated clusters.ts source
 *   --no-images           skip the C4 image check
 */
import {
  reconcileLedgers,
  loadLedger,
  checkReconciled,
  bySlideNumber,
} from "./reconcile-ledgers.js";
import { generateClusters } from "./generate-clusters.js";

const REPO = "/workspaces/sashaslides";
const DEFAULTS = {
  candidates: `${REPO}/.bug-solving-history/candidates.json`,
  baseline: `${REPO}/renderer/html2slides/e2e/.ratings-complex.json`,
  history: `${REPO}/.bug-solving-history/ratings.json`,
  live: "/tmp/sxs-complex/ratings.json",
  fixtures: `${REPO}/renderer/html2slides/e2e/fixtures-complex`,
  images: "/tmp/sxs-complex",
};

function argVal(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function main(): void {
  const candidates = loadLedger(argVal("--candidates", DEFAULTS.candidates));
  const baseline = loadLedger(argVal("--baseline", DEFAULTS.baseline));
  const history = loadLedger(argVal("--history", DEFAULTS.history));
  const live = loadLedger(argVal("--live", DEFAULTS.live));

  const reconciled = reconcileLedgers({ candidates, baseline, history, live });

  const fixturesDir = argVal("--fixtures", DEFAULTS.fixtures);
  const imagesDir = process.argv.includes("--no-images")
    ? undefined
    : argVal("--images", DEFAULTS.images);
  const report = checkReconciled(reconciled, { fixturesDir, imagesDir });

  // ---- reconciled bad set -------------------------------------------------
  console.log("=== Reconciled bad set (needsSolve) ===");
  if (!reconciled.badSet.length) {
    console.log("  (none)");
  }
  for (const id of reconciled.badSet) {
    const s = reconciled.slides[id];
    const srcs = Object.entries(s.sources).map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(`  ${id}  [${srcs}]`);
    console.log(`      issue: ${s.issue || "(none)"}`);
    for (const c of s.conflicts) console.log(`      conflict: ${c}`);
  }

  // ---- full reconciled view (compact) -------------------------------------
  console.log("\n=== All reconciled slides ===");
  for (const id of Object.keys(reconciled.slides).sort(bySlideNumber)) {
    const s = reconciled.slides[id];
    const flag = s.needsSolve ? "BAD " : s.status === "good" ? "good" : "----";
    console.log(`  ${flag} ${id}${s.conflicts.length ? `  (${s.conflicts.length} conflict)` : ""}`);
  }

  // ---- check report -------------------------------------------------------
  console.log("\n=== Check report ===");
  console.log(`  ok: ${report.ok}`);
  console.log(`  badSet: [${report.badSet.join(", ")}]`);
  if (report.failures.length) {
    console.log("  FAILURES:");
    for (const f of report.failures) console.log(`    ✗ ${f}`);
  }
  if (report.warnings.length) {
    console.log("  warnings:");
    for (const w of report.warnings) console.log(`    ⚠ ${w}`);
  }
  if (!report.failures.length && !report.warnings.length) {
    console.log("  (clean — no failures, no warnings)");
  }

  // ---- optional cluster emission ------------------------------------------
  if (process.argv.includes("--emit-clusters")) {
    const retryBudget = Number(argVal("--retry-budget", "5")) || 5;
    const source = generateClusters(reconciled, { retryBudget });
    console.log("\n=== Generated clusters.ts (review before --write) ===");
    console.log(source);
  }

  process.exit(report.ok ? 0 : 1);
}

main();
