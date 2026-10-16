/**
 * reverse-rating.ts — the server-side model behind the SxS rating UI's REVERSE mode.
 *
 * Why this exists: the forward SxS (rating-server.ts) compares an HTML fixture
 * screenshot ("original") with Google Slides' thumbnail of the converted deck
 * ("test"). The reverse importer runs the other way — Google Slides -> Sasha engine
 * document -> self-contained HTML -> Chrome screenshot — so rating it needs a
 * different pair (Google thumbnail vs Sasha HTML screenshot), a second pair for the
 * full round trip (fixture screenshot vs Sasha HTML screenshot), per-slide fidelity
 * metrics, its OWN ratings file (forward ratings stay untouched) and its OWN goldens
 * directory (e2e/goldens-reverse/, written only by the user's "Good" click).
 * Everything that decides which files a reverse slide consists of lives here, typed
 * and testable, so rating-server.ts only has to branch on the direction.
 *
 * Results directory layout read here (the reverse pipeline writes it):
 *   <results>/originals/<id>.png              [IN]  Google Slides thumbnail   (reverse "original")
 *   <results>/slides/<id>.png                 [IN]  Sasha HTML screenshot     (reverse "test")
 *   <results>/diffs/<id>.png | diff_<id>.png  [IN?] reverse pixel diff
 *   <results>/round-trip/originals/<id>.png   [IN?] original fixture HTML screenshot
 *   <results>/round-trip/slides/<id>.png      [IN?] Sasha screenshot for the round trip (default: slides/<id>.png)
 *   <results>/round-trip/diffs/<id>.png       [IN?] round-trip pixel diff
 *   <results>/html/<id>.html                  [IN?] the Sasha HTML document itself
 *   <results>/metrics.json                    [IN?] [{ caseId, set, slideNumber, reverseMismatchPercent,
 *                                                     roundTripMismatchPercent, textMatch, notes }]
 *   <results>/ratings-reverse.json            [OUT] reverse verdicts (rating-server.ts)
 *   <results>/annotations/, zoom-crops/       [OUT] the user's marks (rating-server.ts)
 * A results directory with no originals/ of its own may hold one such layout per
 * subdirectory (basic/, complex/, ...); slide ids are then "<subdirectory>__<file>".
 *
 * The shared interface fixes the metrics row but not the screenshot file names, so a
 * metrics row is matched to a screenshot by trying the spellings a pipeline plausibly
 * writes (see candidateSlideIds); an optional "slideId" field in the row wins outright.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { PNG } from "pngjs";
import { compareImages, type RgbaImage } from "./reverse/reverse-metrics.js";

/** Which way the rating server compares: forward = HTML -> Google Slides, reverse = Google Slides -> Sasha HTML. */
export type RatingDirection = "forward" | "reverse";

/** Which pair the reverse UI shows: the reverse step alone, or the full round trip from the fixture. */
export type ReverseView = "reverse" | "round-trip";

/** Reverse verdicts live in their own file so a reverse rating can never overwrite a forward one. */
export const reverseRatingsFileName = "ratings-reverse.json";

/** One row of metrics.json after parsing. textMatch is a fraction in [0, 1]. */
export type ReverseMetric = Readonly<{
  caseId: string;
  set: string;
  slideNumber: number;
  reverseMismatchPercent: number | null;
  roundTripMismatchPercent: number | null;
  textMatch: number | null;
  notes: string;
  /** Optional explicit screenshot id; when present it is the only id the row matches. */
  slideId: string | null;
  /** Optional provenance so the "Original: Google Slides" label can deep-link the deck. */
  presentationId: string | null;
  slideObjectId: string | null;
  /** Optional absolute paths, used when the default locations do not hold the documents. */
  fixtureHtml: string | null;
  sashaHtml: string | null;
}>;

export type ReverseMetricsReading = Readonly<{
  metrics: readonly ReverseMetric[];
  /** Human-readable reasons rows were skipped or could not be matched; printed at boot and in the summary. */
  problems: readonly string[];
}>;

/** The fixture directories a metrics row's "set" maps onto when looking for the original fixture HTML. */
export type FixtureDirectories = Readonly<{ basic: string; complex: string }>;

