/**
 * merge-e2e.test.ts — the FULL merge process end-to-end through the PRODUCTION
 * seam `realLlmMergeOps`, obeying the strict mock policy (see test-support.ts):
 * the ONLY mocked things are (H) the human green/red rating, (L) the LLM compose
 * call, and (R) the Google-Slides recording. EVERYTHING else is REAL — the engine
 * runs on a REAL IO (real bash/git/fs/clock via `mockLlm`, which intercepts only
 * the claude spawn), REAL COW overlay forks, the REAL merged-file promote onto the
 * base tree, the REAL dual-class regression gate reading a REAL stability.json, the
 * REAL all-at-once→sequential fallback, and the REAL demote ledger (candidates.json).
 *
 * Terminology: a fork's fold either KEEPS its stability (binary/pixel for a
 * pixel-perfect slide; xml + rendered for an xml-stable slide) or it doesn't — a
 * fold that doesn't keep stability is simply NOT MERGED (there is no "violation").
 *
 * Cases:
 *   (1) clean all-at-once            → both forks merged; ledger untouched.
 *   (2) non-targeted ripple          → sequential fallback: keep + merge the clean
 *       fork, roll back + REAL-demote the diverging fork; fork B folds on the
 *       POST-fork-A base (serial target mutation, via the tagged LLM log).
 *   (3) pixel-perfect fork can't keep binary stability      → not merged + demoted.
 *   (4) xml-stable fork can't keep xml+rendered stability   → not merged + demoted.
 *   (5) no green clusters            → no-op: no merge, no demote.
 *   (6) CONTINUE past a fork that can't keep stability — a later fork that DOES
 *       keep its stability still merges (one failure never blocks the others).
 *   (7) a MERGED green is the reference — a later fork that would regress it doesn't
 *       keep that slide's stability → not merged; the merged green is preserved.
 *   (8) human marker round-trip      → a rating-outcome written inside a workspace
 *       is readable outside (the green/red hand-off the merge reads).
 *   (9) no /overlays leaks.
 * Plus: proof the ONLY mocked calls were LLM + recording (tagged).
 *
 * Requires CAP_SYS_ADMIN + /overlays; SKIPs loudly (exit 0) otherwise.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import { realLlmMergeOps, type MergeRenderSeam } from "./llm-merge.js";
import { writeStabilityJson } from "./stability.js";
import {
  mockLlm, mergeComposer, fencedBlocks, recordingFromContent, recordingSeam, contentRecord,
  greenCluster, writeRatingOutcome, runRealMerge,
} from "./test-support.js";

let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 8).join("\n      ")}`); }
}
function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); } catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

const CONVERTER_REL = "renderer/html2slides/convert-pptx.ts";
const BASE_FILE = ["// convert-pptx.ts (test fixture)", "export const A = 1;", ""].join("\n");

/** A base repo (git-initialised so the engine's REAL git-diff-capture works) with
 *  the converter file, a fixtures deck, and a stability.json. */
