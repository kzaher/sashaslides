/**
 * merge-phase.test.ts — unit tests for the FINAL MERGE PHASE graph
 * (merge-phase.ts), with the LLM MOCKED and every render/diff/tsc/git side-effect
 * STUBBED via a fake MergeOps. No Chrome, no Google, no git.
 *
 * The engine is driven through the REAL ClaudeEngine + claudeDriver, but with a
 * MockIO so:
 *   - `send` nodes (the conflict resolver) get CANNED `claude` replies, and we
 *     can inspect the exact prompt the model saw (proving the LLM is genuinely
 *     the merge resolver, mocked).
 *   - `executeShell` echo nodes get a trivial `bash` reply.
 * All merge side-effects (compose, render+diff, promote, revert, capture, tsc)
 * are the fake MergeOps' methods — scripted per test.
 *
 * Behaviors asserted:
 *   (a) No-conflict, no-ripple cluster → accepted, NO agent send fired,
 *       non-accepted slides asserted pixel-perfect (empty ripple passes).
 *   (b) Conflict → resolver send FIRES, mock returns RESOLVED + a clean file,
 *       markers-gone assert passes, cluster accepted; send saw the conflict ctx.
 *   (c) Agent FAILS to resolve (mock returns FAILED / leaves markers) → cluster
 *       reverted/rejected, accepted state unchanged.
 *   (d) Ripple regression (a non-accepted slide changed in the mocked diff) →
 *       retest assert throws → cluster reverted, recorded rejected-for-ripple.
 *   (e) The report captures accepted slides' screenshot path + XML.
 *
 * Run:  cd /workspaces/sashaslides && npx tsx renderer/structured-prompts/bug_solving/merge-phase.test.ts
 */