/** Every file that makes up one reverse slide, resolved to absolute paths. */
export type ReverseSlide = Readonly<{
  id: string;
  navigationLabel: string;
  googlePng: string;
  sashaPng: string;
  reverseDiffPng: string | null;
  fixturePng: string | null;
  roundTripSashaPng: string | null;
  roundTripDiffPng: string | null;
  sashaHtmlFile: string | null;
  fixtureHtmlFile: string | null;
  googleSlidesUrl: string | null;
  metric: ReverseMetric | null;
}>;

export type ReverseScan = Readonly<{
  slides: readonly ReverseSlide[];
  /** Ids with a Google thumbnail but no Sasha screenshot: the reverse render failed for them. */
  missingSashaRender: readonly string[];
  problems: readonly string[];
}>;

export type ReverseSummary = Readonly<{
  direction: "reverse";
  slideCount: number;
  ratedGood: number;
  ratedBad: number;
  meanReverseMismatchPercent: number | null;
  meanRoundTripMismatchPercent: number | null;
  meanTextMatch: number | null;
  worstReverse: Readonly<{ id: string; mismatchPercent: number }> | null;
  worstRoundTrip: Readonly<{ id: string; mismatchPercent: number }> | null;
  goldenCount: number;
  goldensDirectory: string;
  ratingsFile: string;
  missingSashaRender: readonly string[];
  problems: readonly string[];
}>;

export function parseRatingDirection(value: string): RatingDirection {
  if (value === "forward" || value === "reverse") return value;
  throw new Error(`--direction must be "forward" or "reverse", got "${value}"`);
}

/** The one exhaustive decision point every reverse/forward branch in rating-server.ts goes through. */
export function isReverseDirection(direction: RatingDirection): boolean {
  switch (direction) {
    case "forward":
      return false;
    case "reverse":
      return true;
    default:
      return assertNever(direction);
  }
}

/** Parse the client's view field at the trust boundary; anything unknown is the reverse step. */
export function parseReverseView(value: unknown): ReverseView {
  return value === "round-trip" ? "round-trip" : "reverse";
}

/**
 * Refuse a reverse goldens directory that is really a FORWARD goldens directory.
 * A reverse "Good" copies the Sasha screenshot; landing it in e2e/goldens/ would
 * silently replace a user-blessed Google thumbnail with a different kind of image.
 */
export function assertReverseGoldensDirectory(directory: string): void {
  const name = basename(directory);
  if (name === "goldens" || name === "goldens-complex") {
    throw new Error(`reverse goldens directory ${directory} is a forward goldens directory; use e2e/goldens-reverse/`);
  }
}

/** Scan a reverse results directory (flat, or one layout per subdirectory) into slides. */
export function scanReverseResults(options: Readonly<{
  resultsDirectory: string;
  fixtureDirectories: FixtureDirectories;
}>): ReverseScan {
  const roots = layoutRoots(options.resultsDirectory);
  const topLevelMetrics = roots.some((root) => root.directory === options.resultsDirectory)
    ? emptyReading
    : readReverseMetrics(options.resultsDirectory);
  const slides: ReverseSlide[] = [];
  const missingSashaRender: string[] = [];
  const problems: string[] = [...topLevelMetrics.problems];
  const allMetrics: ReverseMetric[] = [...topLevelMetrics.metrics];
  const matched = new Set<ReverseMetric>();
  for (const root of roots) {
    const reading = readReverseMetrics(root.directory);
    problems.push(...reading.problems);
    allMetrics.push(...reading.metrics);
    const scanned = scanLayoutRoot({
      root,
      metrics: [...reading.metrics, ...topLevelMetrics.metrics],
      fixtureDirectories: options.fixtureDirectories,
    });
    slides.push(...scanned.slides);
    missingSashaRender.push(...scanned.missingSashaRender);
    problems.push(...scanned.problems);
    for (const metric of scanned.matchedMetrics) matched.add(metric);
  }
  // Reported once over every root: in a per-set layout a top-level row legitimately
  // matches nothing in the other sets' roots. A row whose Sasha render failed did
  // match its Google thumbnail; it is reported under missingSashaRender instead.
  // By identity of content, not object: the per-set file and the combined top-level file carry
  // the same row twice, and only one copy can be the one a screenshot picked.
  const matchedRows = new Set([...matched].map(describeMetric));
  const unmatched = allMetrics.filter((metric) => !matchedRows.has(describeMetric(metric)));
  if (unmatched.length > 0 && slides.length > 0) {
    problems.push(`${unmatched.length} metrics row(s) match no screenshot, e.g. ${unmatched.slice(0, 3).map(describeMetric).join(", ")}`);
  }
  return { slides, missingSashaRender, problems };
}

