/**
 * Behavioral tests for the "restart node with a message under the SAME
 * session" feature (POST /api/inject + graph.resetSubtree).
 *
 * Two properties under test, both required by the user ask:
 *
 *   (a) resetSubtree ERASES completed state — the node + every transitive
 *       successor go back to "pending" with cleared output/error, while a
 *       sibling that is NOT a successor is left untouched. Returned id list
 *       == [node + successors] (order-insensitive).
 *
 *   (b) /api/inject is NO-FORK — driving handleInject through a MockIO, the
 *       spawned claude args contain "--resume <sid>" and DO NOT contain
 *       "--fork-session" (contrast the /api/ask path, which DOES fork). The
 *       full arg list is asserted, mirroring session.test.ts's style.
 *
 * Run:
 *   npx tsx src/server/inject.test.ts
 */
import { strict as assert } from "node:assert";
import { ComputationGraph } from "./graph.js";
import { MockIO, type EffectCall, type Matcher, type SpawnCaptureArgs, type SpawnCaptureResult } from "./io.js";
import { handleInject } from "./server.js";

// ---------------------------------------------------------------------------
// Harness (mirrors session.test.ts)
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
    console.log(`      ${msg.split("\n").slice(0, 8).join("\n      ")}`);
  }
}

/** A realistic `claude -p --output-format json` reply frame for the mock. */
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

function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
  ];
}

function spawns(io: MockIO): SpawnCaptureArgs[] {
  return io.callsOf("spawnCapture").map((c) => c.args[0] as SpawnCaptureArgs);
}

/**
 * Build root → A → B → C (a linear successor chain via predecessor edges)
 * plus a sibling D hanging off root that is NOT a successor of A. Every
 * node is finished "ok" with a sentinel output so a reset is observable.
 * create() auto-wires a predecessor edge from parentId, which is exactly
 * the reverse-index resetSubtree walks.
 */
function buildChainGraph() {
  const g = new ComputationGraph("root");
  const root = g.get(g.rootId)!;
  const A = g.create({ parentId: root.id, kind: "send", label: "A", input: { prompt: "a" } });
  const B = g.create({ parentId: A.id, kind: "send", label: "B", input: { prompt: "b" } });
  const C = g.create({ parentId: B.id, kind: "send", label: "C", input: { prompt: "c" } });
  const D = g.create({ parentId: root.id, kind: "send", label: "D", input: { prompt: "d" } });
  for (const n of [A, B, C, D]) {
    g.finishOk(n.id, { text: "done-" + n.label }, { sessionId: "sid-" + n.label });
  }
  return { g, A, B, C, D };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  // eslint-disable-next-line no-console
  console.log("Inject (restart-with-message, same-session) tests\n");

  // (a) resetSubtree erases completed state of node + successors, leaves siblings alone.
  await test("resetSubtree erases the node + all transitive successors and leaves a non-successor sibling untouched", () => {
    const { g, A, B, C, D } = buildChainGraph();
    // Precondition: all four are ok.
    for (const n of [A, B, C, D]) assert.equal(g.get(n.id)!.status, "ok");

    const resetIds = g.resetSubtree(A.id);

    // A, B, C reset to pending with cleared output/error/timestamps.
    for (const n of [A, B, C]) {
      const node = g.get(n.id)!;
      assert.equal(node.status, "pending", `${n.label} should be pending`);
      assert.equal(node.output, null, `${n.label} output should be cleared`);
      assert.equal(node.error, null, `${n.label} error should be cleared`);
      assert.equal(node.finishedAt, null, `${n.label} finishedAt should be cleared`);
    }
    // D is NOT a successor of A → untouched, still ok with its output.
    const d = g.get(D.id)!;
    assert.equal(d.status, "ok", "sibling D must stay ok");
    assert.deepEqual(d.output, { text: "done-D" }, "sibling D output must survive");

    // Returned ids are exactly {A,B,C}, order-insensitive.
    assert.deepEqual([...resetIds].sort(), [A.id, B.id, C.id].sort());
  });

  // (b) /api/inject is NO-FORK: --resume present, --fork-session absent. Full arg list asserted.
  await test("handleInject resumes the same session WITHOUT --fork-session (full arg list), and erases node + successors", async () => {
    const { g, A, B, C } = buildChainGraph();
    const io = new MockIO({
      matchers: [
        ...baseMatchers(),
        {
          name: "claude inject reply",
          when: (c) => c.method === "spawnCapture",
          returns: claudeReply({ result: "post-inject", sessionId: "sid-A-next" }),
        },
      ],
    });

    const reply = await handleInject(
      JSON.stringify({ nodeId: A.id, message: "please redo with extra context" }),
      g,
      io,
    );

    // Exactly one claude spawn. Assert the COMPLETE arg list (command +
    // every flag, in order) — no count-only checks. --resume <A's session>
    // is present and --fork-session is absent (the no-fork contract).
    const list = spawns(io);
    assert.equal(list.length, 1, `expected exactly one spawn, got ${list.length}`);
    assert.equal(list[0]!.command, "claude");
    assert.equal(list[0]!.cwd, undefined);
    assert.equal(list[0]!.timeoutMs, 60 * 60 * 1000);
    assert.deepEqual(list[0]!.args, [
      "-p", "please redo with extra context",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--resume", "sid-A",
    ]);
    // Belt-and-suspenders: the fork flag must NOT appear anywhere.
    assert.ok(!list[0]!.args.includes("--fork-session"), "inject must NOT fork the session");

    // The endpoint reset A + its successors B, C (order-insensitive).
    assert.deepEqual([...reply.resetNodeIds].sort(), [A.id, B.id, C.id].sort());
    // A was re-run in place and finished ok with the new reply + the new session id.
    const a = g.get(A.id)!;
    assert.equal(a.status, "ok");
    assert.equal((a.output as { text?: string }).text, "post-inject");
    assert.equal((a.output as { appliedForkFlag?: boolean }).appliedForkFlag, false);
    assert.equal((a.output as { injected?: boolean }).injected, true);
    assert.equal(a.sessionId, "sid-A-next");
    // Successors B, C remain pending (erased, awaiting the scheduler's next pass).
    assert.equal(g.get(B.id)!.status, "pending");
    assert.equal(g.get(C.id)!.status, "pending");

    assert.equal(reply.isError, false);
    assert.equal(reply.text, "post-inject");
    assert.equal(reply.sessionId, "sid-A-next");
    io.assertExhaustive();
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
