/**
 * overlay-lifecycle.e2e.test.ts — REAL overlays for the overlay-PERSISTENCE
 * lifecycle. Per the mock policy (test-support.ts) the merge cases (C1, R1) mock
 * ONLY (H) the human rating, (L) the LLM, and (R) the Slides recording; the COW
 * workspaces, filesystem, git, clock, the REAL regression gate, promote, the
 * demote ledger (temp dir), and the JAIL all run for real.
 *
 * Covers:
 *   (P)  PERSISTENCE — a workspace created in a process that EXITS still exists
 *        (registerOverlayCleanup is a no-op; no death handler reaps it).
 *   (C)  CLEANUP-ON-SUCCESS — a merged+promoted cluster's overlay + shared dir
 *        are reaped; a demoted cluster's overlay + shared dir are LEFT.
 *   (D)  STARTUP-DETECTION — pure detectPriorState + decideStartup: prior state +
 *        no flag = error (naming both options); --clean = clean; --continue = resume.
 *   (R)  RESUME-MERGE — 2 green + 1 bad persisted overlays → resumeMerge folds +
 *        promotes + reaps the green, skips/demotes/leaves the bad.
 *   (J)  JAIL — a command run under COW_WORKSPACE_JAIL can write the sandbox but a
 *        stray write outside is DENIED.
 *
 * The pure (D) unit tests run ALWAYS. The overlay-backed tests SKIP loudly
 * (exit 0) when SYS_ADMIN / /overlays are unavailable.
 *
 * Run: npx tsx renderer/structured-prompts/bug_solving/overlay-lifecycle.e2e.test.ts
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCowWorkspace, type CowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import { realLlmMergeOps, ledgerDemote, type GreenCluster } from "./llm-merge.js";
import { writeStabilityJson } from "./stability.js";
import { detectPriorState, decideStartup } from "./startup-detection.js";
import { resumeMerge } from "./resume-merge.js";
import { mockLlm, mergeComposer, recordingFromContent, contentRecord, greenCluster, runRealMerge } from "./test-support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "/workspaces/sashaslides";
const SH = `${REPO}/cow-workspace/workspace.sh`;

let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 8).join("\n      ")}`); }
}
function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

// The merge cases (C1, R1) run the REAL merge through the REAL gate; per the mock
// policy they mock ONLY (H) the human rating (markers/green clusters), (L) the LLM
// (test-support.mockLlm — real IO otherwise), and (R) the Slides recording
// (test-support.recordingFromContent). The regression gate, overlays, promote, and
// the demote ledger (pointed at a temp dir) all run for real.

// ── Real fork helpers ───────────────────────────────────────────────────────
const CONVERTER_REL = "renderer/html2slides/convert-pptx.ts";
const BASE_FILE = ["// convert-pptx.ts (test fixture)", "export const A = 1;", ""].join("\n");
function makeFork(base: string, upperRoot: string, id: string, fixConst: string): CowWorkspace {
  const ws = createCowWorkspace({ base, upperRoot, id });
  const r = ws.run("bash", ["-c", `printf '%s\\n' 'export const ${fixConst} = "${fixConst}";' >> ${CONVERTER_REL}`]);
  if (r.code !== 0) throw new Error(`fork edit failed for ${id}: ${r.stderr}`);
  return ws;
}
/** A git-initialised converter base on /overlays with a fixtures deck + a real
 *  stability.json + a temp history dir — everything realLlmMergeOps needs to run
 *  the REAL gate + REAL ledger. `deck` = slide ids to write fixtures/stability for. */
/** Plain converter base dir on /overlays (no fixtures/gate) — for lifecycle
 *  cases that don't run the merge. */