import { strict as assert } from "node:assert";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import {
  MockIO,
  type EffectCall,
  type Matcher,
  type SpawnCaptureArgs,
  type SpawnCaptureResult,
} from "../../../structured-prompting/src/server/io.js";
import {
  mergePhase,
  buildResolvePrompt,
  type MergeOps,
  type MergeCluster,
  type MergeReport,
  type ComposeResult,
  type PerSlideCapture,
} from "./merge-phase.js";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 8).join("\n      ")}`); }
}

// ---------------------------------------------------------------------------
// MockIO reply builders (mirror scheduler.test.ts / session.test.ts)
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

/** Base matchers shared by every test: clock, log, the echo `bash` nodes, and
 *  the engine's per-node `git` diff-capture spawns (ignored). */
function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
    { name: "bash-echo", when: isBash, returns: bashReply(""), optional: true },
    {
      name: "git-diff-capture",
      when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "git",
      returns: bashReply(""), optional: true,
    },
    // writeFileSync / rmSync / mkdtempSync are not used by these tests' fakes,
    // but the engine's diff-capture may touch them — allow + ignore.
    { name: "writeFileSync", when: (c) => c.method === "writeFileSync", returns: undefined, optional: true },
    { name: "rmSync", when: (c) => c.method === "rmSync", returns: undefined, optional: true },
    { name: "mkdtempSync", when: (c) => c.method === "mkdtempSync", returns: "/tmp/mock-merge-XXXX", optional: true },
  ];
}

/** Run mergePhase against a MockIO + fake ops. Returns the report + the IO log. */
async function runPhase(opts: {
  clusters: MergeCluster[];
  ops: MergeOps;
  claudeMatchers: Matcher[];
  scratchRoot: string;
}): Promise<{ report: MergeReport | undefined; io: MockIO; threw: unknown }> {
  const io = new MockIO({ matchers: [...baseMatchers(), ...opts.claudeMatchers] });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  let report: MergeReport | undefined;
  let threw: unknown = null;
  try {
    report = await engine.execute(
      new Session({ sessionId: "merge-test", cwd: "/repo" }),
      (s) => mergePhase(s, {
        clusters: opts.clusters,
        base: "BASE",
        staging: "/repo/.staging",
        fixturesDir: "/repo/fixtures",
        resolveModel: "opus",
        ops: opts.ops,
        scratchRoot: opts.scratchRoot,
      }),
    );
  } catch (e) { threw = e; }
  finally { await engine.shutdown(); }
  return { report, io, threw };
}

// ---------------------------------------------------------------------------
// A scriptable fake MergeOps. Each test wires the behaviors it needs.
// ---------------------------------------------------------------------------
interface FakeOpsScript {
  /** per-cluster compose result (keyed by task). Default: clean, no conflict. */
  compose?: Record<string, Partial<ComposeResult>>;
  /** per-cluster changed-slide set the retest diff should report (keyed by task).
   *  Default: the cluster's own slides (⇒ no ripple). */
  changed?: Record<string, string[]>;
  /** staging file contents the markers-gone assert reads (keyed by relPath). */
  stagingFiles?: Record<string, string>;
  /** converter tsc error count (default 0). */
  tscErrors?: number;
}
/** A fake ledger the fake ops writes on demoteForResolve. Mirrors the real
 *  candidates.json/ratings.json stores: `candidates[sid].status === "bad"` is
 *  what the NEXT clustering round treats as a loss (re-solvable). */
interface FakeLedger {
  candidates: Record<string, { status?: string; mergeFailed?: boolean; mergeFailedCluster?: string; mergeFailedReason?: string }>;
  ratings: Record<string, { comment?: string; mergeFailed?: boolean; mergeFailedCluster?: string; mergeFailedReason?: string }>;
}
interface FakeOps extends MergeOps {
  log: string[];
  promoted: string[];
  reverted: string[];
  demoteCalls: Array<{ slides: string[]; cluster: string; reason: string }>;
  ledger: FakeLedger;
  /** when set, demoteForResolve throws — proves a demote failure can't crash the phase. */
  demoteThrows?: boolean;
}
function makeFakeOps(cluster: MergeCluster[], script: FakeOpsScript = {}): FakeOps {
  const log: string[] = [];
  const promoted: string[] = [];
  const reverted: string[] = [];
  const demoteCalls: Array<{ slides: string[]; cluster: string; reason: string }> = [];
  const ledger: FakeLedger = { candidates: {}, ratings: {} };
  const stagingFiles: Record<string, string> = { ...(script.stagingFiles ?? {}) };
  const ops: FakeOps = {
    log, promoted, reverted, demoteCalls, ledger,
    compose(c) {
      log.push(`compose:${c.task}`);
      const over = script.compose?.[c.task] ?? {};
      const res: ComposeResult = {
        conflict: over.conflict ?? false,
        conflictFiles: over.conflictFiles ?? [],
        markedFiles: over.markedFiles ?? [],
        preMergeRef: `pre-${c.task}`,
      };
      return res;
    },
    revert(ref) { log.push(`revert:${ref}`); reverted.push(ref); },
    promote(c) { log.push(`promote:${c.task}`); promoted.push(c.task); },
    tscConverterErrors() { return script.tscErrors ?? 0; },
    renderAndDiff(baselineDir, outDir) {
      if (baselineDir === null) { log.push(`render-baseline:${outDir}`); return []; }
      // outDir encodes the cluster task (post-<task>).
      const task = outDir.split("post-")[1] ?? "";
      log.push(`retest:${task}`);
      return script.changed?.[task] ?? (cluster.find((c) => c.task === task)?.slides ?? []);
    },
    captureSlide(sid) {
      const cap: PerSlideCapture = { screenshotPath: `/thumbs/${sid}.png`, xml: `<xml slide="${sid}"/>` };
      return cap;
    },
    readStagingFile(rel) { return stagingFiles[rel] ?? null; },
    demoteForResolve(slides, clusterTask, reason) {
      log.push(`demote:${clusterTask}:[${slides.join(",")}]`);
      demoteCalls.push({ slides: [...slides], cluster: clusterTask, reason });
      if (ops.demoteThrows) throw new Error(`fake demote failure for ${clusterTask}`);
      // Mirror realMergeOps: flip candidates status to `bad` (the loss gate) +
      // annotate ratings, idempotently.
      for (const sid of slides) {
        const prevC = ledger.candidates[sid] ?? {};
        ledger.candidates[sid] = { ...prevC, status: "bad", mergeFailed: true, mergeFailedCluster: clusterTask, mergeFailedReason: reason };
        const prevR = ledger.ratings[sid] ?? {};
        ledger.ratings[sid] = { ...prevR, mergeFailed: true, mergeFailedCluster: clusterTask, mergeFailedReason: reason };
      }
    },
  };
  return ops;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nmerge-phase graph tests (mocked LLM + stubbed renders)\n");

  const C = (task: string, slides: string[]): MergeCluster => ({ task, dir: `/wt/${task}`, slides });

  // (a) No-conflict, no-ripple → accepted, NO agent send, pixel-perfect passes.
  await test("(a) no-conflict, no-ripple cluster → accepted, NO resolver send fired", async () => {
    const clusters = [C("clip", ["slide_04"])];
    const ops = makeFakeOps(clusters, { changed: { clip: ["slide_04"] } }); // only its own slide changed
    const { report, io, threw } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-a",
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("SHOULD-NOT-FIRE"), optional: true }],
    });
    assert.equal(threw, null, "phase should not throw");
    assert.deepEqual(report!.accepted, ["clip"], "clip accepted");
    assert.equal(report!.rejected.length, 0, "no rejects");
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 0, "the resolver LLM must NOT be invoked with no conflict");
    assert.deepEqual(ops.promoted, ["clip"], "clip promoted");
    assert.equal(ops.reverted.length, 0, "nothing reverted");
    // (a) clean accept → demoteForResolve NOT called; ledger untouched.
    assert.equal(ops.demoteCalls.length, 0, "demoteForResolve NOT called on a clean accept");
    assert.equal(Object.keys(ops.ledger.candidates).length, 0, "no slide demoted in the ledger");
  });

  // (b) Conflict → resolver send FIRES, RESOLVED + clean file → accepted.
  await test("(b) conflict → resolver send FIRES with conflict context, RESOLVED → accepted", async () => {
    const clusters = [C("shadow", ["slide_07"])];
    const conflictFile = "renderer/html2slides/convert-pptx-lib.ts";
    const ops = makeFakeOps(clusters, {
      compose: { shadow: { conflict: true, conflictFiles: [conflictFile], markedFiles: [{ path: conflictFile, markedContents: "<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n" }] } },
      // after the agent "resolves", the staging file is clean (no markers).
      stagingFiles: { [conflictFile]: "A\nB\n" },
      changed: { shadow: ["slide_07"] }, // no ripple
    });
    let sentPrompt = "";
    const { report, io, threw } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-b",
      claudeMatchers: [{
        name: "resolver-RESOLVED",
        when: isClaude,
        returns: (c: EffectCall) => {
          // capture the prompt the model saw — `claude -p <prompt> …`, so the
          // prompt is the CLI arg immediately after `-p`.
          const a = c.args[0] as SpawnCaptureArgs;
          const pi = a.args.indexOf("-p");
          sentPrompt = pi >= 0 ? (a.args[pi + 1] ?? "") : "";
          return claudeReply("RESOLVED");
        },
      }],
    });
    assert.equal(threw, null, "phase should not throw");
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 1, "resolver LLM invoked exactly once");
    assert.ok(sentPrompt.includes(conflictFile), "prompt names the conflicted file");
    assert.ok(sentPrompt.includes("<<<<<<<"), "prompt carries the conflict markers (both sides)");
    assert.ok(/preserve BOTH sides/i.test(sentPrompt), "prompt instructs preserve-both-sides");
    assert.deepEqual(report!.accepted, ["shadow"], "shadow accepted after resolve");
    assert.equal(report!.conflicts.length, 1, "one conflict recorded");
    assert.equal(report!.conflicts[0].resolved, true, "conflict marked resolved");
    assert.deepEqual(ops.promoted, ["shadow"], "shadow promoted");
  });

  // (c) Agent FAILS (markers remain) → cluster reverted/rejected, state unchanged.
  await test("(c) resolver FAILS (markers remain) → cluster reverted + rejected", async () => {
    const clusters = [C("border", ["slide_02"])];
    const conflictFile = "renderer/html2slides/convert-pptx-io.ts";
    const ops = makeFakeOps(clusters, {
      compose: { border: { conflict: true, conflictFiles: [conflictFile], markedFiles: [{ path: conflictFile, markedContents: "<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\n" }] } },
      // staging file STILL has markers → markers-gone assert fails.
      stagingFiles: { [conflictFile]: "<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\n" },
    });
    const { report, io, threw } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-c",
      claudeMatchers: [{ name: "resolver-FAILED", when: isClaude, returns: claudeReply("FAILED: cannot merge") }],
    });
    assert.equal(threw, null, "phase should not throw (reject is controlled)");
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 1, "resolver LLM was invoked");
    assert.deepEqual(report!.accepted, [], "nothing accepted");
    assert.equal(report!.rejected.length, 1, "one reject");
    assert.equal(report!.rejected[0].task, "border", "border rejected");
    assert.ok(/FAILED|marker/i.test(report!.rejected[0].reason), "reject reason cites the failure");
    assert.equal(ops.promoted.length, 0, "nothing promoted");
    assert.deepEqual(ops.reverted, ["pre-border"], "reverted to border's pre-merge ref");
    assert.equal(report!.conflicts[0].resolved, false, "conflict recorded UNresolved");
    // (c) FEEDBACK: the cluster's slides are DEMOTED for re-solve (in ADDITION
    // to the revert), with a conflict reason, and the fake ledger now marks them
    // as re-solvable losses (candidates status = bad).
    assert.equal(ops.demoteCalls.length, 1, "demoteForResolve called exactly once");
    assert.deepEqual(ops.demoteCalls[0].slides, ["slide_02"], "demoted the cluster's slides");
    assert.equal(ops.demoteCalls[0].cluster, "border", "demoted for the border cluster");
    assert.ok(/FAILED|marker|conflict/i.test(ops.demoteCalls[0].reason), "demote reason cites the conflict failure");
    assert.equal(ops.ledger.candidates["slide_02"]?.status, "bad", "ledger marks slide_02 as a loss (bad) for the next round");
    assert.equal(ops.ledger.candidates["slide_02"]?.mergeFailed, true, "ledger records mergeFailed");
    assert.deepEqual(report!.rejected[0].demotedSlides, ["slide_02"], "report records the demoted slides");
  });

  // (d) Ripple regression → retest assert throws → reverted, rejected-for-ripple.
  await test("(d) ripple regression (non-accepted slide changed) → reverted + rejected-for-ripple", async () => {
    const clusters = [C("gradient", ["slide_05"])];
    const ops = makeFakeOps(clusters, {
      // the diff reports the cluster's own slide AND a rippled non-target slide.
      changed: { gradient: ["slide_05", "slide_21"] },
    });
    const { report, threw, io } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-d",
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("x"), optional: true }],
    });
    assert.equal(threw, null, "phase should not throw");
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 0, "no conflict ⇒ no resolver send");
    assert.deepEqual(report!.accepted, [], "nothing accepted (rippled)");
    assert.equal(report!.rejected.length, 1, "one reject");
    assert.equal(report!.rejected[0].task, "gradient");
    assert.ok(/slide_21/.test(report!.rejected[0].reason), "reject reason names the rippled slide");
    assert.ok(/pixel-perfect|ripple/i.test(report!.rejected[0].reason), "reject reason cites pixel-perfect/ripple");
    assert.deepEqual(ops.reverted, ["pre-gradient"], "reverted to pre-merge");
    assert.equal(ops.promoted.length, 0, "nothing promoted");
    // (d) FEEDBACK: ripple-reverted cluster is DEMOTED for re-solve with a ripple
    // reason; ledger marks its slides as losses.
    assert.equal(ops.demoteCalls.length, 1, "demoteForResolve called once on ripple revert");
    assert.deepEqual(ops.demoteCalls[0].slides, ["slide_05"], "demoted the cluster's targeted slides");
    assert.ok(/ripple|pixel-perfect|slide_21/i.test(ops.demoteCalls[0].reason), "demote reason cites the ripple regression");
    assert.equal(ops.ledger.candidates["slide_05"]?.status, "bad", "ledger marks slide_05 as a loss for the next round");
    assert.deepEqual(report!.rejected[0].demotedSlides, ["slide_05"], "report records demoted slides");
  });

  // (e) Report captures accepted slides' screenshot path + XML.
  await test("(e) report captures accepted slides' screenshot path + pptx XML", async () => {
    const clusters = [C("text", ["slide_18", "slide_22"])];
    const ops = makeFakeOps(clusters, { changed: { text: ["slide_18", "slide_22"] } });
    const { report } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-e",
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("x"), optional: true }],
    });
    assert.deepEqual(report!.accepted, ["text"]);
    for (const sid of ["slide_18", "slide_22"]) {
      assert.ok(report!.perSlide[sid], `perSlide has ${sid}`);
      assert.equal(report!.perSlide[sid].screenshotPath, `/thumbs/${sid}.png`, `${sid} screenshot captured`);
      assert.equal(report!.perSlide[sid].xml, `<xml slide="${sid}"/>`, `${sid} XML captured`);
    }
  });

  // Bonus: sequential fold — an accepted cluster then a rejected one; order +
  // independence of accepted state.
  await test("(f) sequential fold: cluster0 accepted, cluster1 (ripple) rejected — order preserved, accept untouched", async () => {
    const clusters = [C("good", ["slide_01"]), C("bad", ["slide_02"])];
    const ops = makeFakeOps(clusters, {
      changed: { good: ["slide_01"], bad: ["slide_02", "slide_99"] },
    });
    const { report } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-f",
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("x"), optional: true }],
    });
    assert.deepEqual(report!.accepted, ["good"], "only good accepted");
    assert.deepEqual(report!.rejected.map((r) => r.task), ["bad"], "bad rejected");
    assert.deepEqual(ops.promoted, ["good"], "only good promoted");
    assert.deepEqual(ops.reverted, ["pre-bad"], "bad reverted");
    // compose order is deterministic: good before bad.
    const composeOrder = ops.log.filter((l) => l.startsWith("compose:"));
    assert.deepEqual(composeOrder, ["compose:good", "compose:bad"], "clusters composed in array order");
  });

  // (h) idempotency: two rejected clusters demote independently, and re-demoting
  // the SAME slide is a no-op beyond the first (ledger stays a single loss entry).
  await test("(h) demoteForResolve is idempotent (re-demote same slide is a no-op)", async () => {
    const clusters = [C("dupA", ["slide_30"]), C("dupB", ["slide_30"])];
    // both clusters ripple → both rejected → both demote slide_30.
    const ops = makeFakeOps(clusters, {
      changed: { dupA: ["slide_30", "slide_88"], dupB: ["slide_30", "slide_88"] },
    });
    const { report, threw } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-h",
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("x"), optional: true }],
    });
    assert.equal(threw, null, "phase should not throw");
    assert.deepEqual(report!.rejected.map((r) => r.task), ["dupA", "dupB"], "both rejected");
    assert.equal(ops.demoteCalls.length, 2, "demote called once per rejected cluster");
    // The ledger holds ONE entry for slide_30 (idempotent write), last-writer's
    // cluster wins the annotation but status stays a single `bad`.
    assert.equal(ops.ledger.candidates["slide_30"]?.status, "bad", "slide_30 is a loss");
    assert.equal(Object.keys(ops.ledger.candidates).length, 1, "exactly one demoted slide in the ledger (no duplicate keys)");
  });

  // (i) a demote-op THROW must NOT crash the merge phase — the reject is still
  // controlled (reverted + recorded), only demotedSlides is empty.
  await test("(i) demoteForResolve throwing does NOT fail the phase", async () => {
    const clusters = [C("boom", ["slide_40"])];
    const ops = makeFakeOps(clusters, { changed: { boom: ["slide_40", "slide_77"] } }); // ripple → reject
    ops.demoteThrows = true;
    const { report, threw } = await runPhase({
      clusters, ops, scratchRoot: "/tmp/mp-i",
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("x"), optional: true }],
    });
    assert.equal(threw, null, "a demote throw must not crash the phase");
    assert.equal(report!.rejected.length, 1, "cluster still recorded rejected");
    assert.equal(report!.rejected[0].task, "boom");
    assert.deepEqual(report!.rejected[0].demotedSlides, [], "demotedSlides empty because the demote threw");
    assert.deepEqual(ops.reverted, ["pre-boom"], "the revert still happened");
  });

  // Bonus: buildResolvePrompt is a pure function carrying files + markers.
  await test("(g) buildResolvePrompt embeds file list + marker bodies (LLM sees the conflict)", async () => {
    const p = buildResolvePrompt(C("t", ["slide_10"]), [{ path: "renderer/html2slides/x.ts", markedContents: "<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs\n" }]);
    assert.ok(p.includes("renderer/html2slides/x.ts"), "names the file");
    assert.ok(p.includes("foo") && p.includes("bar"), "carries both sides' bodies");
    assert.ok(/RESOLVED/.test(p) && /FAILED/.test(p), "specifies the reply protocol");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed) { for (const f of failures) console.error(`FAIL ${f.name}: ${(f.err as Error)?.message ?? f.err}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
