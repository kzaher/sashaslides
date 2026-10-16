/**
 * reverse-direction.ts — the REVERSE direction of the bug_solving process, as pure data + command
 * builders the shared machinery (clusters, jailed overlay forks, verdicts, per-fork rating, merge)
 * consumes.
 *
 * WHY a direction and not a separate tool: the user rates the reverse SxS round trip
 * (Google Slides -> Sasha import -> Sasha HTML) in the same rating UI as the forward one, and asked
 * for its BAD slides to be resolved by the same structured-prompting process. So the reverse
 * direction swaps only what differs:
 *   · WHERE the issues come from — `.sxs-reverse/ratings-reverse.json`, keyed "<set>__slide_NN",
 *     with the annotation drawn over the SASHA render (not over the target);
 *   · WHICH code owns the defect — the importer (mcp/sasha-slides/google-slides), the engine
 *     renderer (engine/src/view/render) and the HTML export (engine/src/export/slide-html.ts);
 *   · HOW an attempt is recorded — the reverse pipeline (reverse-sxs.sh --offline) re-run from the
 *     fork, into the fork's SHARED dir. Host Chrome screenshots the exported page by file address,
 *     and only the shared dir (outside the overlay) is visible to both the jail and host Chrome;
 *   · WHAT the regression gate compares — the user's goldens-reverse and the current metrics.json.
 * Everything else (overlay forks, retries, verdict parsing, blocking rating, LLM merge) is shared.
 *
 * Goldens stay user-only: nothing here writes `e2e/goldens-reverse/`, and the fork's rating UI is
 * pointed at a goldens directory inside the fork's shared dir so a "Good" click on an UNMERGED fix
 * can never bless the user's goldens.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ALL_SETS,
  setLayoutOf,
  type ReverseSet,
  type SlideMetrics,
} from "../../html2slides/reverse/reverse-results.js";
import { issueKeyword } from "./generate-clusters.js";
import { makeAnnotationComposite } from "./scripts/annotation-composite.js";
import type { SlideTask } from "./main.js";
import type { Cluster } from "./workspace-setup.js";

/** Which round trip a solve run repairs. Forward = HTML -> Google Slides (the default). */
export type SolveDirection = "forward" | "reverse";

/** Where the reverse direction reads its inputs and keeps its own ledger. */
export type ReversePaths = Readonly<{
  /** The canonical reverse results (`.sxs-reverse`): Google thumbnails, Sasha renders, metrics. */
  resultsRoot: string;
  /** The user's reverse verdicts, keyed "<set>__slide_NN". Read only. */
  ratingsFile: string;
  /** The user's blessed reverse goldens, "<set>__slide_NN.png". Read only, ever. */
  goldensDirectory: string;
  /** The reverse candidate/demotion ledger, kept apart from the forward one so reverse ids never
   *  enter the forward reconcile. */
  historyDirectory: string;
}>;

/** One reverse slide id ("complex__slide_05") split into its set and file id. */
export type ReverseSlideReference = Readonly<{ id: string; set: ReverseSet; fileId: string }>;

/** What the reverse worker, verdict and gate need beyond the shared SlideTask fields. */
export type ReverseSlideContext = Readonly<{
  set: ReverseSet;
  /** `slide_NN`, the file id inside the set's results directory. */
  file_id: string;
  /** The current (pre-fix) Sasha export of the slide: one self-contained HTML page. */
  sasha_html: string;
  /** The fixture HTML the forward deck was made from; null for the deck set, which has none. */
  fixture_html: string | null;
  /** The imported document (snapshot.json), the import's losses (losses.json) and Google's answer. */
  import_directory: string;
  /** The user's zoom crops of the marked regions (original / rendered / fixture per region). */
  zoom_crops: readonly string[];
  /** The slide's current metrics.json row; null when the canonical run has none. */
  baseline_metrics: SlideMetrics | null;
}>;

/** The most a NON-cluster slide's reverse mismatch may rise, in percentage points, before the
 *  regression gate fails the attempt. Matches the user's instruction ("no slide may rise by more
 *  than 0.05 points"). */
export const REVERSE_METRIC_RISE_LIMIT = 0.05;

