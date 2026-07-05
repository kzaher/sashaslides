/**
 * regression-gate.test.ts — the dual-class regression gate (regression-gate.ts).
 * ONLY the rendering (the record seams) + the LLM are mocked; the gate logic, the
 * stateful base-advancement adapter, and (in the wire-through) the COW workspace,
 * filesystem, promote, and ledger demote are REAL.
 *
 * Pure gate:
 *   (1) pixel-perfect green slide, 1-pixel diff vs LGTM     → green-pixel violation
 *   (2) xml-stable green slide, same xml+parts, diff pixel  → OK
 *   (3) non-targeted slide changed vs base                  → ripple in `changed`
 *   (4) all-clean                                           → ok, empty changed
 *   (5) SERIAL target-mutation: base = post-A → A's change NOT flagged as B's
 *       ripple; base = pristine → same change IS flagged (gate uses given base)
 *   (6) adapter advances the accepted base after a clean fork (serial mutation)
 *
 * Wire-through (REAL overlays + engine + promote + demote; render + LLM mocked):
 *   (7) clean gate                → all-at-once promote
 *   (8) pixel-class green violation → sequential fallback + demote
 * SKIPs loudly (exit 0) without CAP_SYS_ADMIN + /overlays.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import {
  MockIO,
  type EffectCall,
  type Matcher,
  type SpawnCaptureArgs,
  type SpawnCaptureResult,
} from "../../../structured-prompting/src/server/io.js";
import {
  createCowWorkspace,
  cleanupAllCowWorkspaces,
  type CowWorkspace,
} from "../../../structured-prompting/src/workspace/cow-workspace.js";
import {
  regressionGate,
  makeRegressionRetest,
  pixelIdentical,
  xmlPlusRenderedParts,
  unchanged,
  GREEN_REGRESSION_SENTINEL,
} from "./regression-gate.js";
import type { RenderRecord, StabilityClassification } from "./stability.js";
import { llmMerge, type GreenCluster, type MergeOps, type MergeReport } from "./llm-merge.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ""}`); failures.push({ name, err: extra }); }
}
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 6).join("\n      ")}`); }
}

const stab = (o: Partial<StabilityClassification>): StabilityClassification => ({
  pixelPerfect: o.pixelPerfect ?? [], xmlStable: o.xmlStable ?? [], unstable: o.unstable ?? [],
  warning: o.warning ?? "", attempts: o.attempts ?? 3,
});
const asFn = (m: Record<string, RenderRecord>) => (sid: string): RenderRecord => m[sid] ?? {};

// ---------------------------------------------------------------------------
// PURE gate + adapter tests (no overlays needed)
// ---------------------------------------------------------------------------
function pureTests(): void {
  console.log("\nregression-gate PURE tests (comparison + gate + adapter)\n");

  // comparison unit checks
  ok("cmp: pixelIdentical true on equal hash", pixelIdentical({ pixelHash: "P" }, { pixelHash: "P" }) && !pixelIdentical({ pixelHash: "P" }, { pixelHash: "Q" }));
  ok("cmp: xmlPlusRenderedParts ignores non-rendered pixel diff",
    xmlPlusRenderedParts({ xmlHash: "X", renderedPartsHash: "R", pixelHash: "A" }, { xmlHash: "X", renderedPartsHash: "R", pixelHash: "B" }) &&
    !xmlPlusRenderedParts({ xmlHash: "X", renderedPartsHash: "R" }, { xmlHash: "X", renderedPartsHash: "R2" }));
  ok("cmp: unchanged prefers pixel then xml",
    unchanged({ pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "DIFF" }) === true &&
    unchanged({ pixelHash: "P" }, { pixelHash: "Q" }) === false);

  // (1) pixel-perfect green slide with a 1-pixel diff vs LGTM → violation.
  {
    const res = regressionGate({
      stability: stab({ pixelPerfect: ["slide_01"] }),
      greenSlides: ["slide_01"],
      record: asFn({ slide_01: { pixelHash: "CUR" } }),
      lgtm: asFn({ slide_01: { pixelHash: "LGTM" } }),
      base: asFn({}),
    });
    ok("(1) pixel-perfect green ≠ LGTM → green-pixel violation + not ok",
      !res.ok && res.violations.length === 1 && res.violations[0].kind === "green-pixel" && res.changed.includes(GREEN_REGRESSION_SENTINEL),
      JSON.stringify(res));
  }

  // (2) xml-stable green slide: same xml + rendered-parts, differing non-rendered pixel → ok.
  {
    const res = regressionGate({
      stability: stab({ xmlStable: ["slide_02"] }),
      greenSlides: ["slide_02"],
      record: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R", pixelHash: "CURPIX" } }),
      lgtm: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R", pixelHash: "DIFFPIX" } }),
      base: asFn({}),
    });
    ok("(2) xml-stable green, xml+parts match, pixel differs → ok", res.ok && res.violations.length === 0 && res.changed.length === 0, JSON.stringify(res));
  }
  // (2b) xml-stable green with rendered-parts CHANGED → violation.
  {
    const res = regressionGate({
      stability: stab({ xmlStable: ["slide_02"] }),
      greenSlides: ["slide_02"],
      record: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R_NEW" } }),
      lgtm: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R" } }),
      base: asFn({}),
    });
    ok("(2b) xml-stable green, rendered-parts changed → green-xml-parts violation",
      !res.ok && res.violations[0]?.kind === "green-xml-parts" && res.changed.includes(GREEN_REGRESSION_SENTINEL), JSON.stringify(res));
  }

  // (3) non-targeted slide changed vs base → ripple in `changed`.
  {
    const res = regressionGate({
      stability: stab({ xmlStable: ["slide_03"] }),
      greenSlides: [],
      record: asFn({ slide_03: { pixelHash: "NEW" } }),
      lgtm: asFn({}),
      base: asFn({ slide_03: { pixelHash: "OLD" } }),
    });
    ok("(3) non-targeted changed → ripple in changed",
      !res.ok && res.changed.includes("slide_03") && !res.changed.includes(GREEN_REGRESSION_SENTINEL) && res.violations[0].kind === "ripple",
      JSON.stringify(res));
  }

  // (4) all-clean → ok, empty changed.
  {
    const res = regressionGate({
      stability: stab({ pixelPerfect: ["slide_01"], xmlStable: ["slide_02"] }),
      greenSlides: ["slide_01"],
      record: asFn({ slide_01: { pixelHash: "SAME" }, slide_02: { pixelHash: "B2" } }),
      lgtm: asFn({ slide_01: { pixelHash: "SAME" } }),
      base: asFn({ slide_02: { pixelHash: "B2" } }),
    });
    ok("(4) all-clean → ok, empty changed", res.ok && res.changed.length === 0 && res.violations.length === 0, JSON.stringify(res));
  }

  // (5) SERIAL target-mutation (pure): fork B's gate. slide_01 was mutated by the
  //     already-accepted fork A → it is fork B's NON-TARGETED slide. If base is the
  //     POST-A state, A's change must NOT be flagged as B's ripple.
  {
    const stability = stab({ pixelPerfect: ["slide_01", "slide_02"] });
    const postA: RenderRecord = { pixelHash: "A_RENDER" };
    const pristine: RenderRecord = { pixelHash: "PRISTINE" };
    // fork B currently renders: slide_01 = A's render (A already folded), slide_02 = B's fix.
    const mergeRender = asFn({ slide_01: postA, slide_02: { pixelHash: "B_RENDER" } });
    const lgtm = asFn({ slide_02: { pixelHash: "B_RENDER" } }); // B's slide matches its LGTM

    const okCase = regressionGate({ stability, greenSlides: ["slide_02"], record: mergeRender, lgtm, base: asFn({ slide_01: postA }) });
    ok("(5) base = post-A → A's change NOT flagged as B's ripple", okCase.ok && okCase.changed.length === 0, JSON.stringify(okCase));

    const badCase = regressionGate({ stability, greenSlides: ["slide_02"], record: mergeRender, lgtm, base: asFn({ slide_01: pristine }) });
    ok("(5b) base = pristine → same change IS flagged (gate honours given base)",
      !badCase.ok && badCase.changed.includes("slide_01"), JSON.stringify(badCase));
  }

  // (6) makeRegressionRetest ADVANCES the accepted base after a clean fork so the
  //     next fork compares against the post-previous-fork state.
  {
    const stability = stab({ pixelPerfect: ["slide_01", "slide_02"] });
    // mergeState mutates between retest calls (like the sequential COW workspace).
    let mergeState: Record<string, RenderRecord> = {};
    const retest = makeRegressionRetest({
      loadStability: () => stability,
      renderMergeDeck: () => (sid) => mergeState[sid] ?? {},
      // pristine base: slide_01 differs from A's render → WOULD ripple if base never advanced.
      baseRecord: asFn({ slide_01: { pixelHash: "PRISTINE_1" }, slide_02: { pixelHash: "PRISTINE_2" } }),
      lgtmRecord: asFn({ slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "B_RENDER" } }),
    });
    const dummyWs = {} as CowWorkspace;

    // fork A folds: slide_01 becomes A_RENDER (matches its LGTM), slide_02 untouched (pristine).
    mergeState = { slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "PRISTINE_2" } };
    const r1 = retest(dummyWs, ["slide_01"]);
    ok("(6) fork A clean retest → no ripple", r1.changed.length === 0, JSON.stringify(r1));

    // fork B folds: slide_01 stays A_RENDER (accepted), slide_02 becomes B_RENDER (matches LGTM).
    mergeState = { slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "B_RENDER" } };
    const r2 = retest(dummyWs, ["slide_02"]);
    ok("(6b) fork B retest → A's accepted change NOT re-flagged (base advanced)", r2.changed.length === 0, JSON.stringify(r2));

    // Control: a FRESH adapter that never saw A clean would ripple slide_01 for B.
    const retestFresh = makeRegressionRetest({
      loadStability: () => stability,
      renderMergeDeck: () => (sid) => mergeState[sid] ?? {},
      baseRecord: asFn({ slide_01: { pixelHash: "PRISTINE_1" }, slide_02: { pixelHash: "PRISTINE_2" } }),
      lgtmRecord: asFn({ slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "B_RENDER" } }),
    });
    const rControl = retestFresh(dummyWs, ["slide_02"]);
    ok("(6c) control: without A's clean fold, slide_01 DOES ripple for B", rControl.changed.includes("slide_01"), JSON.stringify(rControl));
  }
}

// ---------------------------------------------------------------------------
// Wire-through (REAL overlays + engine; render + LLM mocked)
// ---------------------------------------------------------------------------
function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}
function claudeReply(result: string): SpawnCaptureResult {
  return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "mock", duration_ms: 1, total_cost_usd: 0 }), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
const bashReply = (stdout = ""): SpawnCaptureResult => ({ stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null });
const isClaude = (c: EffectCall): boolean => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "claude";
const isBash = (c: EffectCall): boolean => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash";
function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
    { name: "bash-echo", when: isBash, returns: bashReply(""), optional: true },
    { name: "git-diff-capture", when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "git", returns: bashReply(""), optional: true },
    { name: "writeFileSync", when: (c) => c.method === "writeFileSync", returns: undefined, optional: true },
    { name: "rmSync", when: (c) => c.method === "rmSync", returns: undefined, optional: true },
    { name: "mkdtempSync", when: (c) => c.method === "mkdtempSync", returns: "/tmp/mock-x", optional: true },
  ];
}
function fencedBlocks(prompt: string): string[] {
  return prompt.split("```").filter((_, i) => i % 2 === 1).map((b) => b.replace(/^\n/, "").replace(/\n$/, ""));
}
/** Mock LLM: union the base block with every FIX_ line from the proposals. */
function mockMerge(prompt: string): string {
  const [base, ...proposals] = fencedBlocks(prompt);
  const have = new Set((base ?? "").split("\n"));
  const out = (base ?? "").split("\n");
  for (const p of proposals) for (const line of p.split("\n")) if (/FIX_/.test(line) && !have.has(line)) { have.add(line); out.push(line); }
  return out.join("\n");
}

