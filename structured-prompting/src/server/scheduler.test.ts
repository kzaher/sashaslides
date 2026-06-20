/**
 * Behavioral tests for the graph-driven state-machine scheduler
 * (src/server/scheduler.ts), including RESTART-FROM-ANY-NODE.
 *
 * All tests run against a MockIO so no real `claude` / `bash` process
 * spawns. We assert observable graph state (node statuses + resolved
 * outputs) and, where it's load-bearing, the full spawn arg list.
 *
 * Coverage:
 *   1. Linear chain send A → executeShell B → send C runs end-to-end under
 *      the scheduler; values thread (B's command sees A's text; C's prompt
 *      sees B's stdout).
 *   2. RESTART-FROM-NODE: after the run, resetSubtree(B) + a fresh
 *      runScheduler re-fires B and C with NEW output while A is untouched.
 *   3. parallelFork fans out N children, each an independent send.
 *   4. assert failure turns the chain into an error (node-level, not throw).
 *
 * Run:
 *   npx tsx src/server/scheduler.test.ts
 */
import { strict as assert } from "node:assert";
import { ComputationGraph } from "./graph.js";
import { Session, SessionWithResult } from "./session.js";
import { MockIO, type EffectCall, type Matcher, type SpawnCaptureArgs, type SpawnCaptureResult } from "./io.js";
import { runScheduler, defaultKindRegistry } from "./scheduler.js";
import { claudeDriver } from "./claude-cli.js";
import { codexDriver } from "./codex-cli.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    // eslint-disable-next-line no-console
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    // eslint-disable-next-line no-console
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    const msg = (e as Error)?.message ?? String(e);
    // eslint-disable-next-line no-console
    console.log(`      ${msg.split("\n").slice(0, 10).join("\n      ")}`);
  }
}

/** A realistic `claude -p --output-format json` reply frame. */
function claudeReply(body: { isError?: boolean; result?: string; sessionId?: string }): SpawnCaptureResult {
  const payload = {
    type: "result",
    subtype: body.isError ? "error" : "success",
    is_error: body.isError ?? false,
    result: body.result ?? "",
    session_id: body.sessionId ?? "mock-sid",
    duration_ms: 1,
    total_cost_usd: 0,
  };
  return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}

/**
 * A realistic `codex exec --json` NDJSON event stream (the shape codex-cli.ts
 * parses): thread.started carries the session id; an item.completed
 * agent_message carries the final text; turn.completed carries usage.
 */
function codexReply(body: { text?: string; sessionId?: string }): SpawnCaptureResult {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: body.sessionId ?? "codex-thread" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: body.text ?? "" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ];
  return { stdout: lines.join("\n"), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}

/** A successful bash result. */
function bashReply(stdout: string): SpawnCaptureResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}

function isClaude(c: EffectCall): boolean {
  return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "claude";
}
function isCodex(c: EffectCall): boolean {
  return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "codex";
}
function isBash(c: EffectCall): boolean {
  return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash";
}

function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
  ];
}

