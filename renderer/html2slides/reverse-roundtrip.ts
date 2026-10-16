#!/usr/bin/env npx tsx
/**
 * reverse-roundtrip.ts — the REVERSE direction of the html2slides SxS: for every e2e case, the
 * Google Slides presentation the forward run produced is imported into a Sasha engine document,
 * each slide is exported as a self-contained 1280 x 720 page and screenshotted, and fidelity is
 * measured twice per slide (reverse/reverse-metrics.ts):
 *   (a) reverse step: the Sasha screenshot against Google's own thumbnail of that slide;
 *   (b) full round trip: the Sasha screenshot against the original fixture HTML's screenshot.
 *
 * Sets: `basic` (e2e/fixtures-basic), `complex` (e2e/fixtures) and `deck`, a real presentation the
 * Sasha editor imported poorly. The deck is READ ONLY: this script only ever reads presentations;
 * the forward uploads it makes are new presentations of its own (convert-pptx.ts).
 *
 * Results, per set, in <output>/<set>/ (reverse/reverse-results.ts has the layout), plus the
 * combined <output>/metrics.json. Resumable: re-running reuses the forward upload, the thumbnails
 * and the fixture screenshots, and redoes the import, export and screenshots (reverse-set.ts).
 *
 * Run through reverse-sxs.sh, which supplies the engine's JSX settings, or as:
 *   npx tsx --tsconfig ../../mcp/sasha-slides/engine/tsconfig.json reverse-roundtrip.ts [--sets basic,complex,deck]
 *     [--output /workspaces/sashaslides/.sxs-reverse] [--chrome-port 9223]
 *     [--presentation basic=<id>] [--fresh-upload] [--refresh-thumbnails] [--refresh-fixture-shots]
 *     [--offline [--pptx basic=<path>]]   re-measure from the recordings when the token has expired
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openChromeTab } from "./reverse/chrome-capture.ts";
import { createGoogleSlidesSource, createRecordedGoogleSlidesSource, type GoogleSlidesSource, type PresentationRecording } from "./reverse/google-slides-source.ts";
import { ALL_SETS, setLayoutOf, type ReverseSet, type SlideMetrics } from "./reverse/reverse-results.ts";
import { runReverseSet, type SetSource } from "./reverse/reverse-set.ts";

/** The deck the user saw imported poorly. Read only: never written to. */
export const TEST_DECK_PRESENTATION_ID = "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";

type Arguments = Readonly<{
  sets: readonly ReverseSet[];
  output: string;
  chromePort: number;
  deviceScaleFactor: number;
  givenPresentations: ReadonlyMap<ReverseSet, string>;
  freshUpload: boolean;
  refreshThumbnails: boolean;
  refreshFixtureShots: boolean;
  /** Re-measure from each set's recordings (presentation.json, presentation.pptx, thumbnails, pictures) without Google. */
  offline: boolean;
  /** A .pptx to use as a set's export offline, when its own export was never recorded. */
  pptxOverrides: ReadonlyMap<ReverseSet, string>;
}>;