function mkBase(prefix: string): string {
  const base = mkdtempSync(join("/overlays", prefix));
  mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
  writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
  return base;
}
function mkConverterBase(prefix: string, stab: { pixelPerfect: string[]; xmlStable: string[]; unstable: string[] }): { base: string; fixturesDir: string; stabilityPath: string; historyDir: string } {
  const base = mkBase(prefix);
  const fixturesDir = join(base, "fx");
  mkdirSync(fixturesDir, { recursive: true });
  for (const sid of [...stab.pixelPerfect, ...stab.xmlStable, ...stab.unstable]) writeFileSync(join(fixturesDir, `${sid}.html`), "<html></html>");
  const stabilityPath = join(base, "stability.json");
  writeStabilityJson(stabilityPath, { ...stab, warning: "", attempts: 3 });
  execSync(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base`, { cwd: base });
  const historyDir = mkdtempSync(join("/tmp", `${prefix}hist-`));
  return { base, fixturesDir, stabilityPath, historyDir };
}
const candStatus = (historyDir: string, sid: string): string | undefined => {
  const f = join(historyDir, "candidates.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { status?: string }>)[sid]?.status : undefined;
};

// ── (D) PURE startup-detection unit tests (run ALWAYS) ──────────────────────
async function pureUnitTests(): Promise<void> {
  console.log("\n(D) startup-detection (pure — no overlay needed)\n");
  await test("(D1) prior state + NO flag → error naming both --clean and --continue", () => {
    const d = decideStartup({ branches: ["bs-x-1"], shared: ["run-1"], hasState: true }, { clean: false, cont: false });
    assert.equal(d.action, "error");
    assert.ok(/--clean/.test(d.message ?? ""), "message names --clean");
    assert.ok(/--continue/.test(d.message ?? ""), "message names --continue");
    assert.ok(/1 workspace/.test(d.message ?? ""), "message counts workspaces");
  });
  await test("(D2) prior state + --clean → clean action (wipe then fresh)", () => {
    assert.equal(decideStartup({ branches: ["bs-x-1"], shared: [], hasState: true }, { clean: true, cont: false }).action, "clean");
  });
  await test("(D3) prior state + --continue → resume action (never wipes)", () => {
    assert.equal(decideStartup({ branches: ["bs-x-1"], shared: [], hasState: true }, { clean: false, cont: true }).action, "resume");
  });
  await test("(D4) no prior state → fresh", () => {
    assert.equal(decideStartup({ branches: [], shared: [], hasState: false }, { clean: false, cont: false }).action, "fresh");
  });
  await test("(D5) detectPriorState reads both roots off disk", () => {
    const tmp = mkdtempSync(join("/tmp", "lc-detect-"));
    const br = join(tmp, "branches"); const sh = join(tmp, "shared");
    try {
      mkdirSync(br, { recursive: true }); mkdirSync(sh, { recursive: true });
      assert.equal(detectPriorState(br, sh).hasState, false, "empty roots → no state");
      mkdirSync(join(br, "bs-task-123"), { recursive: true });
      const s = detectPriorState(br, sh);
      assert.equal(s.hasState, true, "a branch dir → state");
      assert.deepEqual(s.branches, ["bs-task-123"]);
      assert.equal(detectPriorState(join(tmp, "missing"), join(tmp, "missing2")).hasState, false, "absent roots → no state");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\noverlay-lifecycle E2E (REAL overlays + fs + ledger + jail; mock LLM + retest)\n");
  await pureUnitTests();

  const skip = overlayAvailable();
  if (skip) {
    console.log(`\n  ⚠ SKIP overlay-backed tests — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`);
    finishOrExit();
    return;
  }

  const UPPER_ROOT = `/overlays/lifecycle-e2e-${process.pid}`;
  const SHARED = `/overlays/lifecycle-shared-${process.pid}`;
  try { rmSync(UPPER_ROOT, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(SHARED, { recursive: true, force: true }); } catch { /* */ }

  // ── (P) PERSISTENCE — created workspace survives the creating process exit ──
  console.log("\n(P) persistence — no auto-reap on exit\n");
  await test("(P1) workspace persists after its creating process exits (registerOverlayCleanup is a no-op)", () => {
    const base = mkBase("lc-persist-base-");
    const id = `persist-${process.pid}-${Date.now()}`;
    const driver = join("/tmp", `lc-persist-driver-${process.pid}.mjs`);
    try {
      writeFileSync(driver, `
        process.env.COW_WORKSPACE_ROOT = ${JSON.stringify(UPPER_ROOT)};
        const { createCowWorkspace } = await import(${JSON.stringify(resolve(REPO, "cow-workspace/cow-workspace.ts"))});
        const { registerOverlayCleanup } = await import(${JSON.stringify(resolve(HERE, "overlay-cleanup.ts"))});
        registerOverlayCleanup();                    // no-op: no startup sweep, no death handler
        const ws = createCowWorkspace({ base: ${JSON.stringify(base)}, id: ${JSON.stringify(id)}, upperRoot: ${JSON.stringify(UPPER_ROOT)} });
        const r = ws.run("bash", ["-c", "echo x > persist_probe.txt"]);
        if (r.code !== 0) { console.error("run failed", r.stderr); process.exit(3); }
        process.exit(0);                             // clean exit — nothing must reap
      `);
      execSync(`npx tsx ${driver}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.ok(existsSync(join(UPPER_ROOT, id)), "workspace dir must PERSIST after the process exited");
      assert.ok(existsSync(join(UPPER_ROOT, id, "upper", "persist_probe.txt")), "the edit must persist in the upper layer");
    } finally {
      rmSync(driver, { force: true });
      try { execSync(`bash "${SH}" rm ${id}`, { env: { ...process.env, COW_WORKSPACE_ROOT: UPPER_ROOT }, stdio: "ignore" }); } catch { /* */ }
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ── (C) CLEANUP-ON-SUCCESS — promoted reaped, demoted left ─────────────────
  console.log("\n(C) cleanup-on-success — promote reaps, demote leaves\n");
  await test("(C1) promoted cluster's overlay+shared reaped; demoted cluster's overlay+shared LEFT", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = mkConverterBase("lc-cos-base-", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02", "slide_03"], unstable: [] });
    const wsA = makeFork(base, UPPER_ROOT, `fork-a-${process.pid}-${Date.now()}`, "FIX_A");
    const wsB = makeFork(base, UPPER_ROOT, `fork-b-${process.pid}-${Date.now()}`, "FIX_B");
    const sharedA = join(SHARED, "run1", "task-a");
    const sharedB = join(SHARED, "run1", "task-b");
    mkdirSync(sharedA, { recursive: true }); writeFileSync(join(sharedA, "rating-outcome.json"), "{}");
    mkdirSync(sharedB, { recursive: true }); writeFileSync(join(sharedB, "rating-outcome.json"), "{}");
    const green: GreenCluster[] = [
      { ...greenCluster("task-a", wsA, ["slide_01"]), shared_dir: sharedA },
      { ...greenCluster("task-b", wsB, ["slide_02"]), shared_dir: sharedB },
    ];
    // REAL gate: slide_03 (non-targeted) responds to FIX_B → folding B ripples it.
    // all-at-once fails → sequential: A clean (kept), B rolled back + REAL-demoted.
    const fixMap = { slide_01: "FIX_A", slide_02: "FIX_B", slide_03: "FIX_B" };
    const recording = recordingFromContent({ converterRel: CONVERTER_REL, baseFileContent: BASE_FILE, fixMap, tag: "R:C1", lgtm: (sid) => sid === "slide_02" ? contentRecord("slide_02", BASE_FILE, fixMap) : undefined });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    try {
      const { report } = await runRealMerge({ base, green, ops, upperRoot: UPPER_ROOT, llm: mockLlm(mergeComposer, { tag: "L:merge-compose" }) });
      assert.equal(report!.mode, "sequential", "fell back to sequential");
      assert.deepEqual(report!.accepted, ["task-a"], "only A accepted");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "B rejected");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && !/FIX_B/.test(merged), "base has A's fix, not B's");
      assert.ok(!existsSync(join(UPPER_ROOT, wsA.id)), "accepted fork A overlay REAPED");
      assert.ok(!existsSync(sharedA), "accepted fork A shared dir REAPED");
      assert.ok(existsSync(join(UPPER_ROOT, wsB.id)), "demoted fork B overlay LEFT");
      assert.ok(existsSync(sharedB), "demoted fork B shared dir LEFT");
      assert.equal(candStatus(historyDir, "slide_02"), "bad", "REAL ledger: B's slide demoted");
    } finally {
      wsA.cleanup(); wsB.cleanup();
      rmSync(base, { recursive: true, force: true });
      rmSync(historyDir, { recursive: true, force: true });
      try { rmSync(join(SHARED, "run1"), { recursive: true, force: true }); } catch { /* */ }
    }
  });

  // ── (R) RESUME-MERGE — enumerate persisted overlays, fold green, skip bad ──
  console.log("\n(R) resume-merge — persisted overlays → fold green, demote bad\n");
  await test("(R1) resumeMerge folds+promotes+reaps 2 green; skips+demotes+leaves 1 bad", async () => {
    const { base, fixturesDir, stabilityPath, historyDir } = mkConverterBase("lc-resume-base-", { pixelPerfect: ["slide_01"], xmlStable: ["slide_02", "slide_03"], unstable: [] });
    const ts = Date.now();
    const idA = `bs-taskA-${ts}`, idB = `bs-taskB-${ts + 1}`, idC = `bs-taskC-${ts + 2}`;
    const wsA = makeFork(base, UPPER_ROOT, idA, "FIX_A");
    const wsB = makeFork(base, UPPER_ROOT, idB, "FIX_B");
    const wsC = makeFork(base, UPPER_ROOT, idC, "FIX_C");
    // (H) human markers under SHARED/run1/<task>/rating-outcome.json
    const mk = (task: string, green: boolean, slides: string[], bad: string[] = []) => {
      const d = join(SHARED, "run1", task); mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "rating-outcome.json"), JSON.stringify({ task_id: task, green, rated: true, good: green ? slides : [], bad, unrated: [], slides }));
    };
    mk("taskA", true, ["slide_01"]);
    mk("taskB", true, ["slide_02"]);
    mk("taskC", false, ["slide_03"], ["slide_03"]);
    // REAL gate: A+B fold clean all-at-once (slide_03 untouched by FIX_A/FIX_B).
    const recording = recordingFromContent({ converterRel: CONVERTER_REL, baseFileContent: BASE_FILE, fixMap: { slide_01: "FIX_A", slide_02: "FIX_B" }, tag: "R:R1" });
    const ops = realLlmMergeOps({ repo: base, fixturesDir, stabilityPath, historyDir, render: recording });
    try {
      const res = await resumeMerge({
        repo: base, branchesRoot: UPPER_ROOT, sharedRoot: SHARED, upperRoot: UPPER_ROOT,
        ops, io: mockLlm(mergeComposer, { tag: "L:merge-compose" }).io,
        demote: (slides, task, reason) => ledgerDemote(historyDir, slides, task, reason), // REAL ledger → temp
        log: () => { /* quiet */ },
      });
      assert.equal(res.report?.mode, "all-at-once", "green folded all-at-once");
      assert.deepEqual(res.green.map((g) => g.task).sort(), ["taskA", "taskB"], "2 green enumerated");
      assert.deepEqual(res.demoted, ["taskC"], "taskC demoted");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged) && /FIX_B/.test(merged), "promoted base carries both green fixes");
      assert.ok(!existsSync(join(UPPER_ROOT, idA)) && !existsSync(join(UPPER_ROOT, idB)), "green overlays REAPED");
      assert.ok(!existsSync(join(SHARED, "run1", "taskA")) && !existsSync(join(SHARED, "run1", "taskB")), "green shared dirs REAPED");
      assert.ok(existsSync(join(UPPER_ROOT, idC)), "bad overlay LEFT");
      assert.ok(existsSync(join(SHARED, "run1", "taskC")), "bad shared dir LEFT");
      assert.equal(candStatus(historyDir, "slide_03"), "bad", "REAL ledger: taskC's slide demoted");
    } finally {
      wsA.cleanup(); wsB.cleanup(); wsC.cleanup();
      rmSync(base, { recursive: true, force: true });
      rmSync(historyDir, { recursive: true, force: true });
      try { rmSync(join(SHARED, "run1"), { recursive: true, force: true }); } catch { /* */ }
    }
  });

  // ── (J) JAIL — sandbox writable, stray write denied ────────────────────────
  console.log("\n(J) jail — solve/merge command sandboxed\n");
  await test("(J1) jailed command: base+extra+/tmp writable, /var read-only (stray write DENIED)", () => {
    const base = mkdtempSync(join("/overlays", "lc-jail-base-"));
    const stateDir = mkdtempSync(join("/home/node", "lc-jail-state-"));
    writeFileSync(join(base, "file.txt"), "base\n");
    writeFileSync(join(stateDir, "session"), "orig\n");
    const root = `/overlays/lc-jail-${process.pid}`;
    const jailEnv = { ...process.env, COW_WORKSPACE_ROOT: root, COW_WORKSPACE_BASE: base, COW_WORKSPACE_JAIL: "1", COW_WORKSPACE_OVERLAY_EXTRA: `${stateDir}:/home/node/.codex` } as NodeJS.ProcessEnv;
    const canWrite = (id: string, cmd: string): boolean => {
      try { execSync(`bash "${SH}" run ${id} bash -c ${JSON.stringify(cmd)}`, { env: jailEnv, stdio: "ignore" }); return true; }
      catch { return false; }
    };
    try {
      assert.ok(canWrite("jail", "echo x >> file.txt"), "base overlay writable");
      assert.ok(canWrite("jail", `echo x > ${stateDir}/session`), "extra (worker state) overlay writable");
      assert.ok(canWrite("jail", "echo x > /tmp/__lc_jail"), "tmpfs /tmp writable");
      assert.ok(!canWrite("jail", "echo x > /var/__lc_jail_leak"), "/var stray write DENIED");
      assert.equal(readFileSync(join(stateDir, "session"), "utf8"), "orig\n", "real state dir untouched (write stayed in overlay upper)");
      assert.ok(!existsSync("/var/__lc_jail_leak"), "no leak to real /var");
    } finally {
      try { execSync(`bash "${SH}" cleanup-all`, { env: jailEnv, stdio: "ignore" }); } catch { /* */ }
      try { if (existsSync("/var/__lc_jail_leak")) execSync("sudo rm -f /var/__lc_jail_leak"); } catch { /* */ }
      rmSync(base, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // ── leave overlays clean ───────────────────────────────────────────────────
  await test("(Z) tests reap their own overlays (isolated roots empty/removed)", () => {
    // Reap the demoted/bad overlays the success/resume tests intentionally left.
    try { execSync(`bash "${SH}" cleanup-all`, { env: { ...process.env, COW_WORKSPACE_ROOT: UPPER_ROOT }, stdio: "ignore" }); } catch { /* */ }
    rmSync(UPPER_ROOT, { recursive: true, force: true });
    rmSync(SHARED, { recursive: true, force: true });
    assert.ok(!existsSync(UPPER_ROOT), "UPPER_ROOT removed");
    assert.ok(!existsSync(SHARED), "SHARED removed");
  });

  finishOrExit();
}

function finishOrExit(): void {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
