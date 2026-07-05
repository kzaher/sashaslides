/**
 * accept-orchestration.test.ts — unit tests for the POST-RUN, rating-gated
 * accept orchestration (accept-orchestration.ts). NO real engine / git / Chrome
 * / timers / filesystem: the rating gate, the accept-runner (mergePhase), and
 * the demote are all injected fakes.
 *
 * Asserted:
 *   (1) the orchestrator BLOCKS on each task until allRated — a task with an
 *       unrated slide is NOT partitioned green/red until the gate flips it
 *       all-rated (we model the block by returning the split the gate resolves
 *       to, and assert an unrated split never leaks into green/red).
 *   (2) an ALL-GOOD task → included in the GREEN set passed to mergePhase.
 *   (3) a task with ANY bad slide → demoteForResolve called with its slides +
 *       reason, and it is NOT accepted (not in green).
 *   (4) the GREEN set is exactly what the accept-runner (mergePhase) receives.
 *   (5) BUG_SOLVING_NO_ACCEPT=1 → no wait, no demote, no accept-runner call.
 *   (+) the resolved-timeout policy (env + TTY) is exercised.
 *
 * Run: cd /workspaces/sashaslides && npx tsx renderer/structured-prompts/bug_solving/accept-orchestration.test.ts
 */
import { strict as assert } from "node:assert";
import {
  runAcceptPhase,
  resolveRatingTimeoutMs,
  acceptDisabled,
  type SuccessfulTask,
  type AcceptDeps,
} from "./accept-orchestration.js";
import type { RatingSplit } from "./rating-gate.js";
import type { MergeCluster, MergeReport } from "./merge-phase.js";

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
// helpers
// ---------------------------------------------------------------------------
function mkTask(task: string, slides: string[]): SuccessfulTask {
  return { task, dir: `/wt/${task}`, slides, ratingsFile: `/wt/${task}/ratings.json`, url: `http://localhost:47/${task}` };
}
function split(good: string[], bad: string[], unrated: string[] = []): RatingSplit {
  return { allRated: unrated.length === 0, good, bad, unrated };
}
function emptyReport(): MergeReport {
  return { accepted: [], rejected: [], conflicts: [], perSlide: {} };
}

/** A recording deps builder. `gate` maps task slug → the split its wait resolves
 *  to (the fake gate simulates the BLOCK having already completed to that
 *  split). */
