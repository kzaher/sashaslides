/**
 * llm-merge.e2e.test.ts — REAL end-to-end for the SIMPLE LLM merge
 * (llm-merge.ts). Nothing but the LLM (via MockIO) + `ops.retest` is mocked;
 * the COW workspaces, the filesystem, promote, and the demote ledger are REAL.
 *
 * The base is a throwaway /tmp dir with a converter file at the real converter
 * path (renderer/html2slides/convert-pptx.ts) so the default converter filter
 * picks it up. Each "green fork" is a REAL CowWorkspace whose upper carries a
 * distinct real edit to that file.
 *
 * Asserted (all against the REAL filesystem / ledger):
 *   (1) ALL-AT-ONCE clean  → promoted base carries BOTH forks' edits.
 *   (2) ALL-AT-ONCE ripple → SEQUENTIAL fallback keeps the clean fork, calls
 *       `demote` for the rippling one, and the promoted base has ONLY the kept
 *       fork's edit.
 *   (3) SERIAL target-mutation → fork B's LLM prompt's "Base version" already
 *       contains fork A's folded change (NOT the pristine base) — proving the
 *       target mutates as forks fold in.
 *   (4) SHARED-DIR marker → a marker written by a command run INSIDE a workspace
 *       to the absolute /overlays/shared path is readable from OUTSIDE.
 *
 * The LLM prompt is deliberately MINIMAL (buildMergePrompt): base + N proposed
 * versions → "Return ONLY the merged file contents". The mock here just
 * simulates "incorporate every FIX_ line".
 *
 * Requires CAP_SYS_ADMIN + an ext4 /overlays volume; SKIPs loudly (exit 0) if
 * absent. Run: npx tsx renderer/structured-prompts/bug_solving/llm-merge.e2e.test.ts
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
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
  type CowWorkspace,
} from "../../../cow-workspace/cow-workspace.js";
import { llmMerge, type GreenCluster, type MergeOps, type MergeReport } from "./llm-merge.js";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 8).join("\n      ")}`); }
}

function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

// ---------------------------------------------------------------------------
// MockIO reply builders (mirror merge-phase.test.ts / scheduler.test.ts)
// ---------------------------------------------------------------------------
function claudeReply(result: string): SpawnCaptureResult {
  const payload = { type: "result", subtype: "success", is_error: false, result, session_id: "mock-sid", duration_ms: 1, total_cost_usd: 0 };
  return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
function bashReply(stdout = ""): SpawnCaptureResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
function isClaude(c: EffectCall): boolean { return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "claude"; }
function isBash(c: EffectCall): boolean { return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash"; }

/** Non-LLM matchers: clock, log, echo bash nodes, the engine's per-node git
 *  diff-capture, plus the fs methods the diff-capture may touch. */
function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
    { name: "bash-echo", when: isBash, returns: bashReply(""), optional: true },
    { name: "git-diff-capture", when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "git", returns: bashReply(""), optional: true },
    { name: "writeFileSync", when: (c) => c.method === "writeFileSync", returns: undefined, optional: true },
    { name: "rmSync", when: (c) => c.method === "rmSync", returns: undefined, optional: true },
    { name: "mkdtempSync", when: (c) => c.method === "mkdtempSync", returns: "/tmp/mock-llm-merge-XXXX", optional: true },
  ];
}

/** Extract the ```-fenced blocks from a buildMergePrompt prompt. Block 0 = base
 *  version; the rest = the proposed versions. */
function fencedBlocks(prompt: string): string[] {
  return prompt.split("```").filter((_, i) => i % 2 === 1).map((b) => b.replace(/^\n/, "").replace(/\n$/, ""));
}

/** The MOCK "LLM": produce a merged file = the base block plus every `FIX_` line
 *  from the proposals that isn't already present. Simulates "incorporate all
 *  fixes" and naturally propagates through the serial fold (each fork's base is
 *  the mutated accepted state). */