/** One slide by id, for the rating routes that need a single pair. */
export function findReverseSlide(options: Readonly<{
  resultsDirectory: string;
  fixtureDirectories: FixtureDirectories;
  slideId: string;
}>): ReverseSlide | null {
  const scan = scanReverseResults(options);
  return scan.slides.find((slide) => slide.id === options.slideId) ?? null;
}

/** Parse <directory>/metrics.json; a missing file is an empty reading, a malformed one is a problem, never a crash. */
export function readReverseMetrics(directory: string): ReverseMetricsReading {
  const path = join(directory, "metrics.json");
  if (!existsSync(path)) return emptyReading;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { metrics: [], problems: [`${path}: unreadable JSON (${(error as Error).message})`] };
  }
  return parseReverseMetrics({ raw, source: path });
}

/** The parse boundary for metrics.json: untyped JSON in, typed rows plus problems out. */
export function parseReverseMetrics(options: Readonly<{ raw: unknown; source: string }>): ReverseMetricsReading {
  if (!Array.isArray(options.raw)) {
    return { metrics: [], problems: [`${options.source}: expected an array of slide metrics`] };
  }
  const entries: readonly unknown[] = options.raw;
  const metrics: ReverseMetric[] = [];
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    const parsed = parseReverseMetric(entry);
    if (typeof parsed === "string") problems.push(`${options.source}[${index}]: ${parsed}`);
    else metrics.push(parsed);
  });
  return { metrics, problems };
}

/**
 * The screenshot ids a metrics row may have been written under. The pipeline's
 * file naming is not part of the shared interface, so this lists the plausible
 * spellings: optional set prefix, the case id, and a slide-number suffix (or no
 * suffix when the case has a single slide).
 */
export function candidateSlideIds(options: Readonly<{ metric: ReverseMetric; caseSlideCount: number }>): readonly string[] {
  const { metric } = options;
  if (metric.slideId !== null) return [metric.slideId];
  const separators = ["__", "_", "-", "."];
  const numbers = [...new Set([String(metric.slideNumber), pad({ value: metric.slideNumber, width: 2 }), pad({ value: metric.slideNumber, width: 3 })])];
  const caseForms = [metric.caseId, ...(metric.set === "" ? [] : separators.map((separator) => `${metric.set}${separator}${metric.caseId}`))];
  const suffixes = [
    ...(options.caseSlideCount <= 1 ? [""] : []),
    ...separators.flatMap((separator) => numbers.flatMap((number) => [
      `${separator}${number}`,
      `${separator}slide_${number}`,
      `${separator}slide-${number}`,
      `${separator}s${number}`,
    ])),
  ];
  return [...new Set(caseForms.flatMap((caseForm) => suffixes.map((suffix) => `${caseForm}${suffix}`)))];
}

/** Map a metrics "set" onto a fixture directory; the set is free text from the pipeline. */
export function fixtureDirectoryForSet(options: Readonly<{ set: string; fixtureDirectories: FixtureDirectories }>): string | null {
  const normalized = options.set.toLowerCase();
  if (normalized.includes("basic")) return options.fixtureDirectories.basic;
  if (normalized.includes("complex") || normalized === "fixtures") return options.fixtureDirectories.complex;
  return null;
}

/** Copy the Sasha screenshot into the reverse goldens directory. Called ONLY from the user's "Good" click. */
export function blessReverseGolden(options: Readonly<{ slide: ReverseSlide; goldensDirectory: string }>): string {
  assertReverseGoldensDirectory(options.goldensDirectory);
  mkdirSync(options.goldensDirectory, { recursive: true });
  const target = join(options.goldensDirectory, `${options.slide.id}.png`);
  copyFileSync(options.slide.sashaPng, target);
  return target;
}