/** The most a golden slide's fresh render may differ from the user's golden, in percent of pixels
 *  after reverse-metrics.ts's blur. An unchanged render measures 0. */
export const REVERSE_GOLDEN_DRIFT_LIMIT = 0.05;

/** The Chrome the reverse pipeline screenshots with. The canonical results were captured on the
 *  container Chrome (:9223), and solve.sh starts a headless one there when it is absent. */
export const DEFAULT_REVERSE_CHROME_PORT = 9223;

/** Repository-relative script paths the reverse fork runs. */
export const REVERSE_SCRIPTS = {
  record: "renderer/structured-prompts/bug_solving/scripts/record-reverse.ts",
  gate: "renderer/structured-prompts/bug_solving/scripts/reverse-regression-gate.ts",
  ratingServer: "renderer/html2slides/rating-server.ts",
  pipeline: "renderer/html2slides/reverse-sxs.sh",
} as const;

/** Repository-relative files a reverse fix may change; the LLM merge folds exactly these. */
export function isReverseFixFile(relativePath: string): boolean {
  return (
    /^mcp\/sasha-slides\/google-slides\/[^/]+\.ts$/.test(relativePath) ||
    /^mcp\/sasha-slides\/engine\/src\/.+\.tsx?$/.test(relativePath) ||
    // The forward converter, for the rare comment that is about the forward deck itself.
    /^renderer\/html2slides\/[^/]+\.ts$/.test(relativePath)
  );
}

export function defaultReversePaths(repositoryRoot: string): ReversePaths {
  const resultsRoot = join(repositoryRoot, ".sxs-reverse");
  return {
    resultsRoot,
    ratingsFile: join(resultsRoot, "ratings-reverse.json"),
    goldensDirectory: join(repositoryRoot, "renderer", "html2slides", "e2e", "goldens-reverse"),
    historyDirectory: join(repositoryRoot, ".bug-solving-history-reverse"),
  };
}

/** Parse a --direction value at the command-line boundary. */
export function parseSolveDirection(text: string): SolveDirection {
  // A parse-boundary guard over an untrusted string: add new directions here by hand.
  if (text === "forward" || text === "reverse") return text;
  throw new Error(`--direction must be "forward" or "reverse" (got "${text}")`);
}

/**
 * Clusters from the user's reverse verdicts: one per slide rated BAD, sorted by set then slide, with
 * the user's comment verbatim in the description. Grouping is opt-in (--clusters), exactly as in the
 * forward direction, because a wrong grouping costs a regression.
 */
export function clustersFromReverseRatings(options: Readonly<{ ratingsPath: string; retryBudget: number | null }>): Cluster[] {
  const ratings = readReverseRatings(options.ratingsPath);
  const usedSlugs = new Map<string, number>();
  const bad = [...ratings.entries()]
    .filter(([, rating]) => rating.status === "bad")
    .map(([id, rating]) => ({ reference: parseReverseSlideId(id), rating }))
    .filter((entry): entry is { reference: ReverseSlideReference; rating: ReverseRating } => entry.reference !== null)
    .sort((left, right) => compareReferences(left.reference, right.reference));
  return bad.map(({ reference, rating }) => {
    const issue = rating.comment.trim();
    const baseSlug = reverseTaskSlug({ reference, issue });
    const seen = usedSlugs.get(baseSlug) ?? 0;
    usedSlugs.set(baseSlug, seen + 1);
    return {
      task_id: seen > 0 ? `${baseSlug}-${seen + 1}` : baseSlug,
      slide_ids: [reference.id],
      cluster_description: `${reference.id} (reverse: Google Slides -> Sasha HTML) — ${issue || "(no comment)"}${REVERSE_FOOTER}`,
      ...(options.retryBudget !== null && options.retryBudget >= 1 ? { retry_budget: options.retryBudget } : {}),
    };
  });
}

/** "complex__slide_05" -> { set: "complex", fileId: "slide_05" }; anything else -> null. */
export function parseReverseSlideId(id: string): ReverseSlideReference | null {
  const match = /^([a-z]+)__(slide_\d+)$/.exec(id);
  if (match === null) return null;
  const set = ALL_SETS.find((candidate) => candidate === match[1]);
  const fileId = match[2];
  if (set === undefined || fileId === undefined) return null;
  return { id, set, fileId };
}

