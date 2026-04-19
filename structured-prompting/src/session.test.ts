/**
 * Co-located behavioral tests for the Session API + engine.
 *
 * Tests run against a MockIO so no real `claude` process spawns. Every test
 * asserts the *complete* list of spawn calls (command + every arg) — no
 * count-only checks, no filter-then-assert-length tricks. If a flag is added,
 * reordered, or dropped, the test fails with a precise diff.
 *
 * Run:
 *   npm test
 *   # or: npx tsx src/session.test.ts
 */

import { strict as assert } from "node:assert";
import {
  Claude,
  ClaudeEngine,
  InterruptException,
  MockIO,
  Session,
  type EffectCall,
  type Matcher,
  type SpawnCaptureArgs,
  type SpawnCaptureResult,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

/** Fixed cwd so tests are stable regardless of where they're run from. */
const TEST_CWD = "/test-cwd";
/** Default timeout the CLI wrapper uses when callers don't override. */
const DEFAULT_TIMEOUT = 300_000;
/**
 * Tail that `tryMultipleTimes` automatically appends to every attempt's prompt
 * (the engine's `InterruptException` escape hatch). Keep this in sync with
 * engine.ts — if that changes, this test constant must too.
 */
const INTERRUPT_TAIL =
  '\n\nIf you want to abandon this task, respond with a JSON object {"InterruptException": "<reason>"} and no other fields.';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Construct a realistic `claude -p --output-format json` reply for the mock spawn. */
function claudeReply(body: {
  isError?: boolean;
  result?: string;
  sessionId?: string;
  structuredOutput?: unknown;
}): SpawnCaptureResult {
  const payload = {
    type: "result",
    subtype: body.isError ? "error" : "success",
    is_error: body.isError ?? false,
    result: body.result ?? "",
    session_id: body.sessionId ?? "mock-sid",
    duration_ms: 1,
    total_cost_usd: 0,
    structured_output: body.structuredOutput,
  };
  return {
    stdout: JSON.stringify(payload),
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
  };
}

/** The always-present no-op matchers (clock + log). `now` returns monotonic ms. */
function baseMatchers(): Matcher[] {
  return [
    {
      name: "now",
      when: (c) => c.method === "now",
      returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i,
    },
    {
      name: "log",
      when: (c) => c.method === "log",
      returns: undefined,
      optional: true,
    },
  ];
}

/** Run a description against a MockIO and return engine state + IO log. */
async function runMock<R>(opts: {
  matchers: Matcher[];
  main: (s: Session) => ReturnType<Session["send"]> | any;
}) {
  const io = new MockIO({ matchers: [...baseMatchers(), ...opts.matchers] });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  let value: R | undefined;
  let threw: unknown = null;
  try {
    value = (await engine.execute(
      new Session({ sessionId: "t", cwd: TEST_CWD }),
      opts.main,
    )) as R;
  } catch (e) {
    threw = e;
  } finally {
    await engine.shutdown();
  }
  return { value, threw, io, graph: engine.currentGraph! };
}

/** Every spawnCapture call in order, as the raw SpawnCaptureArgs object. */
function spawns(io: MockIO): SpawnCaptureArgs[] {
  return io.callsOf("spawnCapture").map((c) => c.args[0] as SpawnCaptureArgs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  // eslint-disable-next-line no-console
  console.log("Session behavioral tests\n");

  // -- send (plain text) ----------------------------------------------------
  await test("send returns claude's `result` text and issues exactly one spawn", async () => {
    const alwaysPong: Matcher = {
      name: "pong",
      when: (c) => c.method === "spawnCapture",
      returns: claudeReply({ result: "pong" }),
    };
    const { value, io } = await runMock<string>({
      matchers: [alwaysPong],
      main: (s) => s.send({ prompt: "ping" }),
    });
    assert.equal(value, "pong");
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "ping",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("switchModel changes the --model flag on the next send", async () => {
    const { io } = await runMock({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "x" }) }],
      main: (s) => s.switchModel(Claude.opus).send({ prompt: "hello" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "hello",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("prependToNextPrompt + appendToNextPrompt produce a single composed prompt", async () => {
    const { io } = await runMock({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "x" }) }],
      main: (s) =>
        s.prependToNextPrompt("HEAD").appendToNextPrompt("TAIL").send({ prompt: "MID" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "HEAD\n\nMID\n\nTAIL",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("prepend buffer is consumed by one send and does NOT leak to the next", async () => {
    const { io } = await runMock({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "ok", sessionId: "sid-const" }) }],
      main: (s) =>
        s.prependToNextPrompt("X").send({ prompt: "A" }).send({ prompt: "B" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "X\n\nA",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "B",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--resume", "sid-const",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  // -- send with schema / structured output ---------------------------------
  await test("send({schema}) flattens typia's $ref, adds --json-schema, returns structured_output", async () => {
    const schemaUnit = {
      version: "3.1" as const,
      schema: { $ref: "#/components/schemas/Foo" },
      components: {
        schemas: {
          Foo: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        },
      },
    };
    // The engine flattens $ref → the referenced subschema.
    const expectedFlat = JSON.stringify({
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    });
    const { value, io } = await runMock<{ x: string }>({
      matchers: [
        {
          name: "schema reply",
          when: (c) => c.method === "spawnCapture",
          returns: claudeReply({ structuredOutput: { x: "ok" }, result: "Done." }),
        },
      ],
      main: (s) => s.send({ prompt: "go", schema: schemaUnit as any }),
    });
    assert.deepEqual(value, { x: "ok" });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "go",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--json-schema", expectedFlat,
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("send({schema}) errors when CLI replies with no structured_output", async () => {
    const { threw, io } = await runMock({
      matchers: [
        {
          name: "empty structured",
          when: (c) => c.method === "spawnCapture",
          returns: claudeReply({ result: "uh oh" }),
        },
      ],
      main: (s) => s.send({ prompt: "go", schema: { schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } } } as any }),
    });
    assert(threw instanceof Error);
    assert((threw as Error).message.includes("structured_output"));
    // Exactly one spawn — the error is raised without retrying.
    assert.equal(spawns(io).length, 1);
    assert.equal(spawns(io)[0]!.args[0], "-p");
    assert.equal(spawns(io)[0]!.args[1], "go");
    assert(spawns(io)[0]!.args.includes("--json-schema"));
  });

  // -- resume / fork / compact flags ----------------------------------------
  await test("second send in a chain issues --resume with the prior session_id", async () => {
    const { io } = await runMock({
      matchers: [
        {
          name: "sequential",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) =>
            claudeReply({ sessionId: i === 0 ? "sid-A" : "sid-B", result: `r${i}` }),
        },
      ],
      main: (s) => s.send({ prompt: "first" }).send({ prompt: "second" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "first",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "second",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--resume", "sid-A",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("fork before send adds --fork-session next to --resume", async () => {
    const { io } = await runMock({
      matchers: [
        {
          name: "sequential",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) =>
            claudeReply({ sessionId: `sid-${i}`, result: `r${i}` }),
        },
      ],
      main: (s) => s.send({ prompt: "seed" }).fork().send({ prompt: "after-fork" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "seed",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "after-fork",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--resume", "sid-0",
          "--fork-session",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("fork().compact() materializes as /compact + --fork-session before the user prompt", async () => {
    const { io } = await runMock({
      matchers: [
        {
          name: "sequential",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) =>
            claudeReply({ sessionId: `sid-${i}`, result: `r${i}` }),
        },
      ],
      main: (s) => s.send({ prompt: "seed" }).fork().compact().send({ prompt: "post-compact" }),
    });
    assert.deepEqual(spawns(io), [
      // 1) initial send, no session state yet
      {
        command: "claude",
        args: [
          "-p", "seed",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      // 2) /compact with --fork-session + --resume sid-0  (fork + compact folded)
      {
        command: "claude",
        args: [
          "-p", "/compact",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--resume", "sid-0",
          "--fork-session",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      // 3) the actual post-compact user prompt resumes the compacted session
      {
        command: "claude",
        args: [
          "-p", "post-compact",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--resume", "sid-1",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  // -- newSession -----------------------------------------------------------
  await test("newSession() drops --resume and keeps the inherited model", async () => {
    const { io } = await runMock({
      matchers: [
        {
          name: "sequential",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) =>
            claudeReply({ sessionId: `sid-${i}`, result: "ok" }),
        },
      ],
      main: (s) =>
        s.switchModel(Claude.haiku).send({ prompt: "a" }).newSession().send({ prompt: "b" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "a",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "haiku",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "b",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "haiku",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("newSession(model) drops --resume AND switches the model", async () => {
    const { io } = await runMock({
      matchers: [
        {
          name: "sequential",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) => claudeReply({ sessionId: `sid-${i}`, result: "ok" }),
        },
      ],
      main: (s) =>
        s.switchModel(Claude.haiku).send({ prompt: "a" }).newSession(Claude.opus).send({ prompt: "b" }),
    });
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "a",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "haiku",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "b",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  // -- tryMultipleTimes: retry semantics ------------------------------------
  await test("tryMultipleTimes: first attempt succeeds → exactly one spawn, prompt carries the auto-appended Interrupt tail", async () => {
    const { value, io } = await runMock<string>({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "first-try" }) }],
      main: (s) => s.tryMultipleTimes(3, (s2) => s2.send({ prompt: "ping" })),
    });
    assert.equal(value, "first-try");
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "ping" + INTERRUPT_TAIL,
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("tryMultipleTimes: fail,fail,ok → exactly three spawns, last one succeeds", async () => {
    const { value, io } = await runMock<string>({
      matchers: [
        {
          name: "fail-fail-ok",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) =>
            i < 2 ? claudeReply({ isError: true, result: "bad" }) : claudeReply({ result: "pong" }),
        },
      ],
      main: (s) => s.tryMultipleTimes(3, (s2) => s2.send({ prompt: "p" })),
    });
    assert.equal(value, "pong");
    const list = spawns(io);
    assert.equal(list.length, 3, `expected 3 spawns, got ${list.length}`);
    // Attempt 1: prompt is just "p" + the InterruptException tail.
    assert.equal(list[0]!.args[1], "p" + INTERRUPT_TAIL);
    // Attempts 2 and 3: prior-error prefix is prepended, original prompt and
    // tail remain in place.
    for (const i of [1, 2]) {
      const prompt = list[i]!.args[1]!;
      assert(prompt.startsWith("Previous attempt failed"),
        `attempt ${i + 1} must carry the prior-error prefix; got: ${prompt}`);
      assert(prompt.endsWith("p" + INTERRUPT_TAIL),
        `attempt ${i + 1} must still end with 'p' + Interrupt tail; got: ${prompt}`);
    }
  });

  await test("tryMultipleTimes honors max: all fail, default fallback rethrows after exactly `max` spawns", async () => {
    const { threw, io } = await runMock({
      matchers: [
        { name: "all fail", when: (c) => c.method === "spawnCapture", returns: claudeReply({ isError: true, result: "boom" }) },
      ],
      main: (s) => s.tryMultipleTimes(3, (s2) => s2.send({ prompt: "p" })),
    });
    assert(threw instanceof Error, "engine should throw when default fallback re-throws");
    assert.equal(spawns(io).length, 3, "must attempt exactly max=3 before giving up");
  });

  await test("tryMultipleTimes with custom fallback: fallback's result is returned after max attempts", async () => {
    const { value, io } = await runMock<unknown>({
      matchers: [
        { name: "all fail", when: (c) => c.method === "spawnCapture", returns: claudeReply({ isError: true, result: "boom" }) },
      ],
      main: (s) =>
        s.tryMultipleTimes(
          2,
          (s2) => s2.send({ prompt: "p" }),
          (s2) => s2.materializeError<string>("fell-back") as any,
        ),
    });
    assert.deepEqual(value, { error: "fell-back" });
    assert.equal(spawns(io).length, 2);
  });

  await test("tryMultipleTimes: InterruptException on attempt 1 short-circuits — only one spawn, fallback sees the error", async () => {
    const schemaUnit = {
      schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    };
    let fallbackErr: unknown = null;
    const { io } = await runMock({
      matchers: [
        {
          name: "interrupt",
          when: (c) => c.method === "spawnCapture",
          returns: claudeReply({ structuredOutput: { InterruptException: "give up" } }),
        },
      ],
      main: (s) =>
        s.tryMultipleTimes(
          5,
          (s2) => s2.send({ prompt: "p", schema: schemaUnit as any }) as any,
          (s2, e) => { fallbackErr = e; return s2.materializeError<unknown>("recovered") as any; },
        ),
    });
    assert(fallbackErr instanceof InterruptException, "fallback should receive InterruptException");
    assert.equal(spawns(io).length, 1, "InterruptException must skip remaining retries");
  });

  // -- combineWith ----------------------------------------------------------
  await test("combineWith: execution runs, combine() receives both real values", async () => {
    const { value, io } = await runMock<string>({
      matchers: [
        {
          name: "two sends",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) => claudeReply({ sessionId: `sid-${i}`, result: i === 0 ? "A" : "B" }),
        },
      ],
      main: (s) =>
        s
          .send({ prompt: "left" })
          .combineWith(
            (branch) => branch.send({ prompt: "right" }),
            (l, r) => `${l}+${r}`,
          ),
    });
    assert.equal(value, "A+B");
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "left",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "right",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
          "--resume", "sid-0",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
  });

  await test("combineWith: combine() throwing fails the combineWith node", async () => {
    const { threw } = await runMock({
      matchers: [
        { name: "sends", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "x" }) },
      ],
      main: (s) =>
        s.send({ prompt: "p" }).combineWith(
          (b) => b.send({ prompt: "q" }),
          () => { throw new Error("combine-boom"); },
        ),
    });
    assert(threw instanceof Error);
    assert((threw as Error).message.includes("combine-boom"));
  });

  // -- try ------------------------------------------------------------------
  await test("try: success path skips fallback entirely — exactly one spawn", async () => {
    let fallbackCalled = false;
    const { value, io } = await runMock<string>({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "happy" }) }],
      main: (s) =>
        s.try<string>(
          (s2) => s2.send({ prompt: "p" }),
          (s2) => { fallbackCalled = true; return s2.send({ prompt: "fallback" }); },
        ),
    });
    assert.equal(value, "happy");
    assert.equal(fallbackCalled, false);
    assert.equal(spawns(io).length, 1);
  });

  await test("try: error path invokes fallback with the error; fallback's send is the only second spawn", async () => {
    let receivedError: unknown = null;
    const { value, io } = await runMock<string>({
      matchers: [
        {
          name: "first fails, fallback ok",
          when: (c) => c.method === "spawnCapture",
          returns: (_c: EffectCall, i: number) =>
            i === 0 ? claudeReply({ isError: true, result: "bad" }) : claudeReply({ result: "recovered" }),
        },
      ],
      main: (s) =>
        s.try<string>(
          (s2) => s2.send({ prompt: "p" }),
          (s2, e) => { receivedError = e; return s2.send({ prompt: "fallback" }); },
        ),
    });
    assert.equal(value, "recovered");
    assert(receivedError, "fallback should receive the thrown error");
    const list = spawns(io);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.args[1], "p");
    assert.equal(list[1]!.args[1], "fallback");
  });

  // -- parallelFork ---------------------------------------------------------
  await test("parallelFork: two children each issue their own send; neither carries --resume from the parent", async () => {
    const { value, io } = await runMock<string[]>({
      matchers: [
        {
          name: "child send",
          when: (c) => c.method === "spawnCapture",
          returns: (c: EffectCall, i: number) =>
            claudeReply({ sessionId: `sid-child-${i}`, result: `got:${(c.args[0] as SpawnCaptureArgs).args[1]}` }),
        },
      ],
      main: (s) => s.parallelFork(["task-a", "task-b"], (child, t) => child.send({ prompt: t })),
    });
    // Order between the two child spawns is non-deterministic (Promise.all).
    // Normalize by sorting, then assert exhaustively.
    const sorted = spawns(io).sort((a, b) => a.args[1]!.localeCompare(b.args[1]!));
    assert.deepEqual(sorted, [
      {
        command: "claude",
        args: [
          "-p", "task-a",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "claude",
        args: [
          "-p", "task-b",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
    ]);
    // Results mirror the input order.
    assert.deepEqual(value, ["got:task-a", "got:task-b"]);
  });

  await test("parallelFork: one child throwing propagates (Promise.all semantics)", async () => {
    const { threw, io } = await runMock({
      matchers: [
        {
          name: "B errors, A ok",
          when: (c) => c.method === "spawnCapture",
          returns: (c: EffectCall) => {
            const p = (c.args[0] as SpawnCaptureArgs).args[1]!;
            return p === "B"
              ? claudeReply({ isError: true, result: "second fails" })
              : claudeReply({ result: "ok" });
          },
        },
      ],
      main: (s) => s.parallelFork(["A", "B"], (child, t) => child.send({ prompt: t })),
    });
    assert(threw, "one failing child must propagate");
    // Both children did attempt a spawn before the failure propagated.
    const prompts = spawns(io).map((s) => s.args[1]).sort();
    assert.deepEqual(prompts, ["A", "B"]);
  });

  // -- materializeError / assert / pipe -------------------------------------
  await test("materializeError returns {error: <arg>} and performs zero spawns", async () => {
    const { value, io } = await runMock<unknown>({
      matchers: [],
      main: (s) => s.materializeError<string>("boom"),
    });
    assert.deepEqual(value, { error: "boom" });
    assert.deepEqual(spawns(io), []);
  });

  await test("assert passes through on success and throws on failure", async () => {
    const ok = await runMock<string>({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "yes" }) }],
      main: (s) => s.send({ prompt: "p" }).assert((r) => { if (r !== "yes") throw new Error("bad"); }),
    });
    assert.equal(ok.value, "yes");

    const bad = await runMock({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "no" }) }],
      main: (s) => s.send({ prompt: "p" }).assert((_r) => { throw new Error("assert-boom"); }),
    });
    assert(bad.threw instanceof Error);
    assert((bad.threw as Error).message.includes("assert-boom"));
  });

  await test("pipe runs its callback and returns its SessionWithResult's value", async () => {
    const { value } = await runMock<string>({
      matchers: [{ name: "ok", when: (c) => c.method === "spawnCapture", returns: claudeReply({ result: "inside-pipe" }) }],
      main: (s) => s.pipe((inner) => inner.send({ prompt: "p" })),
    });
    assert.equal(value, "inside-pipe");
  });

  // -- executeShell ---------------------------------------------------------
  await test("executeShell invokes `bash -c <cmd>` with the derived command and returns stdout", async () => {
    const { value, io } = await runMock<string>({
      matchers: [
        {
          name: "claude send",
          when: (c) =>
            c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "claude",
          returns: claudeReply({ result: "derived" }),
        },
        {
          name: "bash",
          when: (c) =>
            c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash",
          returns: {
            stdout: "shell-output\n",
            stderr: "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnError: null,
          } as SpawnCaptureResult,
        },
      ],
      main: (s) => s.send({ prompt: "p" }).executeShell((upstream) => `echo "${upstream}-tail"`),
    });
    assert.equal(value, "shell-output\n");
    assert.deepEqual(spawns(io), [
      {
        command: "claude",
        args: [
          "-p", "p",
          "--output-format", "json",
          "--dangerously-skip-permissions",
          "--model", "opus",
        ],
        cwd: TEST_CWD,
        timeoutMs: DEFAULT_TIMEOUT,
      },
      {
        command: "bash",
        args: ["-c", `echo "derived-tail"`],
        cwd: TEST_CWD,
      },
    ]);
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