/** How a reverse slide's current render compares with the golden the user blessed for it. */
export type ReverseGoldenStatus = Readonly<{
  /** "ok" matches, "regressed" drifted past the limit, "new" has no golden,
   *  "missing-current" has a golden but no render. */
  diffStatus: "ok" | "regressed" | "new" | "missing-current";
  /** Pixels that differ after the reverse metric's blur (0 when byte-identical). */
  diffPixels: number;
}>;

const goldenStatusCache = new Map<string, ReverseGoldenStatus>();

/**
 * The rating UI's default view hides a slide rated Good unless its golden check says it diverged,
 * and the reverse direction had no golden check. A Good slide whose golden no longer matched could
 * therefore not be found without "show all". Measured 2026-10-16: deck slides 02/03 sat 18% and 23%
 * from goldens holding each other's image, every slide was rated Good, the default view was empty,
 * and the user's re-bless click landed on the page's fallback slide (basic 01) instead. Uses the
 * same measure and limit as the bug_solving reverse gate, so the page and the gate agree. Cached
 * by both files' mtime and size: only a changed render or golden is compared again.
 */
export function reverseGoldenStatus(options: Readonly<{ slide: ReverseSlide; goldensDirectory: string; driftLimitPercent: number }>): ReverseGoldenStatus {
  const golden = join(options.goldensDirectory, `${options.slide.id}.png`);
  if (!existsSync(golden)) return { diffStatus: "new", diffPixels: 0 };
  if (!existsSync(options.slide.sashaPng)) return { diffStatus: "missing-current", diffPixels: 0 };
  const goldenStat = statSync(golden);
  const renderStat = statSync(options.slide.sashaPng);
  const key = `${golden}:${goldenStat.mtimeMs}:${goldenStat.size}|${options.slide.sashaPng}:${renderStat.mtimeMs}:${renderStat.size}:${options.driftLimitPercent}`;
  const cached = goldenStatusCache.get(key);
  if (cached !== undefined) return cached;
  const goldenBytes = readFileSync(golden);
  const renderBytes = readFileSync(options.slide.sashaPng);
  let status: ReverseGoldenStatus = { diffStatus: "ok", diffPixels: 0 };
  if (!goldenBytes.equals(renderBytes)) {
    const comparison = compareImages({ expected: decodePng(goldenBytes), actual: decodePng(renderBytes) });
    status = { diffStatus: comparison.mismatchPercent > options.driftLimitPercent ? "regressed" : "ok", diffPixels: comparison.mismatchedPixels };
  }
  goldenStatusCache.set(key, status);
  return status;
}