const CONVERTER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CONVERTER_DIRECTORY, "..", "..");
const FIXTURE_DIRECTORIES: Readonly<Record<Exclude<ReverseSet, "deck">, string>> = {
  basic: join(CONVERTER_DIRECTORY, "e2e", "fixtures-basic"),
  complex: join(CONVERTER_DIRECTORY, "e2e", "fixtures"),
};
/** Where regen-basics.sh / regen-complex.sh record their presentation (meta.json), newest layout first. */
const RECORDED_FORWARD_RUNS: Readonly<Record<Exclude<ReverseSet, "deck">, readonly string[]>> = {
  basic: ["/tmp/sxs/meta.json"],
  complex: [join(REPOSITORY_ROOT, ".sxs-complex", "meta.json"), "/tmp/sxs-complex/meta.json"],
};

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const log = (line: string): void => console.log(line);
  mkdirSync(parsed.output, { recursive: true });
  const workDirectory = join(parsed.output, ".work");
  const google: GoogleSlidesSource = parsed.offline
    ? createRecordedGoogleSlidesSource(recordingsOf(parsed))
    : createGoogleSlidesSource({
        credentialsPath: join(REPOSITORY_ROOT, ".auth", "google_oauth.json"),
        tokensPath: join(REPOSITORY_ROOT, ".auth", "tokens.json"),
        fetch,
        delay: (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
        now: Date.now,
        log,
      });
  if (parsed.offline) log("OFFLINE: measuring from the recorded presentations, exports, thumbnails and pictures; nothing is read from Google");
  await using chrome = await openChromeTab({ port: parsed.chromePort, deviceScaleFactor: parsed.deviceScaleFactor });
  const failures: string[] = [];
  for (const set of parsed.sets) {
    try {
      await runReverseSet({
        set,
        source: sourceOf({ set, parsed }),
        outputRoot: parsed.output,
        converterDirectory: CONVERTER_DIRECTORY,
        workDirectory,
        refreshThumbnails: parsed.refreshThumbnails,
        refreshFixtureShots: parsed.refreshFixtureShots,
        offline: parsed.offline,
        google,
        chrome,
        now: Date.now,
        log,
      });
    } catch (cause) {
      const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
      failures.push(`${set}: ${message}`);
      log(`[${set}] FAILED: ${message}`);
    }
  }
  const combined = combineMetrics(parsed.output);
  writeFileSync(join(parsed.output, "metrics.json"), `${JSON.stringify(combined, null, 2)}\n`);
  writeFileSync(join(parsed.output, "summary.json"), `${JSON.stringify(summarise(combined), null, 2)}\n`);
  log(`\nmetrics: ${join(parsed.output, "metrics.json")}`);
  for (const line of summaryLines(combined)) log(line);
  if (failures.length > 0) {
    log(`\n${failures.length} set(s) failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
}

/** Each requested set's recorded presentation, by the presentation id its state.json names. */
function recordingsOf(parsed: Arguments): ReadonlyMap<string, PresentationRecording> {
  const recordings = new Map<string, PresentationRecording>();
  for (const set of parsed.sets) {
    const layout = setLayoutOf({ outputRoot: parsed.output, set });
    if (!existsSync(layout.statePath)) throw new Error(`offline: ${set} has no recorded run (${layout.statePath})`);
    const state: unknown = JSON.parse(readFileSync(layout.statePath, "utf-8"));
    const presentationId = typeof state === "object" && state !== null && "presentationId" in state ? state.presentationId : undefined;
    if (typeof presentationId !== "string") throw new Error(`offline: ${layout.statePath} names no presentation`);
    const recordedPptx = join(layout.importDirectory, "presentation.pptx");
    const pptxPath = parsed.pptxOverrides.get(set) ?? (existsSync(recordedPptx) ? recordedPptx : null);
    recordings.set(presentationId, { answerPath: join(layout.importDirectory, "presentation.json"), pptxPath });
  }
  return recordings;
}

function sourceOf(options: Readonly<{ set: ReverseSet; parsed: Arguments }>): SetSource {
  const { set, parsed } = options;
  switch (set) {
    case "deck":
      return { kind: "presentation", presentationId: parsed.givenPresentations.get("deck") ?? TEST_DECK_PRESENTATION_ID };
    case "basic":
    case "complex":
      return {
        kind: "fixtures",
        fixtureDirectory: FIXTURE_DIRECTORIES[set],
        givenPresentationId: parsed.givenPresentations.get(set) ?? null,
        recordedPresentationId: recordedPresentationId({ candidates: RECORDED_FORWARD_RUNS[set], fixtureDirectory: FIXTURE_DIRECTORIES[set] }),
        freshUpload: parsed.freshUpload,
      };
    default:
      return assertNever(set);
  }
}

/** A forward run's presentation, when its meta.json says it converted this fixture directory. */
function recordedPresentationId(options: Readonly<{ candidates: readonly string[]; fixtureDirectory: string }>): string | null {
  for (const candidate of options.candidates) {
    if (!existsSync(candidate)) continue;
    const raw: unknown = JSON.parse(readFileSync(candidate, "utf-8"));
    if (typeof raw !== "object" || raw === null) continue;
    const htmlDirectory = "htmlDir" in raw ? raw.htmlDir : undefined;
    const presentationId = "presentationId" in raw ? raw.presentationId : undefined;
    if (typeof htmlDirectory === "string" && resolve(htmlDirectory) === options.fixtureDirectory && typeof presentationId === "string" && presentationId.length > 0) return presentationId;
  }
  return null;
}

/** Every set's metrics.json, so a run of one set still leaves the combined file whole. */
function combineMetrics(output: string): readonly SlideMetrics[] {
  return ALL_SETS.flatMap((set) => {
    const path = setLayoutOf({ outputRoot: output, set }).metricsPath;
    if (!existsSync(path)) return [];
    // metrics.json is written only by reverse-set.ts as an array of SlideMetrics.
    return JSON.parse(readFileSync(path, "utf-8")) as readonly SlideMetrics[];
  });
}

type SetSummary = Readonly<{
  set: ReverseSet;
  slides: number;
  meanReverseMismatchPercent: number | null;
  meanRoundTripMismatchPercent: number | null;
  meanForwardMismatchPercent: number | null;
  meanTextMatch: number | null;
  meanRoundTripTextMatch: number | null;
}>;

function summarise(metrics: readonly SlideMetrics[]): readonly SetSummary[] {
  return ALL_SETS.map((set) => {
    const rows = metrics.filter((row) => row.set === set);
    return {
      set,
      slides: rows.length,
      meanReverseMismatchPercent: meanOf(rows.map((row) => row.reverseMismatchPercent)),
      meanRoundTripMismatchPercent: meanOf(rows.map((row) => row.roundTripMismatchPercent)),
      meanForwardMismatchPercent: meanOf(rows.map((row) => row.forwardMismatchPercent)),
      meanTextMatch: meanOf(rows.map((row) => row.textMatch)),
      meanRoundTripTextMatch: meanOf(rows.map((row) => row.roundTripTextMatch)),
    };
  }).filter((summary) => summary.slides > 0);
}

function summaryLines(metrics: readonly SlideMetrics[]): readonly string[] {
  const format = (value: number | null, suffix: string): string => (value === null ? "n/a" : `${value.toFixed(2)}${suffix}`);
  return summarise(metrics).map(
    (summary) =>
      `${summary.set.padEnd(8)} ${String(summary.slides).padStart(3)} slides  reverse ${format(summary.meanReverseMismatchPercent, "%")}  round trip ${format(summary.meanRoundTripMismatchPercent, "%")}  forward ${format(summary.meanForwardMismatchPercent, "%")}  text ${format(summary.meanTextMatch, "")} / ${format(summary.meanRoundTripTextMatch, "")}`,
  );
}

function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 1000) / 1000;
}

function parseArguments(argv: readonly string[]): Arguments {
  let sets: readonly ReverseSet[] = ALL_SETS;
  let output = join(REPOSITORY_ROOT, ".sxs-reverse");
  let chromePort = 9223;
  let deviceScaleFactor = 1.25;
  const givenPresentations = new Map<ReverseSet, string>();
  let freshUpload = false;
  let refreshThumbnails = false;
  let refreshFixtureShots = false;
  let offline = false;
  const pptxOverrides = new Map<ReverseSet, string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case "--sets":
        sets = value().split(",").map((name) => parseSet(name.trim()));
        break;
      case "--output":
        output = resolve(value());
        break;
      case "--chrome-port":
        chromePort = Number(value());
        break;
      case "--device-scale-factor":
        deviceScaleFactor = Number(value());
        break;
      case "--presentation": {
        const [set, presentationId] = value().split("=");
        if (set === undefined || presentationId === undefined || presentationId.length === 0) throw new Error("--presentation takes <set>=<presentation id>");
        givenPresentations.set(parseSet(set), presentationId);
        break;
      }
      case "--fresh-upload":
        freshUpload = true;
        break;
      case "--refresh-thumbnails":
        refreshThumbnails = true;
        break;
      case "--refresh-fixture-shots":
        refreshFixtureShots = true;
        break;
      case "--offline":
        offline = true;
        break;
      case "--pptx": {
        const [set, path] = value().split("=");
        if (set === undefined || path === undefined || path.length === 0) throw new Error("--pptx takes <set>=<path to a .pptx>");
        pptxOverrides.set(parseSet(set), resolve(path));
        break;
      }
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  if (!Number.isInteger(chromePort) || chromePort <= 0) throw new Error("--chrome-port must be a port number");
  if (!(deviceScaleFactor > 0)) throw new Error("--device-scale-factor must be positive");
  if (offline && (freshUpload || refreshThumbnails)) throw new Error("--offline cannot upload or download thumbnails");
  return { sets, output, chromePort, deviceScaleFactor, givenPresentations, freshUpload, refreshThumbnails, refreshFixtureShots, offline, pptxOverrides };
}

function parseSet(name: string): ReverseSet {
  // A parse-boundary guard over a command-line string: new sets are added to ALL_SETS.
  const found = ALL_SETS.find((set) => set === name);
  if (found === undefined) throw new Error(`unknown set "${name}" (expected ${ALL_SETS.join(", ")})`);
  return found;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? (cause.stack ?? cause.message) : cause);
  process.exit(1);
});
