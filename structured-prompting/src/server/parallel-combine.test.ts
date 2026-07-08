/**
 * parallel-combine.test.ts — the parallelCombineWith{1..5} heterogeneous
 * parallel-join primitive (Session.parallelCombineWith*, graph kind
 * "parallelCombine", engine case). Driven through the REAL engine with cheap
 * `bash` branches (no model calls).
 *
 * Edge cases:
 *   (1) arity 2 — combine receives the two branch values POSITIONALLY, in order.
 *   (2) the branches run truly IN PARALLEL — proven by a rendezvous barrier
 *       (each branch waits for the other's file; serial execution would deadlock
 *       so neither would report "SAW").
 *   (3) arity 1 — single branch, combine gets one value.
 *   (4) arity 3 and (5) arity 5 — all branches run, positional join order.
 *   (6) a THROWING branch cancels siblings + propagates (Promise.all semantics)
 *       → execute() rejects.
 */
import { ClaudeEngine, Session } from "../index.js";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

function newEngine() {
  return new ClaudeEngine({ persist: false, hookSignals: false, log: false, port: 0 });
}
async function run<R>(main: (s: Session) => unknown): Promise<R> {
  const engine = newEngine();
  try {
    return (await engine.execute(new Session({ sessionId: "t", cwd: process.cwd() }), main as never)) as R;
  } finally {
    await engine.shutdown();
  }
}
const trim = (s: unknown) => String(s).trim();

async function main() {
  console.log("\nparallelCombineWith{1..5} — heterogeneous parallel-join primitive\n");

  // (1) arity 2 — positional join order.
  {
    const joint = await run<string>((s) =>
      s.parallelCombineWith2(
        (b) => b.executeShell(() => "echo AAA"),
        (b) => b.executeShell(() => "echo BBB"),
        (a, b) => `${trim(a)}|${trim(b)}`,
      ));
    ok("(1) arity 2 — combine receives both values in branch order", joint === "AAA|BBB", joint);
  }

  // (2) TRUE parallelism via a rendezvous barrier (exit-semantics-independent:
  //     each branch reports SAW only if it observed the other's file while
  //     waiting — impossible under serial execution).
  {
    const dir = mkdtempSync(join(tmpdir(), "pcw-rv-"));
    const wait = (self: string, other: string) =>
      `touch ${join(dir, self)}; for i in $(seq 1 50); do if [ -f ${join(dir, other)} ]; then echo SAW; exit 0; fi; sleep 0.1; done; echo TIMEOUT`;
    const joint = await run<string[]>((s) =>
      s.parallelCombineWith2(
        (b) => b.executeShell(() => wait("a", "b")),
        (b) => b.executeShell(() => wait("b", "a")),
        (a, b) => [trim(a), trim(b)],
      ));
    ok("(2) branches run in parallel — both saw each other (rendezvous, no deadlock)",
      Array.isArray(joint) && joint[0] === "SAW" && joint[1] === "SAW", JSON.stringify(joint));
    rmSync(dir, { recursive: true, force: true });
  }

  // (3) arity 1.
  {
    const joint = await run<string>((s) =>
      s.parallelCombineWith1((b) => b.executeShell(() => "echo SOLO"), (a) => `only:${trim(a)}`));
    ok("(3) arity 1 — single branch value", joint === "only:SOLO", joint);
  }

  // (4) arity 3 — positional order.
  {
    const joint = await run<string>((s) =>
      s.parallelCombineWith3(
        (b) => b.executeShell(() => "echo 1"),
        (b) => b.executeShell(() => "echo 2"),
        (b) => b.executeShell(() => "echo 3"),
        (a, b, c) => `${trim(a)}${trim(b)}${trim(c)}`,
      ));
    ok("(4) arity 3 — all three run, joined in order", joint === "123", joint);
  }

  // (5) arity 5 — positional order.
  {
    const joint = await run<string>((s) =>
      s.parallelCombineWith5(
        (b) => b.executeShell(() => "echo a"),
        (b) => b.executeShell(() => "echo b"),
        (b) => b.executeShell(() => "echo c"),
        (b) => b.executeShell(() => "echo d"),
        (b) => b.executeShell(() => "echo e"),
        (a, b, c, d, e) => [a, b, c, d, e].map(trim).join(""),
      ));
    ok("(5) arity 5 — all five run, joined in order", joint === "abcde", joint);
  }

  // (6) a throwing branch cancels siblings + propagates → execute rejects.
  {
    let threw = false;
    try {
      await run((s) =>
        s.parallelCombineWith2(
          (b) => b.executeShell(() => "echo ok"),
          (b) => b.pipe(() => { throw new Error("boom-branch"); }),
          (a, b) => [a, b],
        ));
    } catch { threw = true; }
    ok("(6) a throwing branch propagates → execute() rejects", threw);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
