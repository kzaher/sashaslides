/**
 * Pure description-building logic. Represents the structured prompt the user
 * (or another model) actually cares about: measure a property, apply a fix,
 * re-measure and assert the value changed.
 *
 * This file has NO engine setup, NO workspace creation, NO console output —
 * everything side-effecting lives in main-scaffolding.ts. In real deployments
 * that scaffolding is typically a model-generated runner in a temp directory.
 */

import {
  Claude,
  Session,
  SessionWithResult,
  describeError,
  safelyJsonStringify,
} from "../src/index.js";
import type { Result } from "../src/api/wire.js";

export type TaskMeta = { workspace_dir: string; bug: string; measureCommand: string };
export type FinalResult = { originalMeasurement: string; newMeasurement: string };

// Plain TypeScript type — no runtime schema builder, no explicit schema
// argument on the send call. The build step's AST transformer
// (`src/transformer.ts`) rewrites `.send<Measured>({...})` below into
// `.send<Measured>({schema: typia.json.schema<Measured>(), ...})`, which
// typia's own esbuild plugin then inlines as a literal JSON Schema object.
// At runtime nothing is reflected — schemas are static data.
type Measured = { measuredValue: string };

export function main(args: {
  session: Session;
  tasks: TaskMeta[];
}): SessionWithResult<Array<Result<FinalResult>>> {
  // --- inner attempt body: measure → apply → re-measure, assert changed ----
  const tryWithModel = (s: Session, t: TaskMeta): SessionWithResult<FinalResult> =>
    s
      .prependToNextPrompt(`You are working inside ${t.workspace_dir}. cd there before running anything.`)
      .prependToNextPrompt(`The bug: ${t.bug}`)
      .send<Measured>({
        prompt: [
          "Run ONE short shell command that prints a single JSON line capturing a property affected by the bug.",
          `A script called 'measure.mjs' already exists in the workspace — run it with: \`${t.measureCommand}\`.`,
          'Read the JSON it prints and copy the single value into "measuredValue" as a string (JSON.stringify the value if needed). Do not modify any source file yet.',
        ].join(" "),
      })
      .combineWith<Measured, FinalResult>(
        (branch) =>
          branch
            .send({
              prompt: `Now edit the file(s) in ${t.workspace_dir} to fix the described bug. Make the smallest possible change. After editing, respond with exactly the text OK.`,
            })
            .send<Measured>({
              prompt: `Run \`${t.measureCommand}\` again in ${t.workspace_dir} and report the property under "measuredValue" using the same rule as before.`,
            }),
        (originalVal, newVal) => {
          if (originalVal.measuredValue === newVal.measuredValue) {
            throw new Error(
              `Measured values are the same ${safelyJsonStringify(originalVal.measuredValue)} — the fix did not take effect.`,
            );
          }
          return {
            originalMeasurement: originalVal.measuredValue,
            newMeasurement: newVal.measuredValue,
          };
        },
      );

  // --- outer parallel fork with model-escalation fallback ------------------
  // parallelFork no longer lifts errors; we do it ourselves by ending each
  // branch in a materializeError fallback so sibling tasks are never cancelled.
  return args.session.fork().compact().parallelFork(args.tasks, (child, task) => {
    return child
      .switchModel(Claude.haiku)
      .try<Result<FinalResult>>((s) => s
        .prependToNextPrompt(`Task workspace_dir: ${task.workspace_dir}\nTask bug: ${task.bug}`)
        .tryMultipleTimes<FinalResult>(
          3,
          (s) => tryWithModel(s, task),
          (s, e) =>
            s
              .fork()
              .compact()
              .switchModel(Claude.opus)
              .prependToNextPrompt(`There was an error ${describeError(e)}.`)
              .tryMultipleTimes<FinalResult>(
                3,
                (s2) => tryWithModel(s2, task),
              ),
        // Don't cancel other threads immediately.
        ), (s, e) => s.materializeError(describeError(e)));
  });
}
