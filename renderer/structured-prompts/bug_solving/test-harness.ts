/**
 * test-harness.ts — the one assertion counter shared by every bug_solving test file.
 *
 * Each test file is its own process (run-tests.sh runs them one by one), so the counters are
 * module state: `ok` records a boolean check, `test` runs a named body and records whether it
 * threw, and `summary` prints the `=== Results: N passed, M failed ===` line run-tests.sh shows
 * and exits 1 when anything failed. `freePort` asks the OS for an unused TCP port.
 */
import { createServer } from "node:net";

type Failure = Readonly<{ name: string; detail: string }>;

let passed = 0;
let failed = 0;
const failures: Failure[] = [];

function describe(cause: unknown): string {
  return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}

/** Record one check: `extra` is printed next to a failing name. */
export function ok(name: string, condition: boolean, extra = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    return;
  }
  failed++;
  failures.push({ name, detail: extra });
  console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ""}`);
}

/** Run one named test body; it passes when it returns without throwing. */
export async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (cause) {
    failed++;
    failures.push({ name, detail: describe(cause) });
    const message = cause instanceof Error ? cause.message : String(cause);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${message.split("\n").slice(0, 8).join("\n      ")}`);
  }
}

/** Print the results line; on any failure list the failures and exit 1. */
export function summary(): void {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed === 0) return;
  for (const failure of failures) {
    console.log(`  ✗ ${failure.name}${failure.detail ? `\n    ${failure.detail}` : ""}`);
  }
  process.exit(1);
}

/** Ask the OS for a free ephemeral port (bind to :0, read the assigned port). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}