function spawnsOf(io: MockIO, pred: (c: EffectCall) => boolean): SpawnCaptureArgs[] {
  return io.calls.filter(pred).map((c) => c.args[0] as SpawnCaptureArgs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  // eslint-disable-next-line no-console
  console.log("Scheduler (state-machine engine + restart-from-node) tests\n");

  // 1 + 2. Linear chain runs, then restart-from-node re-fires B + C.
  await test("send A → executeShell B → send C runs end-to-end under the scheduler, and resetSubtree(B) re-fires B+C with fresh output (A untouched)", async () => {
    // The claude matcher varies its reply by call index so we can observe
    // FRESH output on the restart. Bash echoes a marker including its index.
    const io = new MockIO({
      matchers: [
        ...baseMatchers(),
        {
          name: "claude",
          when: isClaude,
          returns: (_c: EffectCall, i: number) => claudeReply({ result: `claude-reply-${i}`, sessionId: `sid-${i}` }),
        },
        {
          name: "bash",
          when: isBash,
          returns: (_c: EffectCall, i: number) => bashReply(`bash-stdout-${i}`),
        },
      ],
    });

    // Build root → A(send) → B(executeShell, consumes A) → C(send, consumes B).
    const graph = new ComputationGraph("root");
    const root = new Session({ model: "haiku", cwd: "/wd", graph });
    const a = root.send({ prompt: "prompt-A" });
    const b = a.executeShell((upstream) => `echo using:${upstream}`);
    const c = b.send({ prompt: (upstream: unknown) => `prompt-C upstream=${upstream}` });

    const A = a.tipNodeId, B = b.tipNodeId, C = c.tipNodeId;

    const { registry, values } = defaultKindRegistry(io);
    await runScheduler(graph, registry, { io, values, seedCtx: { model: "haiku", cwd: "/wd" }, tickIntervalMs: 1 });

    // All three reached ok.
    assert.equal(graph.get(A)!.status, "ok", "A ok");
    assert.equal(graph.get(B)!.status, "ok", "B ok");
    assert.equal(graph.get(C)!.status, "ok", "C ok");

    // A's text = claude reply #0. B's command consumed A's text. C's prompt
    // consumed B's stdout.
    assert.equal((graph.get(A)!.output as { text?: string }).text, "claude-reply-0");
    const bSpawn0 = spawnsOf(io, isBash)[0]!;
    assert.deepEqual(bSpawn0.args, ["-c", "echo using:claude-reply-0"], "B command saw A's text");
    const cSpawn0 = spawnsOf(io, isClaude)[1]!; // second claude call is C
    assert.equal(cSpawn0.args[1], "prompt-C upstream=bash-stdout-0", "C prompt saw B's stdout");

    // Snapshot pre-restart outputs.
    const aTextBefore = (graph.get(A)!.output as { text: string }).text;
    const cTextBefore = (graph.get(C)!.output as { text: string }).text;

    // ----- RESTART FROM NODE B -----
    const resetIds = graph.resetSubtree(B);
    assert.deepEqual([...resetIds].sort(), [B, C].sort(), "resetSubtree(B) should reset exactly B + C");
    assert.equal(graph.get(B)!.status, "pending", "B reset to pending");
    assert.equal(graph.get(C)!.status, "pending", "C reset to pending");
    assert.equal(graph.get(A)!.status, "ok", "A untouched by reset");

    // Re-drive the scheduler with the SAME values map so B still sees A's value.
    await runScheduler(graph, registry, { io, values, seedCtx: { model: "haiku", cwd: "/wd" }, tickIntervalMs: 1 });

    // B + C re-fired to ok with FRESH output; A's output is unchanged.
    assert.equal(graph.get(B)!.status, "ok", "B re-fired to ok");
    assert.equal(graph.get(C)!.status, "ok", "C re-fired to ok");
    assert.equal((graph.get(A)!.output as { text: string }).text, aTextBefore, "A output unchanged");
    const cTextAfter = (graph.get(C)!.output as { text: string }).text;
    assert.notEqual(cTextAfter, cTextBefore, "C produced a FRESH reply on restart");

    // The restart re-ran B's command (still seeing A's text — A was NOT reset).
    const bSpawns = spawnsOf(io, isBash);
    assert.equal(bSpawns.length, 2, "B's command ran twice (original + restart)");
    assert.deepEqual(bSpawns[1]!.args, ["-c", "echo using:claude-reply-0"], "restart B command still saw A's text");
  });

  // 3. parallelFork fan-out.
  await test("parallelFork fans out N independent send children under the scheduler", async () => {
    const io = new MockIO({
      matchers: [
        ...baseMatchers(),
        { name: "claude", when: isClaude, returns: (c: EffectCall) => {
            const prompt = (c.args[0] as SpawnCaptureArgs).args[1];
            return claudeReply({ result: `reply<${prompt}>`, sessionId: "sid" });
          } },
      ],
    });

    const graph = new ComputationGraph("root");
    const root = new Session({ model: "haiku", cwd: "/wd", graph });
    const forked = root.parallelFork(["x", "y", "z"], (s: Session, input: unknown) =>
      s.send({ prompt: `child-${String(input)}` }),
    );
    const tip = forked.tipNodeId;

    const { registry, values } = defaultKindRegistry(io);
    await runScheduler(graph, registry, { io, values, seedCtx: { model: "haiku", cwd: "/wd" }, tickIntervalMs: 1 });

    assert.equal(graph.get(tip)!.status, "ok", "parallelFork node ok");
    // Three claude spawns, one per child input.
    const prompts = spawnsOf(io, isClaude).map((s) => s.args[1]).sort();
    assert.deepEqual(prompts, ["child-x", "child-y", "child-z"]);
    // The fork node's resolved value array (collected via the values map).
    assert.deepEqual(
      (values.get(tip) as string[]).sort(),
      ["reply<child-x>", "reply<child-y>", "reply<child-z>"].sort(),
    );
  });

  // 4. assert failure → node error (does not throw out of the pass).
  await test("a failing assert marks its node error without unwinding the scheduler", async () => {
    const io = new MockIO({
      matchers: [
        ...baseMatchers(),
        { name: "claude", when: isClaude, returns: claudeReply({ result: "hello", sessionId: "sid" }) },
      ],
    });

    const graph = new ComputationGraph("root");
    const root = new Session({ model: "haiku", cwd: "/wd", graph });
    const a = root.send({ prompt: "A" });
    const checked = (a as SessionWithResult<string>).assert((r) => {
      if (r !== "WRONG") throw new Error(`assert failed: got ${r}`);
    });
    const A = a.tipNodeId, CHK = checked.tipNodeId;

    const { registry, values } = defaultKindRegistry(io);
    await runScheduler(graph, registry, { io, values, seedCtx: { model: "haiku", cwd: "/wd" }, tickIntervalMs: 1 });

    assert.equal(graph.get(A)!.status, "ok", "send A ok");
    assert.equal(graph.get(CHK)!.status, "error", "assert node errored");
    assert.match((graph.get(CHK)!.error!.message), /assert failed/);
  });

  // 5. Driver routing: a CodexEngine-style scheduler run (driver = codexDriver)
  //    spawns `codex exec`, NOT `claude`. The mirror ClaudeEngine run stays
  //    codex-free. This is the regression guard for "scheduler routes through
  //    the injected ModelDriver" — before the fix the send handler hard-wired
  //    callClaude and a codex engine would still spawn claude.
  await test("a CodexEngine-style scheduler run spawns `codex exec` argv (not claude); the ClaudeEngine run stays codex-free", async () => {
    // --- codex driver: send "say hi" → executeShell → send "summarize" ------
    const codexIo = new MockIO({
      matchers: [
        ...baseMatchers(),
        { name: "codex", when: isCodex, returns: (_c: EffectCall, i: number) => codexReply({ text: `codex-reply-${i}`, sessionId: `codex-sid-${i}` }) },
        { name: "bash", when: isBash, returns: bashReply("shell-out") },
        // A claude matcher EXISTS so that if the handler wrongly spawned claude
        // the run would "succeed" — making the absence assertion meaningful
        // rather than an accidental spawn-error.
        { name: "claude", when: isClaude, returns: claudeReply({ result: "WRONG-claude", sessionId: "x" }) },
      ],
    });

    const codexGraph = new ComputationGraph("root");
    const codexRoot = new Session({ model: "haiku", cwd: "/wd", graph: codexGraph });
    const cx = codexRoot
      .send({ prompt: "say hi" })
      .executeShell(() => "echo step")
      .send({ prompt: "summarize" });
    const codexTip = cx.tipNodeId;

    // Pass codexDriver — exactly what `Engine(codexDriver).execute` does via
    // `defaultKindRegistry(this.io, this.driver)`.
    const { registry: codexReg, values: codexVals } = defaultKindRegistry(codexIo, codexDriver);
    await runScheduler(codexGraph, codexReg, { io: codexIo, values: codexVals, driver: codexDriver, seedCtx: { model: "haiku", cwd: "/wd" }, tickIntervalMs: 1 });

    assert.equal(codexGraph.get(codexTip)!.status, "ok", "codex chain reached ok");

    const codexSpawns = spawnsOf(codexIo, isCodex);
    assert.equal(codexSpawns.length, 2, "two codex spawns (the two sends), not zero");
    assert.equal(spawnsOf(codexIo, isClaude).length, 0, "NO claude spawn under the codex driver");

    // The first codex spawn is `codex exec … <prompt>` with the documented
    // headless flags; model "haiku" is a Claude token so codexModelArg drops
    // it → no --model. (Mirrors codex-cli.ts argv assembly.)
    const first = codexSpawns[0]!;
    assert.deepEqual(first.args, [
      "exec",
      "--json",
      "--cd", "/wd",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "say hi",
    ], "codex exec argv shape");
    assert.equal(first.args.includes("--model"), false, "claude-token model is dropped (no --model)");

    // --- claude driver on the SAME graph shape stays codex-free -------------
    const claudeIo = new MockIO({
      matchers: [
        ...baseMatchers(),
        { name: "claude", when: isClaude, returns: claudeReply({ result: "claude-ok", sessionId: "c" }) },
        { name: "bash", when: isBash, returns: bashReply("shell-out") },
        { name: "codex", when: isCodex, returns: codexReply({ text: "WRONG-codex", sessionId: "x" }) },
      ],
    });
    const claudeGraph = new ComputationGraph("root");
    const claudeRoot = new Session({ model: "haiku", cwd: "/wd", graph: claudeGraph });
    const cl = claudeRoot
      .send({ prompt: "say hi" })
      .executeShell(() => "echo step")
      .send({ prompt: "summarize" });
    const claudeTip = cl.tipNodeId;
    const { registry: claudeReg, values: claudeVals } = defaultKindRegistry(claudeIo, claudeDriver);
    await runScheduler(claudeGraph, claudeReg, { io: claudeIo, values: claudeVals, driver: claudeDriver, seedCtx: { model: "haiku", cwd: "/wd" }, tickIntervalMs: 1 });

    assert.equal(claudeGraph.get(claudeTip)!.status, "ok", "claude chain reached ok");
    assert.equal(spawnsOf(claudeIo, isClaude).length, 2, "two claude spawns under the claude driver");
    assert.equal(spawnsOf(claudeIo, isCodex).length, 0, "NO codex spawn under the claude driver");
  });

  // -- summary --------------------------------------------------------------
  // eslint-disable-next-line no-console
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.log(`\n— ${f.name} —`);
      // eslint-disable-next-line no-console
      console.log((f.error as Error)?.stack ?? f.error);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("TEST HARNESS CRASHED:", e);
  process.exit(1);
});