function mockMerge(prompt: string): string {
  const [base, ...proposals] = fencedBlocks(prompt);
  const baseLines = (base ?? "").split("\n");
  const have = new Set(baseLines);
  const extra: string[] = [];
  for (const p of proposals) {
    for (const line of p.split("\n")) {
      if (/FIX_/.test(line) && !have.has(line)) { have.add(line); extra.push(line); }
    }
  }
  return [...baseLines, ...extra].join("\n");
}

// ---------------------------------------------------------------------------
// Real fork setup
// ---------------------------------------------------------------------------
const CONVERTER_REL = "renderer/html2slides/convert-pptx.ts";
const BASE_FILE = [
  "// convert-pptx.ts (test fixture)",
  "export const A = 1;",
  "export const B = 2;",
  "",
].join("\n");

/** Create a REAL green fork: a CowWorkspace over `base` whose upper appends a
 *  distinct `export const <fixConst> = …;` line to the converter file. */
function makeFork(base: string, upperRoot: string, id: string, fixConst: string): CowWorkspace {
  const ws = createCowWorkspace({ base, upperRoot, id });
  const line = `export const ${fixConst} = "${fixConst}";`;
  const r = ws.run("bash", ["-c", `printf '%s\\n' '${line}' >> ${CONVERTER_REL}`]);
  if (r.code !== 0) throw new Error(`fork edit failed for ${id}: ${r.stderr}`);
  return ws;
}

/** A scriptable `ops`: retest is a queue of changed-slide sets (shifted per
 *  call); promote + demote are REAL (ws.promote onto base + ledgerDemote-shaped
 *  writes captured here — we use the real llm-merge ledger via a temp historyDir
 *  through a thin wrapper so we can inspect it). */
interface ScriptedOps extends MergeOps {
  retestCalls: string[][];
  demoteCalls: Array<{ slides: string[]; task: string; reason: string }>;
  promoteCalls: string[][];
}
function makeOps(retestQueue: string[][], historyDir: string): ScriptedOps {
  const retestCalls: string[][] = [];
  const demoteCalls: Array<{ slides: string[]; task: string; reason: string }> = [];
  const promoteCalls: string[][] = [];
  return {
    retestCalls, demoteCalls, promoteCalls,
    retest(_ws, _intended) {
      const changed = retestQueue.shift() ?? [];
      retestCalls.push(changed);
      return { changed };
    },
    promote(ws, files) {
      promoteCalls.push(files);
      ws.promote(files); // REAL copy onto base
    },
    demote(slides, task, reason) {
      demoteCalls.push({ slides, task, reason });
      // REAL ledger write into the test's temp historyDir.
      const candFile = join(historyDir, "candidates.json");
      mkdirSync(historyDir, { recursive: true });
      const cand: Record<string, { status?: string }> = existsSync(candFile) ? JSON.parse(readFileSync(candFile, "utf8")) : {};
      for (const s of slides) cand[s] = { ...(cand[s] ?? {}), status: "bad" };
      writeFileSync(candFile, JSON.stringify(cand, null, 2));
    },
  };
}

