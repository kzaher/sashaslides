/**
 * merge-e2e.test.ts — the FULL merge process end-to-end through the PRODUCTION
 * seam `realLlmMergeOps`. The ONLY mocked things are the two external calls:
 *   • the LLM compose call            (via MockIO),
 *   • the Google-Slides recording     (record-rendering --mode full) — injected
 *     via realLlmMergeOps' `render` seam as deterministic RenderRecords.
 * EVERYTHING else is REAL: the COW overlay forks, the merged-file write + promote
 * onto the base tree, the dual-class regression gate (makeRegressionRetest +
 * regressionGate) reading a REAL stability.json, the all-at-once→sequential
 * fallback, and the demote into a REAL ledger (candidates.json via ledgerDemote).
 *
 * This is the gap the scripted-retest llm-merge.e2e.test.ts left open: there the
 * whole `ops.retest` is a canned queue; HERE the real gate runs, fed only by the
 * mocked render — so a gate bug (mis-classification, ripple mis-detection, base
 * non-advancement) would fail these.
 *
 * Cases:
 *   (1) clean all-at-once            → both forks promoted; ledger untouched.
 *   (2) non-targeted ripple          → sequential fallback: clean fork kept +
 *       promoted, rippling fork rolled back + REAL demote; and fork B folds
 *       against the POST-fork-A base (serial target mutation).
 *   (3) green pixel-class violation  → reject + real demote (base rolled back).
 *   (4) green xml-class parts change → reject + real demote (xml-stable branch).
 *   (5) no green clusters            → no-op: no promote, no demote.
 *
 * Requires CAP_SYS_ADMIN + /overlays; SKIPs loudly (exit 0) otherwise.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import { MockIO, type EffectCall, type Matcher, type SpawnCaptureArgs, type SpawnCaptureResult } from "../../../structured-prompting/src/server/io.js";
import { createCowWorkspace, type CowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import { llmMerge, realLlmMergeOps, type GreenCluster, type MergeReport, type MergeRenderSeam } from "./llm-merge.js";
import { writeStabilityJson, type RenderRecord } from "./stability.js";

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

// ---- LLM mock (MockIO) -----------------------------------------------------
function claudeReply(result: string): SpawnCaptureResult {
  return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "mock", duration_ms: 1, total_cost_usd: 0 }), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
const isClaude = (c: EffectCall) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "claude";
function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
    { name: "bash-echo", when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash", returns: { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null }, optional: true },
    { name: "git", when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "git", returns: { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null }, optional: true },
    { name: "writeFileSync", when: (c) => c.method === "writeFileSync", returns: undefined, optional: true },
    { name: "rmSync", when: (c) => c.method === "rmSync", returns: undefined, optional: true },
    { name: "mkdtempSync", when: (c) => c.method === "mkdtempSync", returns: "/tmp/mock-x", optional: true },
  ];
}
const fenced = (p: string) => p.split("```").filter((_, i) => i % 2 === 1).map((b) => b.replace(/^\n/, "").replace(/\n$/, ""));
/** mock LLM: merged file = base + every new FIX_ line from the proposals. */
function mockMerge(prompt: string): string {
  const [base, ...proposals] = fenced(prompt);
  const have = new Set((base ?? "").split("\n"));
  const extra: string[] = [];
  for (const p of proposals) for (const line of p.split("\n")) if (/FIX_/.test(line) && !have.has(line)) { have.add(line); extra.push(line); }
  return [...(base ?? "").split("\n"), ...extra].join("\n");
}

// ---- fixture base + real forks ---------------------------------------------
const CONVERTER_REL = "renderer/html2slides/convert-pptx.ts";
const BASE_FILE = ["// convert-pptx.ts (test fixture)", "export const A = 1;", ""].join("\n");
const sha = (s: string) => execSync(`printf '%s' ${JSON.stringify(s)} | sha1sum`).toString().slice(0, 12);