/** A readable, unique-per-slide task slug: "reverse-complex-slide-05-stars-different". */
export function reverseTaskSlug(options: Readonly<{ reference: ReverseSlideReference; issue: string }>): string {
  return `reverse-${options.reference.set}-${options.reference.fileId.replace(/_/g, "-")}-${issueKeyword(options.issue)}`;
}

/**
 * The --clusters member key for reverse ids. A group may name a slide as "complex__slide_05" or,
 * when only one BAD slide has that number, as "slide_05" / "05". An ambiguous bare number (BAD in
 * two sets) is an error naming the candidates rather than a guess.
 */
export function reverseClusterMemberKey(badIds: readonly string[]): (reference: string) => string {
  return (reference) => {
    if (badIds.includes(reference)) return reference;
    const number = Number(reference.replace(/[^0-9]/g, ""));
    if (!Number.isFinite(number) || reference.includes("__")) return reference;
    const matches = badIds.filter((id) => Number(parseReverseSlideId(id)?.fileId.replace(/[^0-9]/g, "") ?? Number.NaN) === number);
    if (matches.length > 1) {
      throw new Error(`--clusters: "${reference}" is ambiguous in reverse mode (${matches.join(", ")}); name the set, e.g. "${matches[0]}"`);
    }
    return matches[0] ?? reference;
  };
}

/**
 * The SlideTask records for a reverse cluster. The TARGET is Google's thumbnail (`originals/`), the
 * ATTEMPT the current Sasha render (`slides/`). The user drew the annotation over the SASHA render,
 * so the max-contrast composite is built over that render, not over the target.
 */
export function buildReverseSlideTasks(options: Readonly<{
  slideIds: readonly string[];
  paths: ReversePaths;
  repositoryRoot: string;
  /** Where the annotation composites are written (a scratch dir; never the results root). */
  compositesDirectory: string;
}>): SlideTask[] {
  const ratings = readReverseRatings(options.paths.ratingsFile);
  const baselineMetrics = readMetricsRows(join(options.paths.resultsRoot, "metrics.json"));
  return options.slideIds.map((id): SlideTask => {
    const reference = parseReverseSlideId(id);
    if (reference === null) throw new Error(`not a reverse slide id: "${id}" (expected "<set>__slide_NN")`);
    const layout = setLayoutOf({ outputRoot: options.paths.resultsRoot, set: reference.set });
    const rating = ratings.get(id) ?? { status: "", comment: "", annotation: null };
    const metrics = baselineMetrics.find((row) => row.set === reference.set && row.slideId === reference.fileId) ?? null;
    const sashaHtml = join(layout.html, `${reference.fileId}.html`);
    const fixtureHtml = fixtureHtmlOf({ reference, metrics, repositoryRoot: options.repositoryRoot });
    const renderedPng = join(layout.slides, `${reference.fileId}.png`);
    const annotation = annotationOf({ rating, id, resultsRoot: options.paths.resultsRoot });
    const compositePath = join(options.compositesDirectory, `${id}.png`);
    const composite = annotation !== null && makeAnnotationComposite(renderedPng, annotation, compositePath) ? compositePath : undefined;
    return {
      slide_id: id,
      html_file: fixtureHtml ?? sashaHtml,
      user_comment: rating.comment,
      ...(annotation !== null ? { annotation_png: annotation } : {}),
      ...(composite !== undefined ? { composite_png: composite } : {}),
      rendered_png: renderedPng,
      original_png: join(layout.originals, `${reference.fileId}.png`),
      reverse: {
        set: reference.set,
        file_id: reference.fileId,
        sasha_html: sashaHtml,
        fixture_html: fixtureHtml,
        import_directory: layout.importDirectory,
        zoom_crops: zoomCropsOf({ id, resultsRoot: options.paths.resultsRoot }),
        baseline_metrics: metrics,
      },
    };
  });
}

