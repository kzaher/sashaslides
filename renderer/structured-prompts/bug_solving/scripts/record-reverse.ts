#!/usr/bin/env npx tsx
/**
 * record-reverse.ts — record one reverse-direction attempt from INSIDE a bug_solving fork.
 *
 * The forward direction records an attempt with record-rendering.ts (fixture -> pptx -> Google).
 * The reverse direction's attempt is the reverse pipeline re-run with the fork's importer, engine
 * renderer and HTML export, OFFLINE: Google's side (presentation answer, .pptx export, thumbnails,
 * pictures) is replayed from the canonical recordings, so the fix is judged against exactly what
 * the user rated and no Google quota or token is needed.
 *
 * Steps:
 *   1. Clear --output (a retry must never be judged on a previous attempt's renders).
 *   2. Seed it with each needed set's RECORDINGS from --canonical (state.json, import/presentation.json,
 *      import/presentation.pptx, import/pictures/, originals/ = Google thumbnails, round-trip/originals/
 *      + fixture-text.json = fixture screenshots). Renders, diffs, html and metrics are NOT copied:
 *      they are what the attempt produces.
 *   3. Run reverse-sxs.sh --offline over those sets (only --slides when given).
 *
 * --output must be OUTSIDE the overlay (the fork's shared dir): host Chrome screenshots the exported
 * page by its file address, and the jail's private upper layer is invisible to it.
 *
 *   npx tsx record-reverse.ts --canonical /workspaces/sashaslides/.sxs-reverse --output <dir>
 *     [--slides complex__slide_05,…] [--chrome-port 9223]
 *
 * Exits with the pipeline's status: a fix that breaks the importer must fail the attempt.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_SETS, setLayoutOf, type ReverseSet } from "../../../html2slides/reverse/reverse-results.js";
import { DEFAULT_REVERSE_CHROME_PORT, reversePipelineArguments, reverseSetsOf, REVERSE_SCRIPTS } from "../reverse-direction.js";

type RecordArguments = Readonly<{
  canonical: string;
  output: string;
  slideIds: readonly string[] | null;
  chromePort: number;
}>;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function main(): void {
  const parsed = parseArguments(process.argv.slice(2));
  const sets = parsed.slideIds === null ? ALL_SETS : reverseSetsOf(parsed.slideIds);
  if (sets.length === 0) throw new Error(`no reverse set named by --slides ${parsed.slideIds?.join(",") ?? ""}`);
  rmSync(parsed.output, { recursive: true, force: true });
  for (const set of sets) seedRecordings({ set, canonical: parsed.canonical, output: parsed.output });
  const pipelineArguments = reversePipelineArguments({ outputDirectory: parsed.output, slideIds: parsed.slideIds, chromePort: parsed.chromePort });
  const pipeline = join(REPOSITORY_ROOT, REVERSE_SCRIPTS.pipeline);
  console.error(`[record-reverse] bash ${pipeline} ${pipelineArguments.join(" ")}`);
  const run = spawnSync("bash", [pipeline, ...pipelineArguments], { stdio: "inherit" });
  if (run.error !== undefined) throw run.error;
  process.exit(run.status ?? 1);
}

/** Copy one set's recordings (never its renders) from the canonical results into the output. */
function seedRecordings(options: Readonly<{ set: ReverseSet; canonical: string; output: string }>): void {
  const from = setLayoutOf({ outputRoot: options.canonical, set: options.set });
  const to = setLayoutOf({ outputRoot: options.output, set: options.set });
  if (!existsSync(from.statePath)) throw new Error(`[record-reverse] ${options.set}: no recorded run at ${from.statePath}; run reverse-sxs.sh once online first`);
  const recordings: ReadonlyArray<Readonly<{ source: string; target: string }>> = [
    { source: from.statePath, target: to.statePath },
    { source: join(from.importDirectory, "presentation.json"), target: join(to.importDirectory, "presentation.json") },
    { source: join(from.importDirectory, "presentation.pptx"), target: join(to.importDirectory, "presentation.pptx") },
    { source: join(from.importDirectory, "pictures"), target: join(to.importDirectory, "pictures") },
    { source: from.originals, target: to.originals },
    { source: from.roundTrip.originals, target: to.roundTrip.originals },
    { source: from.roundTrip.fixtureTextPath, target: to.roundTrip.fixtureTextPath },
  ];
  for (const recording of recordings) {
    if (!existsSync(recording.source)) continue;
    mkdirSync(dirname(recording.target), { recursive: true });
    cpSync(recording.source, recording.target, { recursive: true, dereference: true });
  }
}

function parseArguments(argv: readonly string[]): RecordArguments {
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  const canonical = value("--canonical");
  const output = value("--output");
  if (canonical === null || output === null) throw new Error("record-reverse: --canonical and --output are required");
  const slides = value("--slides");
  const chromePort = Number(value("--chrome-port") ?? DEFAULT_REVERSE_CHROME_PORT);
  if (!Number.isInteger(chromePort) || chromePort <= 0) throw new Error("--chrome-port must be a port number");
  return {
    canonical: resolve(canonical),
    output: resolve(output),
    slideIds: slides === null ? null : slides.split(",").map((id) => id.trim()).filter((id) => id.length > 0),
    chromePort,
  };
}

main();