/** A slide's render depends ONLY on whether the fix(es) mapped to it are present
 *  in the converter content — so an unrelated fork's edit never moves it. */
function perSlideRecord(sid: string, content: string, fixMap: Record<string, string>): RenderRecord {
  const fix = fixMap[sid];
  const active = fix && new RegExp(fix).test(content) ? fix : "";
  const key = sha(`${sid}|${active}`);
  return { pixelHash: key, xmlHash: key, renderedPartsHash: key };
}
function makeFork(base: string, upperRoot: string, id: string, fixConst: string): CowWorkspace {
  const ws = createCowWorkspace({ base, upperRoot, id });
  const r = ws.run("bash", ["-c", `printf '%s\\n' 'export const ${fixConst} = "${fixConst}";' >> ${CONVERTER_REL}`]);
  if (r.code !== 0) throw new Error(`fork edit failed for ${id}: ${r.stderr}`);
  return ws;
}

/** Build a base repo with the converter file, a fixtures deck, and a stability.json. */
function setupBase(tag: string, stability: { pixelPerfect: string[]; xmlStable: string[]; unstable: string[] }): { base: string; fixturesDir: string; stabilityPath: string; historyDir: string } {
  const base = mkdtempSync(join(tmpdir(), `merge-e2e-${tag}-`));
  mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
  writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
  const fixturesDir = join(base, "fx");
  mkdirSync(fixturesDir, { recursive: true });
  for (const sid of [...stability.pixelPerfect, ...stability.xmlStable, ...stability.unstable]) writeFileSync(join(fixturesDir, `${sid}.html`), "<html></html>");
  const stabilityPath = join(base, "stability.json");
  writeStabilityJson(stabilityPath, { ...stability, warning: "", attempts: 3 });
  const historyDir = mkdtempSync(join(tmpdir(), `merge-e2e-hist-${tag}-`));
  return { base, fixturesDir, stabilityPath, historyDir };
}

/** The render seam over perSlideRecord: base = pristine; merge = the ws content;
 *  lgtm overridable per case (default = base+the slide's own fix, i.e. the
 *  intended clean render). */
function seamOver(base: string, fixMap: Record<string, string>, lgtmOverride?: (sid: string) => RenderRecord | undefined): MergeRenderSeam {
  const cur = (): string => existsSync(join(base, CONVERTER_REL)) ? readFileSync(join(base, CONVERTER_REL), "utf8") : BASE_FILE;
  return {
    baseRecord: (sid) => perSlideRecord(sid, BASE_FILE, fixMap),
    lgtmRecord: (sid) => lgtmOverride?.(sid) ?? perSlideRecord(sid, `${BASE_FILE}export const ${fixMap[sid] ?? "NONE"} = "x";\n`, fixMap),
    renderMergeDeck: (ws) => {
      const content = ws.readUpperFile(CONVERTER_REL) ?? cur();
      return (sid) => perSlideRecord(sid, content, fixMap);
    },
  };
}

async function runMerge(base: string, green: GreenCluster[], ops: ReturnType<typeof realLlmMergeOps>, upperRoot: string): Promise<{ report?: MergeReport; threw: unknown; prompts: string[] }> {
  const prompts: string[] = [];
  const io = new MockIO({ matchers: [...baseMatchers(), { name: "llm", when: isClaude, returns: (c: EffectCall) => {
    const a = c.args[0] as SpawnCaptureArgs; const pi = a.args.indexOf("-p"); const p = pi >= 0 ? (a.args[pi + 1] ?? "") : ""; prompts.push(p); return claudeReply(mockMerge(p));
  } }] });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  let report: MergeReport | undefined; let threw: unknown = null;
  try { report = await engine.execute(new Session({ sessionId: "merge-e2e", cwd: base }), (s) => llmMerge(s, { repo: base, greenClusters: green, ops, upperRoot })); }
  catch (e) { threw = e; } finally { await engine.shutdown(); }
  return { report, threw, prompts };
}
const candStatus = (historyDir: string, sid: string): string | undefined => {
  const f = join(historyDir, "candidates.json");
  if (!existsSync(f)) return undefined;
  return (JSON.parse(readFileSync(f, "utf8")) as Record<string, { status?: string }>)[sid]?.status;
};