function makeDeps(opts: {
  gate: Record<string, RatingSplit>;
  runAcceptReport?: MergeReport | null;
}): AcceptDeps & {
  waited: string[];
  demoteCalls: Array<{ slides: string[]; task: string; reason: string }>;
  acceptedGreen: MergeCluster[][];
} {
  const waited: string[] = [];
  const demoteCalls: Array<{ slides: string[]; task: string; reason: string }> = [];
  const acceptedGreen: MergeCluster[][] = [];
  return {
    waited, demoteCalls, acceptedGreen,
    log: () => {},
    waitForRatings: async (task) => {
      waited.push(task.task);
      const s = opts.gate[task.task];
      if (!s) throw new Error(`no scripted gate split for ${task.task}`);
      return s;
    },
    demoteForResolve: (slides, task, reason) => { demoteCalls.push({ slides: [...slides], task, reason }); },
    runAccept: async (green) => { acceptedGreen.push(green.map((g) => ({ ...g }))); return opts.runAcceptReport ?? emptyReport(); },
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
async function main() {
  console.log("\naccept-orchestration tests (injected gate + accept-runner + demote)\n");

  // (1) BLOCKS until allRated: the gate returns an all-rated split; an unrated
  //     split must never partition into green/red. We prove that a split with
  //     `unrated` (i.e. a finite-timeout deferral) is treated as RED, and that
  //     the wait was consulted for every task before any partition.
  await test("(1) blocks per task; unrated (never allRated) → RED not green", async () => {
    delete process.env.BUG_SOLVING_NO_ACCEPT;
    delete process.env.BUG_SOLVING_RATING_TIMEOUT_MS;
    const tasks = [mkTask("a", ["slide_01"]), mkTask("b", ["slide_02"])];
    // "a" resolves all-good; "b" resolves with an unrated slide (deadline).
    const deps = makeDeps({ gate: { a: split(["slide_01"], []), b: split([], [], ["slide_02"]) } });
    const res = await runAcceptPhase(tasks, deps, {});
    assert.deepEqual(deps.waited, ["a", "b"], "gate consulted for every task, in order");
    // "a" green, "b" red (unrated → deferred RED, never green).
    assert.deepEqual(res.green.map((g) => g.task), ["a"], "only the all-good task is green");
    assert.deepEqual(res.red.map((t) => t.task), ["b"], "the still-unrated task is red");
    assert.equal(deps.demoteCalls.length, 1, "unrated task demoted");
    assert.equal(deps.demoteCalls[0].task, "b");
    assert.ok(/unrated/i.test(deps.demoteCalls[0].reason), "reason mentions unrated deferral");
  });

  // (2) all-good task → included in the green set passed to the accept-runner.
  await test("(2) all-good task → GREEN, passed to accept-runner", async () => {
    delete process.env.BUG_SOLVING_NO_ACCEPT;
    const tasks = [mkTask("clip", ["slide_04", "slide_05"])];
    const deps = makeDeps({ gate: { clip: split(["slide_04", "slide_05"], []) } });
    const res = await runAcceptPhase(tasks, deps, {});
    assert.deepEqual(res.green.map((g) => g.task), ["clip"], "all-good → green");
    assert.equal(deps.demoteCalls.length, 0, "no demote for a green task");
    assert.equal(deps.acceptedGreen.length, 1, "accept-runner invoked once");
    assert.deepEqual(deps.acceptedGreen[0].map((g) => g.task), ["clip"], "green cluster forwarded to accept-runner");
    assert.deepEqual(deps.acceptedGreen[0][0].slides, ["slide_04", "slide_05"], "cluster carries its slides");
  });

  // (3) any-bad task → demoteForResolve(slides, task, reason); NOT accepted.
  await test("(3) any-bad task → demoted (not accepted)", async () => {
    delete process.env.BUG_SOLVING_NO_ACCEPT;
    const tasks = [mkTask("border", ["slide_10", "slide_11"])];
    const deps = makeDeps({ gate: { border: split(["slide_10"], ["slide_11"]) } });
    const res = await runAcceptPhase(tasks, deps, {});
    assert.deepEqual(res.green, [], "bad task not green");
    assert.deepEqual(res.red.map((t) => t.task), ["border"], "bad task is red");
    assert.equal(deps.demoteCalls.length, 1, "demote called once");
    assert.deepEqual(deps.demoteCalls[0].slides, ["slide_10", "slide_11"], "demote gets the whole targeted set");
    assert.ok(/slide_11/.test(deps.demoteCalls[0].reason) && /bad/.test(deps.demoteCalls[0].reason), "reason names the bad slide");
    assert.equal(deps.acceptedGreen.length, 0, "accept-runner NOT invoked (no green)");
  });

  // (4) green set is EXACTLY what the accept-runner (mergePhase) receives —
  //     mixed run: one green, one red → only the green cluster is forwarded.
  await test("(4) mixed run → accept-runner receives exactly the green set", async () => {
    delete process.env.BUG_SOLVING_NO_ACCEPT;
    const tasks = [mkTask("g1", ["slide_01"]), mkTask("r1", ["slide_02"]), mkTask("g2", ["slide_03"])];
    const deps = makeDeps({
      gate: { g1: split(["slide_01"], []), r1: split([], ["slide_02"]), g2: split(["slide_03"], []) },
    });
    const res = await runAcceptPhase(tasks, deps, {});
    assert.deepEqual(res.green.map((g) => g.task).sort(), ["g1", "g2"], "both good tasks green");
    assert.deepEqual(deps.acceptedGreen[0].map((g) => g.task), ["g1", "g2"], "accept-runner got exactly the green set");
    assert.equal(deps.demoteCalls.length, 1, "only the red task demoted");
    assert.equal(deps.demoteCalls[0].task, "r1");
    assert.ok(res.report != null, "report returned when something green");
  });

  // (5) BUG_SOLVING_NO_ACCEPT=1 → no wait, no demote, no accept-runner.
  await test("(5) BUG_SOLVING_NO_ACCEPT=1 → skip: no wait, no demote, no accept", async () => {
    const tasks = [mkTask("a", ["slide_01"]), mkTask("b", ["slide_02"])];
    const deps = makeDeps({ gate: { a: split(["slide_01"], []), b: split([], ["slide_02"]) } });
    const res = await runAcceptPhase(tasks, deps, { BUG_SOLVING_NO_ACCEPT: "1" } as NodeJS.ProcessEnv);
    assert.equal(res.skipped, true, "phase skipped");
    assert.deepEqual(deps.waited, [], "no rating gate consulted");
    assert.equal(deps.demoteCalls.length, 0, "no demote");
    assert.equal(deps.acceptedGreen.length, 0, "accept-runner never called");
    assert.deepEqual(res.green, [], "no green");
    assert.deepEqual(res.red, [], "no red");
  });

  // (+) resolveRatingTimeoutMs policy (TTY-INDEPENDENT): unset → 0 forever always;
  //     explicit N → N; explicit 0 → 0; garbage → 0. Ratings come from the browser
  //     UI, so a detached (no-TTY) run must still wait forever by default.
  await test("(+) resolveRatingTimeoutMs: unset → 0 forever always; explicit bounds", async () => {
    assert.equal(resolveRatingTimeoutMs({ BUG_SOLVING_RATING_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv), 5000, "explicit finite value wins");
    assert.equal(resolveRatingTimeoutMs({ BUG_SOLVING_RATING_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv), 0, "explicit 0 = forever");
    assert.equal(resolveRatingTimeoutMs({} as NodeJS.ProcessEnv), 0, "unset = wait forever (0), independent of TTY");
    assert.equal(resolveRatingTimeoutMs({ BUG_SOLVING_RATING_TIMEOUT_MS: "nope" } as NodeJS.ProcessEnv), 0, "garbage → 0 (forever)");
    assert.equal(resolveRatingTimeoutMs({ BUG_SOLVING_RATING_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv), 0, "negative → 0 (forever)");
  });

  // (+) acceptDisabled: only the exact "1" opt-out disables the accept phase.
  await test("(+) acceptDisabled: '1' disables; unset/other = enabled", async () => {
    assert.equal(acceptDisabled({ BUG_SOLVING_NO_ACCEPT: "1" } as NodeJS.ProcessEnv), true, "'1' → disabled");
    assert.equal(acceptDisabled({} as NodeJS.ProcessEnv), false, "unset → enabled");
    assert.equal(acceptDisabled({ BUG_SOLVING_NO_ACCEPT: "0" } as NodeJS.ProcessEnv), false, "'0' → enabled");
    assert.equal(acceptDisabled({ BUG_SOLVING_NO_ACCEPT: "true" } as NodeJS.ProcessEnv), false, "'true' → enabled (only '1' counts)");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.error(`FAIL ${f.name}: ${(f.err as Error)?.message ?? f.err}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