/** The reverse sets a list of reverse slide ids touches, in ALL_SETS order. */
export function reverseSetsOf(slideIds: readonly string[]): readonly ReverseSet[] {
  const sets = new Set(slideIds.map((id) => parseReverseSlideId(id)?.set).filter((set): set is ReverseSet => set !== undefined));
  return ALL_SETS.filter((set) => sets.has(set));
}

/**
 * The reverse pipeline's argv (after `bash reverse-sxs.sh`) for one fork recording. Always
 * --offline: the fork re-measures from the recorded presentation, export, thumbnails and pictures,
 * so a fix is judged against exactly the Google side the user rated and no quota is spent.
 * `slideIds` null = every slide of every set (the regression gate); otherwise only those slides.
 */
export function reversePipelineArguments(options: Readonly<{
  outputDirectory: string;
  slideIds: readonly string[] | null;
  chromePort: number;
}>): readonly string[] {
  const sets = options.slideIds === null ? ALL_SETS : reverseSetsOf(options.slideIds);
  return [
    "--offline",
    "--sets", sets.join(","),
    "--output", options.outputDirectory,
    "--chrome-port", String(options.chromePort),
    ...(options.slideIds === null ? [] : ["--slides", options.slideIds.join(",")]),
  ];
}

/** Paths one reverse fork writes into its SHARED dir (outside the overlay, so host Chrome and the
 *  final merge can read them). Cleared and rewritten on every attempt. */
export type ReverseForkPaths = Readonly<{
  /** The cluster's slides re-rendered from the fork: the rating UI's results dir. */
  attempt: string;
  /** Every set re-rendered from the fork: the regression gate's input. */
  everySet: string;
  /** The regression gate's verdict (reverse-regression-gate.ts's ReverseGateResult). */
  gateResult: string;
  /** Where a "Good" click in the fork's rating UI blesses to: never the user's goldens. */
  forkGoldens: string;
}>;

export function reverseForkPaths(sharedDirectory: string): ReverseForkPaths {
  const root = join(sharedDirectory, "reverse");
  return {
    attempt: join(root, "attempt"),
    everySet: join(root, "every-set"),
    gateResult: join(root, "regression-gate.json"),
    forkGoldens: join(root, "fork-goldens-reverse"),
  };
}

/**
 * The run's BASELINE: every set rendered once from the UNTOUCHED tree by the scaffolding, before
 * any worker runs (the reverse twin of the forward `before-all`). It sits next to the run's task
 * shared dirs, so every fork's regression gate reads the same one. The canonical .sxs-reverse is
 * the fallback when it is missing: it can lag the tree (see reverse-regression-gate.ts).
 */
export function reverseBaselineDirectory(taskSharedDirectory: string): string {
  return join(dirname(taskSharedDirectory), "reverse-baseline");
}

/**
 * The argv (after `npx tsx rating-server.ts`) of a fork's own reverse rating UI: reverse mode on
 * the fork's attempt results, only the cluster's slides, verdict-only (--read-only), exiting once
 * every slide is rated (so the node running it IS the block), recording a CANDIDATE verdict into
 * the reverse ledger, and blessing a "Good" into the fork's own goldens directory — never into the
 * user's e2e/goldens-reverse/.
 */
export function reverseRatingServerArguments(options: Readonly<{
  attemptDirectory: string;
  port: number;
  slides: readonly string[];
  analysisPath: string;
  taskTitle: string;
  forkGoldensDirectory: string;
  historyDirectory: string;
}>): readonly string[] {
  return [
    options.attemptDirectory,
    "--direction", "reverse",
    "--port", String(options.port),
    "--filter-slides", options.slides.join(","),
    "--read-only",
    "--exit-when-all-rated",
    "--task-analysis", options.analysisPath,
    "--task-title", options.taskTitle,
    "--reverse-goldens-dir", options.forkGoldensDirectory,
    "--history-dir", options.historyDirectory,
    "--candidate",
  ];
}