async function main(): Promise<void> {
  console.log("\nmerge E2E — full realLlmMergeOps (REAL gate/overlays/promote/ledger; mock ONLY llm + recording)\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }
  const UPPER = "/overlays/merge-e2e";
  try { rmSync(UPPER, { recursive: true, force: true }); } catch { /* */ }

  // (1) clean all-at-once.
  await test("(1) clean all-at-once → both forks promoted; ledger untouched (REAL gate)", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("clean", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02", "slide_03"], unstable: [] });
    const fixMap = { slide_01: "FIX_A", slide_02: "FIX_B" }; // slide_03 untouched by any fix
    const wsA = makeFork(base, UPPER, `c-a-${process.pid}-${Date.now()}`, "FIX_A");
    const wsB = makeFork(base, UPPER, `c-b-${process.pid}-${Date.now()}`, "FIX_B");
    const green: GreenCluster[] = [{ task: "task-a", branch_id: wsA.id, slides: ["slide_01"] }, { task: "task-b", branch_id: wsB.id, slides: ["slide_02"] }];
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: seamOver(base, fixMap) });
    try {
      const { report, threw } = await runMerge(base, green, ops, UPPER);
      assert.equal(threw, null);
      assert.equal(report!.mode, "all-at-once");
      assert.deepEqual(report!.accepted.sort(), ["task-a", "task-b"]);
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && /FIX_B/.test(merged), "promoted base has BOTH fixes");
      assert.equal(candStatus(historyDir, "slide_01"), undefined, "no demote");
      assert.equal(candStatus(historyDir, "slide_02"), undefined, "no demote");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (2) non-targeted ripple → sequential fallback + REAL demote + serial mutation.
  await test("(2) ripple → sequential: keep A, roll back + REAL-demote B; fork B folds on POST-A base", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("ripple", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02", "slide_03"], unstable: [] });
    // slide_03 (NON-targeted) also responds to FIX_B → folding B ripples slide_03.
    const fixMap = { slide_01: "FIX_A", slide_02: "FIX_B", slide_03: "FIX_B" };
    const wsA = makeFork(base, UPPER, `r-a-${process.pid}-${Date.now()}`, "FIX_A");
    const wsB = makeFork(base, UPPER, `r-b-${process.pid}-${Date.now()}`, "FIX_B");
    const green: GreenCluster[] = [{ task: "task-a", branch_id: wsA.id, slides: ["slide_01"] }, { task: "task-b", branch_id: wsB.id, slides: ["slide_02"] }];
    // The real gate checks EVERY green slide vs its LGTM at EVERY fold. slide_02's
    // LGTM falls back to its BASE render (SxS-absent), so it's satisfied while
    // unfolded (fork A stays clean) and diverges once fork B folds FIX_B.
    const lgtm = (sid: string) => sid === "slide_02" ? perSlideRecord("slide_02", BASE_FILE, fixMap) : undefined;
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: seamOver(base, fixMap, lgtm) });
    try {
      const { report, threw, prompts } = await runMerge(base, green, ops, UPPER);
      assert.equal(threw, null);
      assert.equal(report!.mode, "sequential", "gate detected the slide_03 ripple → fallback");
      assert.deepEqual(report!.accepted, ["task-a"], "only A kept");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B rejected");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && !/FIX_B/.test(merged), "base has A, not B");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "REAL ledger: B's slide demoted to bad");
      // serial mutation: B's sequential fold happens against a base already carrying FIX_A.
      const bBase = fenced(prompts[prompts.length - 1])[0] ?? "";
      assert.ok(/FIX_A/.test(bBase), "fork B's LLM base already carries fork A's accepted fold");
    } finally { wsA.cleanup(); wsB.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (3) green pixel-class violation (unreachable LGTM) → reject + demote.
  await test("(3) green pixel-class violation → reject + REAL demote (base rolled back)", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("pixviol", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02"], unstable: [] });
    const fixMap = { slide_01: "FIX_A" };
    const wsA = makeFork(base, UPPER, `pv-a-${process.pid}-${Date.now()}`, "FIX_A");
    const green: GreenCluster[] = [{ task: "task-a", branch_id: wsA.id, slides: ["slide_01"] }];
    // LGTM(slide_01) is an unreachable approved pixel → the pixel-perfect green
    // slide can NEVER match → violation every attempt.
    const seam = seamOver(base, fixMap, (sid) => sid === "slide_01" ? { pixelHash: "APPROVED_UNREACHABLE", xmlHash: "APPROVED_UNREACHABLE", renderedPartsHash: "APPROVED_UNREACHABLE" } : undefined);
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: seam });
    try {
      const { report, threw } = await runMerge(base, green, ops, UPPER);
      assert.equal(threw, null);
      assert.deepEqual(report!.accepted, [], "nothing accepted");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-a"], "A rejected");
      assert.ok(!/FIX_A/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "base rolled back");
      assert.equal(candStatus(historyDir, "slide_01"), "bad", "REAL ledger: slide_01 demoted");
    } finally { wsA.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (4) green xml-class violation: same xml, DIFFERENT rendered-parts → reject.
  await test("(4) green xml-class rendered-parts change → reject + REAL demote", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("xmlviol", { pixelPerfect: [], xmlStable: ["slide_02"], unstable: [] });
    const wsA = makeFork(base, UPPER, `xv-a-${process.pid}-${Date.now()}`, "FIX_B");
    const green: GreenCluster[] = [{ task: "task-b", branch_id: wsA.id, slides: ["slide_02"] }];
    // xml MATCHES lgtm but the rough.js rendered-parts differ → xml-stable class
    // still fails (xmlPlusRenderedParts requires parts identity).
    const seam: MergeRenderSeam = {
      baseRecord: (sid) => ({ xmlHash: `base-${sid}`, renderedPartsHash: `base-${sid}` }),
      lgtmRecord: (sid) => sid === "slide_02" ? { xmlHash: "X02", renderedPartsHash: "R_APPROVED" } : { xmlHash: `base-${sid}`, renderedPartsHash: `base-${sid}` },
      renderMergeDeck: () => (sid) => sid === "slide_02" ? { xmlHash: "X02", renderedPartsHash: "R_MERGED" } : { xmlHash: `base-${sid}`, renderedPartsHash: `base-${sid}` },
    };
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: seam });
    try {
      const { report, threw } = await runMerge(base, green, ops, UPPER);
      assert.equal(threw, null);
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B rejected on xml-parts change");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "REAL ledger: slide_02 demoted");
    } finally { wsA.cleanup(); rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // (5) no green clusters → no-op.
  await test("(5) no green clusters → no promote, no demote, no throw", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = setupBase("nogreen", { pixelPerfect: ["slide_01"], xmlStable: [], unstable: [] });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: seamOver(base, {}) });
    try {
      const { report, threw } = await runMerge(base, [], ops, UPPER);
      assert.equal(threw, null);
      assert.deepEqual(report?.accepted ?? [], [], "nothing accepted");
      assert.ok(!existsSync(join(historyDir, "candidates.json")), "no ledger writes");
      assert.equal(readFileSync(join(base, CONVERTER_REL), "utf8"), BASE_FILE, "base untouched");
    } finally { rmSync(base, { recursive: true, force: true }); rmSync(historyDir, { recursive: true, force: true }); }
  });

  // no leaks
  await test("(6) no /overlays leaks after all merges", async () => {
    const leftover = existsSync(UPPER) ? readdirSync(UPPER) : [];
    assert.deepEqual(leftover, [], `UPPER should be empty, found ${JSON.stringify(leftover)}`);
  });

  try { rmSync(UPPER, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
