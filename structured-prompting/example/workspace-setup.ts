import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Two canonical "bug" workspaces used by example/main.ts. Each directory is a
 * self-contained mini-project with a deterministic measurement script. The
 * engine will ask the model to:
 *   1) measure the buggy value,
 *   2) patch the source,
 *   3) re-measure and confirm the value changed.
 *
 * We keep the bugs trivial so the whole end-to-end run fits in a few model
 * calls — the point is to exercise the orchestration, not to write code.
 */

export interface Workspace {
  workspace_dir: string;
  bug: string;
  /** Shell command the MODEL will be told to run (and we will inspect results through its reports). */
  measureCommand: string;
}

export function buildExampleWorkspaces(): Workspace[] {
  const base = join(tmpdir(), `sp-example-${Date.now()}`);
  if (existsSync(base)) rmSync(base, { recursive: true });
  mkdirSync(base, { recursive: true });

  const wsA = join(base, "bug-a");
  mkdirSync(wsA, { recursive: true });
  writeFileSync(
    join(wsA, "calc.js"),
    [
      "// BUG: area() uses the wrong formula for a circle.",
      "export function area(r) {",
      "  return 2 * Math.PI * r; // should be Math.PI * r * r",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(wsA, "measure.mjs"),
    [
      "import { area } from './calc.js';",
      "console.log(JSON.stringify({ areaOf5: area(5) }));",
    ].join("\n"),
  );

  const wsB = join(base, "bug-b");
  mkdirSync(wsB, { recursive: true });
  writeFileSync(
    join(wsB, "greet.js"),
    [
      "// BUG: greet always returns 'hello'. It should return 'Hello, <name>!'.",
      "export function greet(name) {",
      "  return 'hello';",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(wsB, "measure.mjs"),
    [
      "import { greet } from './greet.js';",
      "console.log(JSON.stringify({ greetWorld: greet('world') }));",
    ].join("\n"),
  );

  return [
    {
      workspace_dir: wsA,
      bug: "In calc.js, area(r) returns 2*PI*r (circumference) instead of PI*r*r (area).",
      measureCommand: "node measure.mjs",
    },
    {
      workspace_dir: wsB,
      bug: "In greet.js, greet(name) returns the literal 'hello' instead of the templated 'Hello, <name>!'.",
      measureCommand: "node measure.mjs",
    },
  ];
}