/** The fork's fresh render and export of one slide inside a reverse results directory. */
export function reverseRenderOf(options: Readonly<{ resultsDirectory: string; slideId: string }>): Readonly<{ png: string; html: string; metrics: string }> | null {
  const reference = parseReverseSlideId(options.slideId);
  if (reference === null) return null;
  const layout = setLayoutOf({ outputRoot: options.resultsDirectory, set: reference.set });
  return {
    png: join(layout.slides, `${reference.fileId}.png`),
    html: join(layout.html, `${reference.fileId}.html`),
    metrics: layout.metricsPath,
  };
}

/** The worker's solving footer: where a reverse defect lives and how to check a fix. */
const REVERSE_FOOTER =
  "\n\nApproach: compare the TARGET (Google Slides thumbnail) with the ATTEMPT (Sasha HTML render) and the " +
  "user's annotation, read the exported Sasha HTML and the imported snapshot, find the ROOT CAUSE in the " +
  "importer (mcp/sasha-slides/google-slides/import-*.ts), the engine renderer " +
  "(mcp/sasha-slides/engine/src/view/render/) or the HTML export (mcp/sasha-slides/engine/src/export/slide-html.ts), " +
  "apply the MINIMAL fix, and DO NOT regress other slides of any set.";

type ReverseRating = Readonly<{ status: string; comment: string; annotation: string | null }>;

function readReverseRatings(path: string): ReadonlyMap<string, ReverseRating> {
  if (!existsSync(path)) return new Map();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return new Map(); }
  if (typeof raw !== "object" || raw === null) return new Map();
  const ratings = new Map<string, ReverseRating>();
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const status = "status" in value && typeof value.status === "string" ? value.status.toLowerCase() : "";
    const comment = "comment" in value && typeof value.comment === "string" ? value.comment : "";
    const annotation = "annotation" in value && typeof value.annotation === "string" ? value.annotation : null;
    ratings.set(id, { status, comment, annotation });
  }
  return ratings;
}

function compareReferences(left: ReverseSlideReference, right: ReverseSlideReference): number {
  const bySet = ALL_SETS.indexOf(left.set) - ALL_SETS.indexOf(right.set);
  if (bySet !== 0) return bySet;
  return Number(left.fileId.replace(/[^0-9]/g, "")) - Number(right.fileId.replace(/[^0-9]/g, ""));
}

function readMetricsRows(path: string): readonly SlideMetrics[] {
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    // metrics.json is written only by reverse-roundtrip.ts, as an array of SlideMetrics.
    return Array.isArray(raw) ? (raw as readonly SlideMetrics[]) : [];
  } catch {
    return [];
  }
}

function fixtureHtmlOf(options: Readonly<{ reference: ReverseSlideReference; metrics: SlideMetrics | null; repositoryRoot: string }>): string | null {
  const directory = fixtureDirectoryOf({ set: options.reference.set, repositoryRoot: options.repositoryRoot });
  if (directory === null) return null;
  // Slide N is fixture N (reverse-set.ts); the metrics row names the fixture by its case id.
  const caseId = options.metrics?.caseId ?? options.reference.fileId;
  const path = resolve(directory, `${caseId}.html`);
  return existsSync(path) ? path : null;
}

function fixtureDirectoryOf(options: Readonly<{ set: ReverseSet; repositoryRoot: string }>): string | null {
  switch (options.set) {
    case "basic":
      return join(options.repositoryRoot, "renderer", "html2slides", "e2e", "fixtures-basic");
    case "complex":
      return join(options.repositoryRoot, "renderer", "html2slides", "e2e", "fixtures");
    case "deck":
      return null;
    default:
      return assertNever(options.set);
  }
}

function annotationOf(options: Readonly<{ rating: ReverseRating; id: string; resultsRoot: string }>): string | null {
  if (options.rating.annotation !== null && existsSync(options.rating.annotation)) return options.rating.annotation;
  const conventional = join(options.resultsRoot, "annotations", `${options.id}.png`);
  return existsSync(conventional) ? conventional : null;
}

function zoomCropsOf(options: Readonly<{ id: string; resultsRoot: string }>): readonly string[] {
  const directory = join(options.resultsRoot, "zoom-crops");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${options.id}-`) && name.endsWith(".png"))
    .sort()
    .map((name) => join(directory, name));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