function decodePng(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

/** Deck-level numbers for the report strip under the rating UI. */
export function summarizeReverse(options: Readonly<{
  scan: ReverseScan;
  statusById: ReadonlyMap<string, string>;
  goldensDirectory: string;
  ratingsFile: string;
}>): ReverseSummary {
  const { scan } = options;
  const statuses = scan.slides.map((slide) => options.statusById.get(slide.id) ?? "pending");
  return {
    direction: "reverse",
    slideCount: scan.slides.length,
    ratedGood: statuses.filter((status) => status === "good").length,
    ratedBad: statuses.filter((status) => status === "bad").length,
    meanReverseMismatchPercent: mean(scan.slides.map((slide) => slide.metric?.reverseMismatchPercent ?? null)),
    meanRoundTripMismatchPercent: mean(scan.slides.map((slide) => slide.metric?.roundTripMismatchPercent ?? null)),
    meanTextMatch: mean(scan.slides.map((slide) => slide.metric?.textMatch ?? null)),
    worstReverse: worst({ slides: scan.slides, pick: (metric) => metric.reverseMismatchPercent }),
    worstRoundTrip: worst({ slides: scan.slides, pick: (metric) => metric.roundTripMismatchPercent }),
    goldenCount: countPngs(options.goldensDirectory),
    goldensDirectory: options.goldensDirectory,
    ratingsFile: options.ratingsFile,
    missingSashaRender: scan.missingSashaRender,
    problems: scan.problems,
  };
}

/** The reverse addendum to describeRatingIo, printed at boot so the I/O contract is never implicit. */
export function describeReverseIo(options: Readonly<{ resultsDirectory: string; goldensDirectory: string; ratingsFile: string }>): string {
  return [
    `Reverse SxS I/O (Google Slides -> Sasha HTML; resultsDir = ${options.resultsDirectory})`,
    `  IN     originals = Google thumbnails   ${options.resultsDirectory}/originals/<id>.png`,
    `  IN     slides    = Sasha screenshots   ${options.resultsDirectory}/slides/<id>.png`,
    `  IN     round trip (fixture vs Sasha)   ${options.resultsDirectory}/round-trip/{originals,slides,diffs}/<id>.png`,
    `  IN     metrics                         ${options.resultsDirectory}/metrics.json`,
    `  OUT    reverse verdicts                ${options.ratingsFile}   (forward ratings.json untouched)`,
    `  OUT    reverse goldens (Good click)    ${options.goldensDirectory}/<id>.png`,
  ].join("\n");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

type LayoutRoot = Readonly<{ directory: string; idPrefix: string }>;

const emptyReading: ReverseMetricsReading = { metrics: [], problems: [] };

/** The flat layout when originals/ exists, otherwise every subdirectory that has one. */
function layoutRoots(resultsDirectory: string): readonly LayoutRoot[] {
  if (existsSync(join(resultsDirectory, "originals"))) return [{ directory: resultsDirectory, idPrefix: "" }];
  if (!existsSync(resultsDirectory)) return [];
  return readdirSync(resultsDirectory)
    .filter((name) => !name.startsWith(".") && isDirectory(join(resultsDirectory, name, "originals")))
    .sort()
    .map((name) => ({ directory: join(resultsDirectory, name), idPrefix: `${name}__` }));
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

type LayoutScan = Readonly<{
  slides: readonly ReverseSlide[];
  missingSashaRender: readonly string[];
  matchedMetrics: readonly ReverseMetric[];
  problems: readonly string[];
}>;

function scanLayoutRoot(options: Readonly<{
  root: LayoutRoot;
  metrics: readonly ReverseMetric[];
  fixtureDirectories: FixtureDirectories;
}>): LayoutScan {
  const { root } = options;
  const originalsDirectory = join(root.directory, "originals");
  const fileIds = readdirSync(originalsDirectory)
    .filter((name) => name.endsWith(".png"))
    .map((name) => name.slice(0, -".png".length))
    .sort();
  const matching = matchMetrics({ fileIds, idPrefix: root.idPrefix, metrics: options.metrics });
  const caseSlideCounts = countSlidesPerCase(options.metrics);
  const slides: ReverseSlide[] = [];
  const missingSashaRender: string[] = [];
  for (const fileId of fileIds) {
    const id = `${root.idPrefix}${fileId}`;
    const sashaPng = join(root.directory, "slides", `${fileId}.png`);
    if (!existsSync(sashaPng)) {
      missingSashaRender.push(id);
      continue;
    }
    const metric = matching.metricByFileId.get(fileId) ?? null;
    slides.push({
      id,
      navigationLabel: navigationLabel({ fileId, metric, caseSlideCounts }),
      googlePng: join(originalsDirectory, `${fileId}.png`),
      sashaPng,
      reverseDiffPng: firstExisting([join(root.directory, "diffs", `${fileId}.png`), join(root.directory, "diffs", `diff_${fileId}.png`)]),
      fixturePng: firstExisting([
        join(root.directory, "round-trip", "originals", `${fileId}.png`),
        join(root.directory, "round-trip", `${fileId}_original.png`),
      ]),
      roundTripSashaPng: firstExisting([
        join(root.directory, "round-trip", "slides", `${fileId}.png`),
        join(root.directory, "round-trip", `${fileId}_slides.png`),
      ]),
      roundTripDiffPng: firstExisting([
        join(root.directory, "round-trip", "diffs", `${fileId}.png`),
        join(root.directory, "round-trip", "diffs", `diff_${fileId}.png`),
        join(root.directory, "round-trip", `${fileId}_diff.png`),
      ]),
      sashaHtmlFile: firstExisting([
        ...(metric?.sashaHtml ? [metric.sashaHtml] : []),
        join(root.directory, "html", `${fileId}.html`),
        join(root.directory, "sasha-html", `${fileId}.html`),
      ]),
      fixtureHtmlFile: fixtureHtmlFile({ metric, fixtureDirectories: options.fixtureDirectories }),
      googleSlidesUrl: googleSlidesUrl(metric),
      metric,
    });
  }
  return { slides, missingSashaRender, matchedMetrics: [...matching.metricByFileId.values()], problems: matching.problems };
}

type MetricMatching = Readonly<{ metricByFileId: ReadonlyMap<string, ReverseMetric>; problems: readonly string[] }>;

/**
 * Pair each screenshot with at most one metrics row. Several rows can claim the
 * same id (a set-less spelling such as "slide_01" fits both the basic and the
 * complex case); the row whose set appears in the id wins, otherwise the id stays
 * unmatched and the ambiguity is reported rather than guessed.
 */
function matchMetrics(options: Readonly<{ fileIds: readonly string[]; idPrefix: string; metrics: readonly ReverseMetric[] }>): MetricMatching {
  const caseSlideCounts = countSlidesPerCase(options.metrics);
  const claims = new Map<string, ReverseMetric[]>();
  for (const metric of options.metrics) {
    const caseSlideCount = caseSlideCounts.get(caseKey(metric)) ?? 1;
    for (const candidate of candidateSlideIds({ metric, caseSlideCount })) {
      const existing = claims.get(candidate);
      if (existing === undefined) claims.set(candidate, [metric]);
      else existing.push(metric);
    }
  }
  const metricByFileId = new Map<string, ReverseMetric>();
  const problems: string[] = [];
  for (const fileId of options.fileIds) {
    // The set may be spelled in the file name or, in a per-set layout, in the subdirectory prefix.
    const qualifiedId = `${options.idPrefix}${fileId}`;
    // In a per-set layout every root also sees the other sets' top-level rows, so a row whose set is
    // named and is not this root's can never be this screenshot, even as the only claimant: complex's
    // case `slide_17` otherwise claimed basic's `slide_17.png` and showed a 95 % mismatch on it.
    const claimants = (claims.get(fileId) ?? []).filter((metric) => options.idPrefix === "" || metric.set === "" || qualifiedId.includes(metric.set));
    const chosen = claimants.length === 1
      ? claimants[0]
      : claimants.filter((metric) => metric.set !== "" && qualifiedId.includes(metric.set)).at(0);
    if (claimants.length > 1 && chosen === undefined) {
      problems.push(`screenshot ${qualifiedId} fits ${claimants.length} metrics rows (${claimants.map(describeMetric).join(", ")}); left unmatched`);
    }
    if (chosen === undefined) continue;
    metricByFileId.set(fileId, chosen);
  }
  return { metricByFileId, problems };
}

function describeMetric(metric: ReverseMetric): string {
  return `${metric.set}/${metric.caseId}#${metric.slideNumber}`;
}

function caseKey(metric: ReverseMetric): string {
  return `${metric.set}\u0000${metric.caseId}`;
}

/** Distinct slide numbers per case: the combined top-level file repeats each set's rows, and a
 *  repeated row must not turn a one-slide case into a "two-slide" one that needs a number suffix. */
function countSlidesPerCase(metrics: readonly ReverseMetric[]): ReadonlyMap<string, number> {
  const slideNumbers = new Map<string, Set<number>>();
  for (const metric of metrics) {
    const numbers = slideNumbers.get(caseKey(metric)) ?? new Set<number>();
    numbers.add(metric.slideNumber);
    slideNumbers.set(caseKey(metric), numbers);
  }
  return new Map([...slideNumbers].map(([key, numbers]) => [key, numbers.size]));
}

/** A short nav-strip label: set initial plus the case number (single-slide cases) or slide number (decks). */
function navigationLabel(options: Readonly<{
  fileId: string;
  metric: ReverseMetric | null;
  caseSlideCounts: ReadonlyMap<string, number>;
}>): string {
  const { metric } = options;
  if (metric === null) return options.fileId.replace("slide_", "S");
  const setInitial = metric.set.slice(0, 1).toUpperCase();
  const isDeck = (options.caseSlideCounts.get(caseKey(metric)) ?? 1) > 1;
  if (isDeck) return `${setInitial}${pad({ value: metric.slideNumber, width: 2 })}`;
  const caseNumber = /\d+/.exec(metric.caseId)?.[0];
  return `${setInitial}${caseNumber ?? metric.caseId}`;
}

function fixtureHtmlFile(options: Readonly<{ metric: ReverseMetric | null; fixtureDirectories: FixtureDirectories }>): string | null {
  const { metric } = options;
  if (metric === null) return null;
  if (metric.fixtureHtml !== null && existsSync(metric.fixtureHtml)) return metric.fixtureHtml;
  const directory = fixtureDirectoryForSet({ set: metric.set, fixtureDirectories: options.fixtureDirectories });
  if (directory === null) return null;
  return firstExisting([join(directory, `${metric.caseId}.html`)]);
}

function googleSlidesUrl(metric: ReverseMetric | null): string | null {
  if (metric === null || metric.presentationId === null) return null;
  const fragment = metric.slideObjectId === null ? "" : `#slide=id.${metric.slideObjectId}`;
  return `https://docs.google.com/presentation/d/${metric.presentationId}/edit${fragment}`;
}

function firstExisting(paths: readonly string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

function pad(options: Readonly<{ value: number; width: number }>): string {
  return String(options.value).padStart(options.width, "0");
}

/** One metrics row, or the reason it was rejected. */
function parseReverseMetric(entry: unknown): ReverseMetric | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "not an object";
  const record = new Map(Object.entries(entry));
  const caseId = record.get("caseId");
  if (typeof caseId !== "string" || caseId === "") return "caseId must be a non-empty string";
  const set = record.get("set");
  const slideNumber = record.get("slideNumber");
  if (slideNumber !== undefined && (typeof slideNumber !== "number" || !Number.isInteger(slideNumber) || slideNumber < 1)) {
    return `slideNumber must be a positive integer, got ${JSON.stringify(slideNumber)}`;
  }
  return {
    caseId,
    set: typeof set === "string" ? set : "",
    slideNumber: typeof slideNumber === "number" ? slideNumber : 1,
    reverseMismatchPercent: finiteOrNull(record.get("reverseMismatchPercent")),
    roundTripMismatchPercent: finiteOrNull(record.get("roundTripMismatchPercent")),
    textMatch: textMatchFraction(record.get("textMatch")),
    notes: notesText(record.get("notes")),
    slideId: nonEmptyStringOrNull(record.get("slideId")) ?? nonEmptyStringOrNull(record.get("id")),
    presentationId: nonEmptyStringOrNull(record.get("presentationId")),
    slideObjectId: nonEmptyStringOrNull(record.get("slideObjectId")),
    fixtureHtml: nonEmptyStringOrNull(record.get("fixtureHtml")),
    sashaHtml: nonEmptyStringOrNull(record.get("sashaHtml")),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** textMatch may arrive as a fraction (0.93), a percentage (93) or a boolean; it is stored as a fraction. */
function textMatchFraction(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  const number = finiteOrNull(value);
  if (number === null) return null;
  return number > 1 ? number / 100 : number;
}

function notesText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((note): note is string => typeof note === "string").join("; ");
  return "";
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function worst(options: Readonly<{
  slides: readonly ReverseSlide[];
  pick: (metric: ReverseMetric) => number | null;
}>): Readonly<{ id: string; mismatchPercent: number }> | null {
  let result: Readonly<{ id: string; mismatchPercent: number }> | null = null;
  for (const slide of options.slides) {
    const value = slide.metric === null ? null : options.pick(slide.metric);
    if (value === null) continue;
    if (result === null || value > result.mismatchPercent) result = { id: slide.id, mismatchPercent: value };
  }
  return result;
}

function countPngs(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => name.endsWith(".png")).length;
}
