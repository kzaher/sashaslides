/**
 * assert.ts — the repo's existing test idiom, extracted so both test files
 * share it.
 *
 * `renderer/html2slides` has no test framework: `css-parse-helpers.test.ts` and
 * `drawio-store.e2e.test.ts` are plain `npx tsx` scripts with a hand-rolled
 * assert and a pass/fail counter, and they exit non-zero on failure. This
 * follows that convention rather than introducing vitest for two files.
 */
import { STAGED_IMAGE_FIELD } from "../slide-image.js";

export type TestRun = Readonly<{
  check: (label: string, condition: boolean, detail?: string) => void;
  equal: <TValue>(label: string, actual: TValue, expected: TValue) => void;
  near: (label: string, actual: number, expected: number, tolerance: number) => void;
  finish: () => never;
}>;

export function startTestRun(suiteName: string): TestRun {
  let passed = 0;
  const failures: string[] = [];

  const check = (label: string, condition: boolean, detail?: string): void => {
    if (condition) {
      passed++;
      return;
    }
    const message = detail === undefined ? label : `${label} — ${detail}`;
    failures.push(message);
    console.error(`FAIL: ${message}`);
  };

  return {
    check,
    equal: <TValue>(label: string, actual: TValue, expected: TValue): void => {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      check(label, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    near: (label: string, actual: number, expected: number, tolerance: number): void => {
      const within = Math.abs(actual - expected) <= tolerance;
      check(label, within, within ? undefined : `expected ${expected} ±${tolerance}, got ${actual}`);
    },
    finish: (): never => {
      console.log(`\n${suiteName}: ${passed} passed, ${failures.length} failed`);
      if (failures.length > 0) {
        console.error(`\n${failures.length} failure(s):`);
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exit(1);
      }
      process.exit(0);
    },
  };
}

/** Pull every request of one kind out of a batchUpdate body. */
export function requestsOfKind<TKind extends string>(
  requests: readonly Readonly<Record<string, unknown>>[],
  kind: TKind,
): readonly Readonly<Record<string, unknown>>[] {
  const found: Readonly<Record<string, unknown>>[] = [];
  for (const request of requests) {
    const payload = request[kind];
    if (payload !== undefined && typeof payload === "object" && payload !== null) {
      found.push(payload as Readonly<Record<string, unknown>>);
    }
  }
  return found;
}

/**
 * The single key a batchUpdate request wraps its payload in.
 *
 * `sashaStageImage` does not count: it is not an operation, it is the host's
 * instruction for getting an image's bytes somewhere Google can fetch them, and
 * `sashaInsert` strips it before the request is sent (slide-image.ts).
 */
export function kindOf(request: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(request).filter((key) => key !== STAGED_IMAGE_FIELD);
  return keys.length === 1 && keys[0] !== undefined ? keys[0] : `<${keys.length} keys>`;
}