function setupBase(tag: string, stab: { pixelPerfect: string[]; xmlStable: string[]; unstable: string[] }): { base: string; fixturesDir: string; stabilityPath: string; historyDir: string } {
  const base = mkdtempSync(join(tmpdir(), `merge-e2e-${tag}-`));
  mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
  writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
  const fixturesDir = join(base, "fx");
  mkdirSync(fixturesDir, { recursive: true });
  for (const sid of [...stab.pixelPerfect, ...stab.xmlStable, ...stab.unstable]) writeFileSync(join(fixturesDir, `${sid}.html`), "<html></html>");
  const stabilityPath = join(base, "stability.json");
  writeStabilityJson(stabilityPath, { ...stab, warning: "", attempts: 3 });
  execSync(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base`, { cwd: base });
  const historyDir = mkdtempSync(join(tmpdir(), `merge-e2e-hist-${tag}-`));
  return { base, fixturesDir, stabilityPath, historyDir };
}
function makeFork(base: string, upperRoot: string, id: string, fixConst: string) {
  const ws = createCowWorkspace({ base, upperRoot, id });
  const r = ws.run("bash", ["-c", `printf '%s\\n' 'export const ${fixConst} = "${fixConst}";' >> ${CONVERTER_REL}`]);
  if (r.code !== 0) throw new Error(`fork edit failed for ${id}: ${r.stderr}`);
  return ws;
}
const candStatus = (historyDir: string, sid: string): string | undefined => {
  const f = join(historyDir, "candidates.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { status?: string }>)[sid]?.status : undefined;
};
const uid = (p: string) => `${p}-${process.pid}-${Date.now()}`;

async function main(): Promise<void> {
  console.log("\nmerge E2E — real gate/overlays/promote/ledger; mock ONLY (H) human, (L) llm, (R) recording\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }
  const UPPER = "/overlays/merge-e2e";
  try { rmSync(UPPER, { recursive: true, force: true }); } catch { /* */ }

  // (1) clean all-at-once.
  await test("(1) clean all-at-once → both forks promoted; ledger untouched (REAL gate)", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("clean", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02", "slide_03"], unstable: [] });
    const fixMap = { slide_01: "FIX_A", slide_02: "FIX_B" };
    const wsA = makeFork(base, UPPER, uid("c-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("c-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const recording = recordingFromContent({ converterRel: CONVERTER_REL, baseFileContent: BASE_FILE, fixMap, tag: "R:clean" });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    const llm = mockLlm(mergeComposer, { tag: "L:merge-compose" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.equal(report!.mode, "all-at-once");
      assert.deepEqual(report!.accepted.sort(), ["task-a", "task-b"]);
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && /FIX_B/.test(merged), "promoted base has BOTH fixes");
      assert.equal(candStatus(historyDir, "slide_01"), undefined);
      assert.equal(candStatus(historyDir, "slide_02"), undefined);
      // ONLY llm + recording were mocked (both tagged); nothing else.
      assert.ok(llm.seen.every((s) => s.tag === "L:merge-compose") && llm.seen.length >= 1, "only tagged LLM calls");
      assert.ok(recording.calls.every((c) => c.tag === "R:clean") && recording.calls.length >= 1, "only tagged recording calls");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (2) non-targeted ripple → sequential + REAL demote + serial mutation.
  await test("(2) ripple → sequential: keep A, roll back + REAL-demote B; fork B folds on POST-A base", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("ripple", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02", "slide_03"], unstable: [] });
    const fixMap = { slide_01: "FIX_A", slide_02: "FIX_B", slide_03: "FIX_B" }; // slide_03 non-targeted, responds to FIX_B
    const wsA = makeFork(base, UPPER, uid("r-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("r-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    // slide_02's LGTM falls back to base (SxS-absent) → satisfied while unfolded
    // (A clean); diverges once B folds FIX_B.
    const recording = recordingFromContent({ converterRel: CONVERTER_REL, baseFileContent: BASE_FILE, fixMap, tag: "R:ripple", lgtm: (sid) => sid === "slide_02" ? contentRecord("slide_02", BASE_FILE, fixMap) : undefined });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    const llm = mockLlm(mergeComposer, { tag: "L:merge-compose" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.equal(report!.mode, "sequential");
      assert.deepEqual(report!.accepted, ["task-a"], "only A kept");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B rejected");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && !/FIX_B/.test(merged), "base has A, not B");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "REAL ledger: B's slide demoted");
      const lastBase = fencedBlocks(llm.seen[llm.seen.length - 1].prompt)[0] ?? "";
      assert.ok(/FIX_A/.test(lastBase), "fork B's LLM base already carries A's accepted fold (serial mutation)");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (3) a pixel-perfect fork that can't keep BINARY stability → not merged.
  await test("(3) pixel-perfect fork can't keep binary stability → not merged + REAL demote (base rolled back)", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("pixviol", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02"], unstable: [] });
    const fixMap = { slide_01: "FIX_A" };
    const wsA = makeFork(base, UPPER, uid("pv-a"), "FIX_A");
    const green = [greenCluster("task-a", wsA, ["slide_01"])];
    const recording = recordingFromContent({ converterRel: CONVERTER_REL, baseFileContent: BASE_FILE, fixMap, tag: "R:pixviol", lgtm: (sid) => sid === "slide_01" ? { pixelHash: "APPROVED_UNREACHABLE", xmlHash: "APPROVED_UNREACHABLE", renderedPartsHash: "APPROVED_UNREACHABLE" } : undefined });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    const llm = mockLlm(mergeComposer, { tag: "L:merge-compose" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.deepEqual(report!.accepted, [], "nothing accepted");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-a"], "A rejected");
      assert.ok(!/FIX_A/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "base rolled back");
      assert.equal(candStatus(historyDir, "slide_01"), "bad", "REAL ledger: slide_01 demoted");
    } finally { wsA.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (4) an xml-stable fork that can't keep XML+RENDERED stability → not merged.
  await test("(4) xml-stable fork can't keep xml+rendered stability → not merged + REAL demote", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("xmlviol", { pixelPerfect: [], xmlStable: ["slide_02"], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("xv-a"), "FIX_B");
    const green = [greenCluster("task-b", wsA, ["slide_02"])];
    const recording: MergeRenderSeam = recordingSeam({
      tag: "R:xmlviol",
      base: (sid) => ({ xmlHash: `base-${sid}`, renderedPartsHash: `base-${sid}` }),
      lgtm: (sid) => sid === "slide_02" ? { xmlHash: "X02", renderedPartsHash: "R_APPROVED" } : { xmlHash: `base-${sid}`, renderedPartsHash: `base-${sid}` },
      merge: (_ws, sid) => sid === "slide_02" ? { xmlHash: "X02", renderedPartsHash: "R_MERGED" } : { xmlHash: `base-${sid}`, renderedPartsHash: `base-${sid}` },
    });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    const llm = mockLlm(mergeComposer, { tag: "L:merge-compose" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B rejected on xml-parts change");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "REAL ledger: slide_02 demoted");
    } finally { wsA.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (5) no green clusters → no-op.
  await test("(5) no green clusters → no promote, no demote, no throw", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("nogreen", { pixelPerfect: ["slide_01"], xmlStable: [], unstable: [] });
    const recording = recordingFromContent({ converterRel: CONVERTER_REL, baseFileContent: BASE_FILE, fixMap: {}, tag: "R:nogreen" });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    const llm = mockLlm(mergeComposer, { tag: "L:merge-compose" });
    try {
      const { report, threw } = await runRealMerge({ base, green: [], ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.deepEqual(report?.accepted ?? [], []);
      assert.ok(!existsSync(join(historyDir, "candidates.json")), "no ledger writes");
      assert.equal(readFileSync(join(base, CONVERTER_REL), "utf8"), BASE_FILE, "base untouched");
      assert.equal(llm.seen.length, 0, "no LLM calls when nothing to merge");
    } finally { rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (6) CONTINUE past a fork that can't keep stability — the fold keeps going and
  //     still merges a fork that DOES keep its stability (Q1).
  await test("(6) a fork that can't keep stability is skipped; the fold CONTINUES and a stable fork still merges", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("continue", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02"], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("k-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("k-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const has = (ws: import("../../../cow-workspace/cow-workspace.js").CowWorkspace, f: string) => new RegExp(f).test(ws.readUpperFile(CONVERTER_REL) ?? BASE_FILE);
    // slide_01 (A, pixel): LGTM UNREACHABLE → A can NEVER keep binary stability.
    // slide_02 (B, xml): keeps xml+rendered stability once FIX_B is folded.
    const recording = recordingSeam({
      tag: "R:continue",
      base: (sid) => sid === "slide_01" ? { pixelHash: "s01-base" } : { xmlHash: "s02-base", renderedPartsHash: "s02-base" },
      lgtm: (sid) => sid === "slide_01" ? { pixelHash: "UNREACHABLE" } : { xmlHash: "s02-fix", renderedPartsHash: "s02-fix" },
      merge: (ws, sid) => sid === "slide_01"
        ? { pixelHash: has(ws, "FIX_A") ? "s01-A" : "s01-base" }
        : (has(ws, "FIX_B") ? { xmlHash: "s02-fix", renderedPartsHash: "s02-fix" } : { xmlHash: "s02-base", renderedPartsHash: "s02-base" }),
    });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    try {
      const { report } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm: mockLlm(mergeComposer, { tag: "L:merge-compose" }) });
      assert.equal(report!.mode, "sequential");
      assert.deepEqual(report!.accepted, ["task-b"], "B kept stability → merged; A's failure did NOT block it");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-a"], "A couldn't keep binary stability → not merged");
      assert.ok(/FIX_B/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "B's fix promoted");
      assert.equal(candStatus(historyDir, "slide_01"), "bad", "A demoted");
      assert.equal(candStatus(historyDir, "slide_02"), undefined, "B NOT demoted");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (7) a MERGED green is the new reference — a later fork that would regress it
  //     doesn't keep that slide's stability → not merged; merged green preserved (Q2).
  await test("(7) a merged green is the reference — a later fork regressing it doesn't keep stability → not merged; merged green preserved", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("locked", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02"], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("l-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("l-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const has = (ws: import("../../../cow-workspace/cow-workspace.js").CowWorkspace, f: string) => new RegExp(f).test(ws.readUpperFile(CONVERTER_REL) ?? BASE_FILE);
    // slide_01 (A, pixel): stable with FIX_A alone (== its LGTM/merged state), but
    // FIX_B REGRESSES it. slide_02 (B, xml): keeps stability with FIX_B.
    const recording = recordingSeam({
      tag: "R:locked",
      base: (sid) => sid === "slide_01" ? { pixelHash: "s01-base" } : { xmlHash: "s02-base", renderedPartsHash: "s02-base" },
      lgtm: (sid) => sid === "slide_01" ? { pixelHash: "s01-A" } : { xmlHash: "s02-fix", renderedPartsHash: "s02-fix" },
      merge: (ws, sid) => sid === "slide_01"
        ? { pixelHash: has(ws, "FIX_B") ? "s01-REGRESSED" : (has(ws, "FIX_A") ? "s01-A" : "s01-base") }
        : (has(ws, "FIX_B") ? { xmlHash: "s02-fix", renderedPartsHash: "s02-fix" } : { xmlHash: "s02-base", renderedPartsHash: "s02-base" }),
    });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    try {
      const { report } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm: mockLlm(mergeComposer, { tag: "L:merge-compose" }) });
      assert.equal(report!.mode, "sequential");
      assert.deepEqual(report!.accepted, ["task-a"], "A merged first + locked in as the reference");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B regressed A's merged slide → didn't keep its stability → not merged");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && !/FIX_B/.test(merged), "A's merged fix PRESERVED; B's regressing fold rolled back");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "B demoted");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (8) human green/red marker round-trips across the overlay boundary.
  await test("(8) human rating marker written inside a workspace is readable outside", async () => {
    const base = mkdtempSync(join(tmpdir(), "merge-e2e-marker-"));
    const runId = uid("run");
    const sharedDir = `/overlays/shared/${runId}/task-x`;
    try { rmSync(`/overlays/shared/${runId}`, { recursive: true, force: true }); } catch { /* */ }
    const ws = createCowWorkspace({ base, upperRoot: UPPER, id: uid("marker") });
    try {
      // The fork writes the human's GREEN verdict inside its overlay to the
      // absolute /overlays/shared path (exactly what the rating gate does).
      const payload = JSON.stringify({ task_id: "task-x", green: true, rated: true, good: ["slide_01"], bad: [], unrated: [], slides: ["slide_01"] });
      const r = ws.runShell(`mkdir -p '${sharedDir}' && printf '%s' '${payload}' > '${sharedDir}/rating-outcome.json'`);
      assert.equal(r.code, 0, `marker write failed: ${r.stderr}`);
      assert.ok(existsSync(`${sharedDir}/rating-outcome.json`), "marker readable outside the overlay");
      assert.equal(JSON.parse(readFileSync(`${sharedDir}/rating-outcome.json`, "utf8")).green, true);
      // and the kit's writeRatingOutcome helper produces the same shape.
      const d2 = `/overlays/shared/${runId}/task-y`;
      writeRatingOutcome(d2, { task: "task-y", green: false, bad: ["slide_02"], slides: ["slide_02"] });
      assert.equal(JSON.parse(readFileSync(`${d2}/rating-outcome.json`, "utf8")).green, false);
    } finally { ws.cleanup(); rmSync(base, { recursive: true, force: true }); try { rmSync(`/overlays/shared/${runId}`, { recursive: true, force: true }); } catch { /* */ } }
  });

  await test("(9) no /overlays leaks after all merges", async () => {
    const leftover = existsSync(UPPER) ? readdirSync(UPPER) : [];
    assert.deepEqual(leftover, [], `UPPER should be empty, found ${JSON.stringify(leftover)}`);
  });

  try { rmSync(UPPER, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
