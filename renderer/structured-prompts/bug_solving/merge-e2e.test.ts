/**
 * merge-e2e.test.ts — the FULL human-rating merge flow end-to-end through the
 * PRODUCTION seam `realLlmMergeOps`, obeying the strict mock policy: the ONLY
 * mocked things are (H) the human rating (`rate` seam), (L) the LLM edit/verify
 * call (`mockLlm`), and (R) the Google-Slides recording (`render` seam). EVERYTHING
 * else is REAL — the engine on a REAL IO, REAL COW overlay forks, the REAL `git
 * merge-file` 3-way merge, the REAL change-detection gate, the REAL promote onto
 * the base tree, and the REAL demote ledger.
 *
 * The flow (docs/merge-flow.drawio):
 *   ALL-TOGETHER merge first → detect changed slides → if any, the human rates
 *   them. All green → ACCEPT everything (new green). Reject-all&stop → abort.
 *   Any red → SEQUENTIAL: fold each fork alone, rate its changed slides; green →
 *   keep (new green, protects it from a later fold); red → roll back + demote +
 *   CONTINUE; stop → keep what's kept, stop the rest.
 *
 * Cases:
 *   (1) all-together, every changed slide GREEN → accept both; ledger untouched.
 *   (2) all-together has a RED → SEQUENTIAL: keep+merge A (green), roll back +
 *       demote B (red); the fold CONTINUES past the reject.
 *   (3) reject-all & STOP in all-together → nothing promoted; base untouched.
 *   (4) nothing differs from approved → auto-accept, the human is NOT asked.
 *   (5) a kept green is the NEW reference — a later fold that regresses it
 *       re-surfaces it; the human reds it → that fork is dropped, the green kept.
 *   (6) reject-all & STOP mid-sequential → the already-kept fork stays promoted;
 *       remaining forks are not rated.
 *   (7) ordering: the FIRST rating round is the all-together merge.
 *   (8) no /overlays leaks. Plus: only (H)+(R)+(L) were mocked.
 *
 * Requires CAP_SYS_ADMIN + /overlays; SKIPs loudly (exit 0) otherwise.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import { createCowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import { realLlmMergeOps } from "./llm-merge.js";
import { writeStabilityJson } from "./stability.js";
import type { RenderRecord } from "./stability.js";
import {
  mockLlm, mergeEditor, recordingSeam, greenCluster, runRealMerge,
  mergeRateMock, verdictGreenAll, verdictRed, verdictStopAll,
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
function makeFork(base: string, upperRoot: string, id: string, fixConst: string): CowWorkspace {
  const ws = createCowWorkspace({ base, upperRoot, id });
  const r = ws.run("bash", ["-c", `printf '%s\\n' 'export const ${fixConst} = "${fixConst}";' >> ${CONVERTER_REL}`]);
  if (r.code !== 0) throw new Error(`fork edit failed for ${id}: ${r.stderr}`);
  return ws;
}
const has = (ws: CowWorkspace, f: string): boolean => new RegExp(f).test(ws.readUpperFile(CONVERTER_REL) ?? BASE_FILE);
const candStatus = (historyDir: string, sid: string): string | undefined => {
  const f = join(historyDir, "candidates.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { status?: string }>)[sid]?.status : undefined;
};
const uid = (p: string) => `${p}-${process.pid}-${Date.now()}`;
const px = (h: string): RenderRecord => ({ pixelHash: h });

async function main(): Promise<void> {
  console.log("\nmerge E2E — human-rating flow; real gate/overlays/git-3way/promote/ledger; mock ONLY (H) rating, (L) llm, (R) recording\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }
  const UPPER = "/overlays/merge-e2e";
  try { rmSync(UPPER, { recursive: true, force: true }); } catch { /* */ }

  // A recording seam where a target slide's MERGED render differs from its
  // approved (LGTM) render exactly when its fix is present → it shows as "changed"
  // and gets rated. Non-targeted slides render at base unless a fork ripples them.
  //   slide_01 ← FIX_A (task-a),  slide_02 ← FIX_B (task-b)

  // (1) all-together, all changed GREEN → accept both.
  await test("(1) all-together: every changed slide GREEN → accept both; ledger untouched", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("green", { pixelPerfect: ["slide_01", "slide_02"], xmlStable: ["slide_03"], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("g-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("g-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const recording = recordingSeam({
      tag: "R:green",
      base: (sid) => px(`${sid}-base`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (ws, sid) => sid === "slide_01" ? px(has(ws, "FIX_A") ? "slide_01-merged" : "slide_01-base")
        : sid === "slide_02" ? px(has(ws, "FIX_B") ? "slide_02-merged" : "slide_02-base") : px(`${sid}-base`),
    });
    const rating = mergeRateMock(({ changed }) => verdictGreenAll(changed));
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const editor = mergeEditor();
    const llm = mockLlm(editor.reply, { tag: "L:merge-edit" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.equal(report!.mode, "all-at-once");
      assert.deepEqual(report!.accepted.sort(), ["task-a", "task-b"]);
      assert.equal(report!.stopped, false);
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && /FIX_B/.test(merged), "both fixes promoted");
      assert.equal(candStatus(historyDir, "slide_01"), undefined);
      assert.equal(candStatus(historyDir, "slide_02"), undefined);
      // ONE rating round, all-together, showing both changed slides.
      assert.equal(rating.calls.length, 1, "one rating round");
      assert.equal(rating.calls[0].phase, "all-at-once");
      assert.deepEqual(rating.calls[0].changed.sort(), ["slide_01", "slide_02"]);
      // only (H)+(R)+(L) mocked.
      assert.ok(llm.seen.every((s) => s.tag === "L:merge-edit"));
      assert.ok(recording.calls.every((c) => c.tag === "R:green"));
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (2) all-together RED → sequential: keep A (green), demote B (red); CONTINUE.
  await test("(2) all-together has a RED → sequential: keep A, roll back + demote B; fold CONTINUES", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("red", { pixelPerfect: ["slide_01", "slide_02"], xmlStable: ["slide_03"], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("r-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("r-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const recording = recordingSeam({
      tag: "R:red",
      base: (sid) => px(`${sid}-base`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (ws, sid) => sid === "slide_01" ? px(has(ws, "FIX_A") ? "slide_01-merged" : "slide_01-base")
        : sid === "slide_02" ? px(has(ws, "FIX_B") ? "slide_02-merged" : "slide_02-base") : px(`${sid}-base`),
    });
    // all-together: red slide_02. sequential: green slide_01, red slide_02.
    const rating = mergeRateMock(({ changed }) => changed.includes("slide_02") ? verdictRed(["slide_02"], changed) : verdictGreenAll(changed));
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const llm = mockLlm(mergeEditor().reply, { tag: "L:merge-edit" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.equal(report!.mode, "sequential");
      assert.deepEqual(report!.accepted, ["task-a"], "A kept");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B rejected");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && !/FIX_B/.test(merged), "A promoted, B not");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "REAL ledger: B demoted");
      // all-together round + one sequential round per fork.
      assert.equal(rating.calls[0].phase, "all-at-once");
      assert.ok(rating.calls.slice(1).every((c) => c.phase === "sequential"), "the rest are sequential folds");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (3) reject-all & STOP in all-together → abort, nothing promoted.
  await test("(3) reject-all & STOP in all-together → nothing promoted; base untouched", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("stop", { pixelPerfect: ["slide_01", "slide_02"], xmlStable: [], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("s-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("s-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const recording = recordingSeam({
      tag: "R:stop",
      base: (sid) => px(`${sid}-base`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (ws, sid) => sid === "slide_01" ? px(has(ws, "FIX_A") ? "slide_01-merged" : "slide_01-base")
        : px(has(ws, "FIX_B") ? "slide_02-merged" : "slide_02-base"),
    });
    const rating = mergeRateMock(({ changed }) => verdictStopAll(changed));
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const llm = mockLlm(mergeEditor().reply, { tag: "L:merge-edit" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.equal(report!.stopped, true, "stopped");
      assert.deepEqual(report!.accepted, [], "nothing accepted");
      assert.equal(report!.mergedFiles.length, 0, "nothing promoted");
      assert.equal(readFileSync(join(base, CONVERTER_REL), "utf8"), BASE_FILE, "base untouched");
      assert.equal(rating.calls.length, 1, "asked once then stopped");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (4) nothing differs from approved → auto-accept, human NOT asked.
  await test("(4) no changes vs approved → auto-accept without rating", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("nochange", { pixelPerfect: ["slide_01"], xmlStable: [], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("n-a"), "FIX_A");
    const green = [greenCluster("task-a", wsA, ["slide_01"])];
    // merged render == approved for every slide → detect finds nothing changed.
    const recording = recordingSeam({
      tag: "R:nochange",
      base: (sid) => px(`${sid}-approved`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (_ws, sid) => px(`${sid}-approved`),
    });
    const rating = mergeRateMock(({ changed }) => verdictGreenAll(changed));
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const llm = mockLlm(mergeEditor().reply, { tag: "L:merge-edit" });
    try {
      const { report, threw } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(threw, null);
      assert.equal(report!.mode, "all-at-once");
      assert.deepEqual(report!.accepted, ["task-a"], "accepted with no rating");
      assert.equal(rating.calls.length, 0, "human NOT asked when nothing differs");
      assert.ok(/FIX_A/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "still promoted");
    } finally { wsA.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (5) a kept green is the NEW reference — a later fold regressing it re-surfaces
  //     it; the human reds it → that fork dropped, the green preserved.
  await test("(5) kept green is the new reference — a fold that regresses it is re-surfaced + red → dropped; green preserved", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("locked", { pixelPerfect: ["slide_01", "slide_02"], xmlStable: [], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("l-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("l-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    // FIX_B REGRESSES slide_01 (a shared-code ripple). slide_01 merged depends on both.
    const recording = recordingSeam({
      tag: "R:locked",
      base: (sid) => px(`${sid}-base`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (ws, sid) => sid === "slide_01"
        ? px(has(ws, "FIX_B") ? "slide_01-REGRESSED" : (has(ws, "FIX_A") ? "slide_01-merged" : "slide_01-base"))
        : px(has(ws, "FIX_B") ? "slide_02-merged" : "slide_02-base"),
    });
    // all-together: red (slide_01 regressed shows alongside slide_02). sequential:
    // fork A → slide_01 green (keep, new ref = slide_01-merged). fork B → slide_01
    // now REGRESSED vs the kept ref → re-surfaced; human reds slide_01.
    const rating = mergeRateMock(({ phase, changed }) => {
      if (phase === "all-at-once") return verdictRed(["slide_01"], changed);      // route to sequential
      if (changed.includes("slide_01") && changed.includes("slide_02")) return verdictRed(["slide_01"], changed); // fork B regressed slide_01
      return verdictGreenAll(changed);                                            // fork A: slide_01 green
    });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const llm = mockLlm(mergeEditor().reply, { tag: "L:merge-edit" });
    try {
      const { report } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(report!.mode, "sequential");
      assert.deepEqual(report!.accepted, ["task-a"], "A kept + locked as reference");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B regressed A's green → dropped");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && !/FIX_B/.test(merged), "A preserved, B rolled back");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "B demoted");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (6) reject-all & STOP mid-sequential → already-kept fork stays; rest not rated.
  await test("(6) STOP mid-sequential → kept fork stays promoted; remaining forks not rated", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("seqstop", { pixelPerfect: ["slide_01", "slide_02"], xmlStable: [], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("q-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("q-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const recording = recordingSeam({
      tag: "R:seqstop",
      base: (sid) => px(`${sid}-base`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (ws, sid) => sid === "slide_01" ? px(has(ws, "FIX_A") ? "slide_01-merged" : "slide_01-base")
        : px(has(ws, "FIX_B") ? "slide_02-merged" : "slide_02-base"),
    });
    // all-together: red → sequential. fork A: green (keep). fork B: STOP.
    const rating = mergeRateMock(({ phase, label, changed }) => {
      if (phase === "all-at-once") return verdictRed(["slide_02"], changed);
      if (label === "task-b") return verdictStopAll(changed);
      return verdictGreenAll(changed);
    });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const llm = mockLlm(mergeEditor().reply, { tag: "L:merge-edit" });
    try {
      const { report } = await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(report!.stopped, true, "stopped");
      assert.deepEqual(report!.accepted, ["task-a"], "A kept before the stop stays");
      assert.ok(/FIX_A/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "A promoted");
      assert.ok(!/FIX_B/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "B not promoted");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (7) ordering: the FIRST rating round is the all-together merge (covered by the
  //     calls[0].phase asserts above) — restated as an explicit invariant.
  await test("(7) the first rating round is always the all-together merge", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("order", { pixelPerfect: ["slide_01", "slide_02"], xmlStable: [], unstable: [] });
    const wsA = makeFork(base, UPPER, uid("o-a"), "FIX_A"), wsB = makeFork(base, UPPER, uid("o-b"), "FIX_B");
    const green = [greenCluster("task-a", wsA, ["slide_01"]), greenCluster("task-b", wsB, ["slide_02"])];
    const recording = recordingSeam({
      tag: "R:order",
      base: (sid) => px(`${sid}-base`),
      lgtm: (sid) => px(`${sid}-approved`),
      merge: (ws, sid) => sid === "slide_01" ? px(has(ws, "FIX_A") ? "slide_01-merged" : "slide_01-base")
        : px(has(ws, "FIX_B") ? "slide_02-merged" : "slide_02-base"),
    });
    const rating = mergeRateMock(({ changed }) => verdictGreenAll(changed));
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording, rate: rating.rate });
    const llm = mockLlm(mergeEditor().reply, { tag: "L:merge-edit" });
    try {
      await runRealMerge({ base, green, ops, upperRoot: UPPER, llm });
      assert.equal(rating.calls[0].phase, "all-at-once", "first round is all-together");
      assert.deepEqual(rating.calls[0].changed.sort(), ["slide_01", "slide_02"], "with ALL changes together");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  await test("(8) no /overlays leaks after all merges", async () => {
    const leftover = existsSync(UPPER) ? readdirSync(UPPER) : [];
    // demoted/stopped forks are LEFT for inspection; only cleanly-accepted merge
    // workspaces + reaped forks disappear. Assert no ACCEPTED merge ws leaked.
    assert.ok(!leftover.some((d) => d.startsWith("llm-merge-")), `no merge workspace leaks, found ${JSON.stringify(leftover)}`);
  });

  try { rmSync(UPPER, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