/** Run llmMerge through the REAL engine + MockIO, capturing every LLM prompt. */
async function runMerge(opts: {
  base: string;
  green: GreenCluster[];
  ops: MergeOps;
  upperRoot: string;
}): Promise<{ report: MergeReport | undefined; prompts: string[]; threw: unknown }> {
  const prompts: string[] = [];
  const io = new MockIO({
    matchers: [
      ...baseMatchers(),
      {
        name: "llm-merge",
        when: isClaude,
        returns: (c: EffectCall) => {
          const a = c.args[0] as SpawnCaptureArgs;
          const pi = a.args.indexOf("-p");
          const prompt = pi >= 0 ? (a.args[pi + 1] ?? "") : "";
          prompts.push(prompt);
          return claudeReply(mockMerge(prompt));
        },
      },
    ],
  });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  let report: MergeReport | undefined;
  let threw: unknown = null;
  try {
    report = await engine.execute(
      new Session({ sessionId: "llm-merge-e2e", cwd: opts.base }),
      (s) => llmMerge(s, { repo: opts.base, greenClusters: opts.green, ops: opts.ops, upperRoot: opts.upperRoot }),
    );
  } catch (e) { threw = e; }
  finally { await engine.shutdown(); }
  return { report, prompts, threw };
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("\nllm-merge E2E (REAL overlay forks + fs + ledger; mock LLM + retest)\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }

  const UPPER_ROOT = "/overlays/llm-merge-e2e";
  try { rmSync(UPPER_ROOT, { recursive: true, force: true }); } catch { /* */ }

  // ── (1) ALL-AT-ONCE clean → both forks' edits promoted ────────────────────
  await test("(1) all-at-once clean → promoted base carries BOTH forks' edits", async () => {
    const base = mkdtempSync(join(tmpdir(), "llm-merge-1-"));
    mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
    writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
    const historyDir = mkdtempSync(join(tmpdir(), "llm-merge-hist1-"));
    const wsA = makeFork(base, UPPER_ROOT, `fork-a-${process.pid}-${Date.now()}`, "FIX_A");
    const wsB = makeFork(base, UPPER_ROOT, `fork-b-${process.pid}-${Date.now()}`, "FIX_B");
    const green: GreenCluster[] = [
      { task: "task-a", branch_id: wsA.id, slides: ["slide_01"] },
      { task: "task-b", branch_id: wsB.id, slides: ["slide_02"] },
    ];
    // retest clean: only the intended slides changed → no ripple.
    const ops = makeOps([["slide_01", "slide_02"]], historyDir);
    try {
      const { report, threw } = await runMerge({ base, green, ops, upperRoot: UPPER_ROOT });
      assert.equal(threw, null, "merge should not throw");
      assert.equal(report!.mode, "all-at-once", "mode is all-at-once");
      assert.deepEqual(report!.accepted.sort(), ["task-a", "task-b"], "both accepted");
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged), "promoted base has fork A's edit");
      assert.ok(/FIX_B/.test(merged), "promoted base has fork B's edit");
      assert.equal(ops.demoteCalls.length, 0, "no demotes on the clean path");
    } finally {
      wsA.cleanup(); wsB.cleanup();
      rmSync(base, { recursive: true, force: true });
      rmSync(historyDir, { recursive: true, force: true });
    }
  });

  // ── (2)+(3) ALL-AT-ONCE ripple → SEQUENTIAL fallback + target mutation ────
  await test("(2)+(3) ripple → sequential keeps clean fork, demotes rippler; fork B prompt has fork A's fold", async () => {
    const base = mkdtempSync(join(tmpdir(), "llm-merge-2-"));
    mkdirSync(join(base, "renderer/html2slides"), { recursive: true });
    writeFileSync(join(base, CONVERTER_REL), BASE_FILE);
    const historyDir = mkdtempSync(join(tmpdir(), "llm-merge-hist2-"));
    const wsA = makeFork(base, UPPER_ROOT, `seq-a-${process.pid}-${Date.now()}`, "FIX_A");
    const wsB = makeFork(base, UPPER_ROOT, `seq-b-${process.pid}-${Date.now()}`, "FIX_B");
    const green: GreenCluster[] = [
      { task: "task-a", branch_id: wsA.id, slides: ["slide_01"] },
      { task: "task-b", branch_id: wsB.id, slides: ["slide_02"] },
    ];
    // retest queue:
    //   call 1 (all-at-once)     → ripple (slide_99 not intended) → fallback
    //   call 2 (seq after fork A) → clean  → keep A
    //   call 3 (seq after fork B) → ripple → rollback B + demote
    const ops = makeOps([
      ["slide_01", "slide_02", "slide_99"],
      ["slide_01"],
      ["slide_02", "slide_99"],
    ], historyDir);
    try {
      const { report, prompts, threw } = await runMerge({ base, green, ops, upperRoot: UPPER_ROOT });
      assert.equal(threw, null, "merge should not throw");
      assert.equal(report!.mode, "sequential", "fell back to sequential");
      assert.deepEqual(report!.accepted, ["task-a"], "only fork A kept");
      assert.deepEqual(report!.rejected.map((r) => r.task), ["task-b"], "fork B rejected");

      // Promoted base has ONLY fork A's edit (B rolled back).
      const merged = readFileSync(join(base, CONVERTER_REL), "utf8");
      assert.ok(/FIX_A/.test(merged), "kept fork A's edit");
      assert.ok(!/FIX_B/.test(merged), "did NOT keep fork B's rippling edit");

      // demote called for fork B; real ledger flipped its slide to bad.
      assert.equal(ops.demoteCalls.length, 1, "exactly one demote (fork B)");
      assert.deepEqual(ops.demoteCalls[0].slides, ["slide_02"], "demoted fork B's slide");
      const cand = JSON.parse(readFileSync(join(historyDir, "candidates.json"), "utf8"));
      assert.equal(cand["slide_02"].status, "bad", "ledger: slide_02 demoted to bad");

      // (3) SERIAL target-mutation: sends are [all-at-once, seq-forkA, seq-forkB].
      assert.equal(prompts.length, 3, "one all-at-once + two sequential sends");
      const forkAprompt = prompts[1];
      const forkBprompt = prompts[2];
      const forkAbase = fencedBlocks(forkAprompt)[0];
      const forkBbase = fencedBlocks(forkBprompt)[0];
      assert.ok(!/FIX_A/.test(forkAbase), "fork A folds against the PRISTINE base (no FIX_A yet)");
      assert.ok(/FIX_A/.test(forkBbase), "fork B's Base version already carries fork A's folded change (target mutated)");
    } finally {
      wsA.cleanup(); wsB.cleanup();
      rmSync(base, { recursive: true, force: true });
      rmSync(historyDir, { recursive: true, force: true });
    }
  });

  // ── (4) SHARED-DIR marker readable from OUTSIDE the overlay ────────────────
  await test("(4) shared-dir marker written inside a workspace is readable from outside", async () => {
    const base = mkdtempSync(join(tmpdir(), "llm-merge-4-"));
    const runId = `run-${Date.now()}`;
    const sharedDir = `/overlays/shared/${runId}/task-x`;
    const marker = `${sharedDir}/rating-outcome.json`;
    try { rmSync(`/overlays/shared/${runId}`, { recursive: true, force: true }); } catch { /* */ }
    const ws = createCowWorkspace({ base, upperRoot: UPPER_ROOT, id: `marker-${process.pid}-${Date.now()}` });
    try {
      // A command run INSIDE the workspace writes the marker to the absolute
      // /overlays/shared path (exactly what wait-for-ratings.ts does).
      const payload = JSON.stringify({ task_id: "task-x", green: true, rated: true, good: ["slide_01"], bad: [], unrated: [], slides: ["slide_01"] });
      const r = ws.runShell(`mkdir -p '${sharedDir}' && printf '%s' '${payload}' > '${marker}'`);
      assert.equal(r.code, 0, `marker write inside workspace failed: ${r.stderr}`);
      // Readable from OUTSIDE the overlay.
      assert.ok(existsSync(marker), "marker visible outside the workspace overlay");
      const outcome = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(outcome.green, true, "marker content readable + correct outside");
    } finally {
      ws.cleanup();
      rmSync(base, { recursive: true, force: true });
      try { rmSync(`/overlays/shared/${runId}`, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  // ── No /overlays leaks: every workspace (forks + merge + marker) is gone ────
  await test("(5) no /overlays leaks after cleanup", async () => {
    const leftover = existsSync(UPPER_ROOT) ? readdirSync(UPPER_ROOT) : [];
    assert.deepEqual(leftover, [], `UPPER_ROOT should be empty, found: ${JSON.stringify(leftover)}`);
  });

  try { rmSync(UPPER_ROOT, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