const CONVERTER_REL = "renderer/html2slides/convert-pptx.ts";
const BASE_FILE = ["// convert-pptx.ts (test fixture)", "export const A = 1;", ""].join("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Which fix line drives which slide's render (fix→slide map). A slide's render
 *  only depends on its OWN fix, so an unrelated fork's edit doesn't ripple it. */
const FIX_FOR_SLIDE: Record<string, string> = { slide_01: "FIX_A" };
/** Model a per-slide render from the converter file content. */
function perSlideRecord(sid: string, content: string): RenderRecord {
  const fix = FIX_FOR_SLIDE[sid];
  const active = fix && new RegExp(fix).test(content) ? fix : "";
  const key = sha(`${sid}|${active}`);
  return { pixelHash: key, xmlHash: key, renderedPartsHash: key };
}

function makeFork(base: string, upperRoot: string, id: string, fixConst: string): CowWorkspace {
  const ws = createCowWorkspace({ base, upperRoot, id });
  const line = `export const ${fixConst} = "${fixConst}";`;
  const r = ws.run("bash", ["-c", `printf '%s\\n' '${line}' >> ${CONVERTER_REL}`]);
  if (r.code !== 0) throw new Error(`fork edit failed for ${id}: ${r.stderr}`);
  return ws;
}

/** Build the gate-backed ops. Rendering is MOCKED (perSlideRecord over the ws
 *  converter content); promote is REAL; demote is captured. */
function gateOps(base: string, lgtm: (sid: string) => RenderRecord, demoteCalls: Array<{ slides: string[]; task: string; reason: string }>): MergeOps {
  const stability = stab({ pixelPerfect: ["slide_01"], xmlStable: ["slide_02"], unstable: ["slide_03"] });
  const retest = makeRegressionRetest({
    loadStability: () => stability,
    renderMergeDeck: (ws) => {
      const content = ws.readUpperFile(CONVERTER_REL) ?? (existsSync(join(base, CONVERTER_REL)) ? readFileSync(join(base, CONVERTER_REL), "utf8") : BASE_FILE);
      return (sid) => perSlideRecord(sid, content);
    },
    baseRecord: (sid) => perSlideRecord(sid, BASE_FILE),
    lgtmRecord: lgtm,
  });
  return {
    retest,
    promote(ws, files) { ws.promote(files); },
    demote(slides, task, reason) { demoteCalls.push({ slides, task, reason }); },
  };
}

async function runMerge(base: string, green: GreenCluster[], ops: MergeOps, upperRoot: string): Promise<MergeReport | undefined> {
  const io = new MockIO({
    matchers: [
      ...baseMatchers(),
      { name: "llm-merge", when: isClaude, returns: (c: EffectCall) => {
        const a = c.args[0] as SpawnCaptureArgs; const pi = a.args.indexOf("-p");
        return claudeReply(mockMerge(pi >= 0 ? (a.args[pi + 1] ?? "") : ""));
      } },
    ],
  });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  try {
    return await engine.execute(new Session({ sessionId: "gate-wire", cwd: base }),
      (s) => llmMerge(s, { repo: base, greenClusters: green, ops, upperRoot }));
  } finally { await engine.shutdown(); }
}

async function wireTests(upperRoot: string): Promise<void> {
  // (7) clean gate → all-at-once promote.
  await atest("(7) clean gate → all-at-once promote (green pixel matches LGTM)", async () => {
    const base = mkdtempSync(join(tmpdir(), "gate-clean-"));
    mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
    writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
    const wsA = makeFork(base, upperRoot, `gc-a-${process.pid}-${Date.now()}`, "FIX_A");
    const green: GreenCluster[] = [{ task: "task-a", branch_id: wsA.id, slides: ["slide_01"] }];
    // LGTM(slide_01) = the render of base+FIX_A → matches the merged output → clean.
    const lgtm = (sid: string) => perSlideRecord(sid, BASE_FILE + `export const FIX_A = "FIX_A";\n`);
    const demoteCalls: Array<{ slides: string[]; task: string; reason: string }> = [];
    try {
      const report = await runMerge(base, green, gateOps(base, lgtm, demoteCalls), upperRoot);
      assert.equal(report?.mode, "all-at-once", `mode=${report?.mode}`);
      assert.deepEqual(report?.accepted, ["task-a"], "task-a accepted");
      assert.ok(/FIX_A/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "promoted base has FIX_A");
      assert.equal(demoteCalls.length, 0, "no demote on clean path");
    } finally {
      wsA.cleanup(); rmSync(base, { recursive: true, force: true });
    }
  });

  // (8) pixel-class green violation → sequential fallback + demote.
  await atest("(8) pixel-class green violation → sequential fallback + demote", async () => {
    const base = mkdtempSync(join(tmpdir(), "gate-viol-"));
    mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
    writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
    const wsA = makeFork(base, upperRoot, `gv-a-${process.pid}-${Date.now()}`, "FIX_A");
    const green: GreenCluster[] = [{ task: "task-a", branch_id: wsA.id, slides: ["slide_01"] }];
    // LGTM(slide_01) is an UNREACHABLE approved render → the merge can never match
    // it → pixel-perfect green violation on every attempt.
    const lgtm = (sid: string): RenderRecord => sid === "slide_01" ? { pixelHash: "APPROVED_UNREACHABLE" } : perSlideRecord(sid, BASE_FILE);
    const demoteCalls: Array<{ slides: string[]; task: string; reason: string }> = [];
    try {
      const report = await runMerge(base, green, gateOps(base, lgtm, demoteCalls), upperRoot);
      assert.equal(report?.mode, "sequential", `mode=${report?.mode}`);
      assert.deepEqual(report?.accepted, [], "nothing accepted");
      assert.deepEqual(report?.rejected.map((r) => r.task), ["task-a"], "task-a rejected");
      assert.ok(!/FIX_A/.test(readFileSync(join(base, CONVERTER_REL), "utf8")), "base rolled back (no FIX_A)");
      assert.equal(demoteCalls.length, 1, "exactly one demote");
      assert.deepEqual(demoteCalls[0].slides, ["slide_01"], "demoted the green slide");
    } finally {
      wsA.cleanup(); rmSync(base, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  pureTests();

  const skip = overlayAvailable();
  const UPPER_ROOT = "/overlays/regression-gate-test";
  if (skip) {
    console.log(`\n  ⚠ SKIP wire-through — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.\n`);
  } else {
    console.log("\nregression-gate WIRE-THROUGH (REAL overlays + engine + promote/demote; render + LLM mocked)\n");
    try { rmSync(UPPER_ROOT, { recursive: true, force: true }); } catch { /* */ }
    try {
      await wireTests(UPPER_ROOT);
      const leftover = existsSync(UPPER_ROOT) ? readdirSync(UPPER_ROOT) : [];
      ok("(9) no /overlays leaks after wire-through cleanup", leftover.length === 0, JSON.stringify(leftover));
    } finally {
      // ALWAYS reap overlays (known hang if orphan test overlays linger).
      cleanupAllCowWorkspaces(UPPER_ROOT);
      try { rmSync(UPPER_ROOT, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); cleanupAllCowWorkspaces("/overlays/regression-gate-test"); process.exit(1); });
