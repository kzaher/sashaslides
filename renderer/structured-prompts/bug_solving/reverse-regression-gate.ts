/**
 * reverse-regression-gate.ts — the per-fork regression gate of the REVERSE direction.
 *
 * WHY it runs in the fork and before the verdict: the forward direction's off-target gate (main.ts
 * steps 4b/4d) fails an attempt that visibly changes slides outside its cluster, so the human is
 * only asked to rate a fix that kept the rest of the deck intact. The reverse direction does the
 * same with the reverse evidence: the fork re-runs the reverse pipeline over EVERY set
 * (scripts/record-reverse.ts) and this gate compares the result with
 *   · the user's goldens (`e2e/goldens-reverse/<set>__slide_NN.png`, blessed only by the user's
 *     "Good" click): a golden slide's fresh render must still match it, and
 *   · the current metrics: no slide's reverse mismatch may rise by more than
 *     REVERSE_METRIC_RISE_LIMIT points, and
 *   · Google's thumbnail, region by region: no changed region may move further from it than
 *     REVERSE_REGION_RISE_LIMIT. The slide-wide percentage hides a tight local regression
 *     (measured 2026-10-16: slide 30's status dots drawn 1.7x too big rose its mismatch by only 0.033
 *     points, under the limit, while each dot's region rose from ~8 to ~150-200 mean error).
 * "Current" is a BASELINE render of the untouched tree that the scaffolding records once per run
 * (falling back to `.sxs-reverse/metrics.json`). Measured 2026-10-16: the canonical results already
 * lag the tree (complex__slide_30 0.243% there, 0% re-rendered) and two deck goldens differ from
 * the untouched tree's render by 18% and 23% (deck__slide_02/03 hold each other's image), so a gate
 * against the canonical numbers alone fails EVERY fork. A golden slide therefore fails only when
 * the fork moved it further from its golden than the baseline already was; pre-existing drift is
 * reported, not failed.
 * The cluster's own slides are what the fix is meant to change, so they never fail the gate; their
 * before/after numbers are reported for the verdict instead (the user rates them directly).
 *
 * The decision is a PURE function over measured numbers; the CLI (scripts/reverse-regression-gate.ts)
 * does the image comparison and file I/O and writes the ReverseGateResult JSON the fork's assert
 * step reads back with readReverseGateResult.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ChangedRegion } from "../../html2slides/reverse/changed-regions.js";

/** One slide's measured numbers, as the CLI collects them. */
export type ReverseGateSlide = Readonly<{
  /** "<set>__slide_NN". */
  id: string;
  /** The canonical run's reverse mismatch (percent); null when it had no row or no thumbnail. */
  baselineMismatchPercent: number | null;
  /** The fork's reverse mismatch (percent); null when the fork produced no measurement. */
  candidateMismatchPercent: number | null;
  /** The fork's render against the user's golden (percent); null when the slide has no golden or
   *  the fork has no render to compare. */
  goldenDriftPercent: number | null;
  /** The baseline (untouched tree) render against the same golden; null when unknown. */
  baselineGoldenDriftPercent: number | null;
  /** True when the user blessed a golden for this slide. */
  hasGolden: boolean;
  /** Where the fork's render differs from the baseline's, each region scored against Google's
   *  thumbnail before and after; empty when the renders are identical or a side is missing. */
  changedRegions: readonly ChangedRegion[];
}>;

export type ReverseGateFindingKind = "metric-rise" | "golden-drift" | "region-regression" | "missing-render";

export type ReverseGateFinding = Readonly<{ slide: string; kind: ReverseGateFindingKind; detail: string }>;

/** Before/after numbers of a cluster slide, reported to the verdict and never a failure. */
export type ReverseTargetDelta = Readonly<{ slide: string; before: number | null; after: number | null }>;

export type ReverseGateResult = Readonly<{
  ok: boolean;
  /** Non-cluster slides that regressed, sorted (what the fork's assert step fails on). */
  regressions: readonly string[];
  findings: readonly ReverseGateFinding[];
  targets: readonly ReverseTargetDelta[];
  /** Golden slides that already differed from their golden before the fix (not failures). */
  preexistingGoldenDrift: ReadonlyArray<Readonly<{ slide: string; driftPercent: number }>>;
  /** How many slides were compared, so an empty run is visible as one. */
  comparedSlides: number;
}>;

export type ReverseGateLimits = Readonly<{
  /** Percentage points a non-cluster slide's reverse mismatch may rise. */
  metricRise: number;
  /** Percent of pixels a golden slide's fresh render may differ from its golden. */
  goldenDrift: number;
  /** How far a changed region's mean error against Google may rise (0-765 per pixel). */
  regionRise: number;
  /** Changed pixels a region needs before its rise counts. */
  regionPixels: number;
}>;

export function reverseRegressionGate(options: Readonly<{
  slides: readonly ReverseGateSlide[];
  clusterSlides: readonly string[];
  limits: ReverseGateLimits;
}>): ReverseGateResult {
  const cluster = new Set(options.clusterSlides);
  const findings: ReverseGateFinding[] = [];
  const targets: ReverseTargetDelta[] = [];
  const preexistingGoldenDrift: Array<Readonly<{ slide: string; driftPercent: number }>> = [];
  for (const slide of options.slides) {
    if (slide.baselineGoldenDriftPercent !== null && slide.baselineGoldenDriftPercent > options.limits.goldenDrift) {
      preexistingGoldenDrift.push({ slide: slide.id, driftPercent: slide.baselineGoldenDriftPercent });
    }
    if (cluster.has(slide.id)) {
      targets.push({ slide: slide.id, before: slide.baselineMismatchPercent, after: slide.candidateMismatchPercent });
      continue;
    }
    findings.push(...findingsOf({ slide, limits: options.limits }));
  }
  const missingTargets = options.clusterSlides.filter((id) => !options.slides.some((slide) => slide.id === id));
  for (const id of missingTargets) targets.push({ slide: id, before: null, after: null });
  const regressions = [...new Set(findings.map((finding) => finding.slide))].sort();
  return { ok: regressions.length === 0, regressions, findings, targets, preexistingGoldenDrift, comparedSlides: options.slides.length };
}

/**
 * Read the gate's JSON back in the fork's assert step. A missing or malformed file is a failed gate
 * (never a silent pass): the gate is the only evidence the rest of the deck is intact.
 */
export function readReverseGateResult(path: string): ReverseGateResult {
  const failed = (detail: string): ReverseGateResult => ({
    ok: false,
    regressions: ["(regression gate)"],
    findings: [{ slide: "(regression gate)", kind: "missing-render", detail }],
    targets: [],
    preexistingGoldenDrift: [],
    comparedSlides: 0,
  });
  if (!existsSync(path)) return failed(`the regression gate wrote no result at ${path}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (cause) {
    return failed(`the regression gate result ${path} did not parse: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof raw !== "object" || raw === null || !("ok" in raw) || typeof raw.ok !== "boolean" || !("regressions" in raw) || !Array.isArray(raw.regressions)) {
    return failed(`the regression gate result ${path} has no ok/regressions fields`);
  }
  // Written only by scripts/reverse-regression-gate.ts from a ReverseGateResult; ok and
  // regressions were just checked, the remaining fields are reporting only.
  return raw as ReverseGateResult;
}

function findingsOf(options: Readonly<{ slide: ReverseGateSlide; limits: ReverseGateLimits }>): readonly ReverseGateFinding[] {
  const { slide, limits } = options;
  if (slide.candidateMismatchPercent === null && slide.baselineMismatchPercent !== null) {
    return [{ slide: slide.id, kind: "missing-render", detail: `measured ${slide.baselineMismatchPercent}% before the fix, nothing after it` }];
  }
  const findings: ReverseGateFinding[] = [];
  if (slide.candidateMismatchPercent !== null && slide.baselineMismatchPercent !== null) {
    const rise = slide.candidateMismatchPercent - slide.baselineMismatchPercent;
    if (rise > limits.metricRise) {
      findings.push({
        slide: slide.id,
        kind: "metric-rise",
        detail: `reverse mismatch rose ${slide.baselineMismatchPercent}% -> ${slide.candidateMismatchPercent}% (+${rise.toFixed(3)} points, limit ${limits.metricRise})`,
      });
    }
  }
  const worse = slide.changedRegions
    .filter((region) => region.changedPixels >= limits.regionPixels && region.errorAfter - region.errorBefore > limits.regionRise)
    .sort((first, second) => (second.errorAfter - second.errorBefore) - (first.errorAfter - first.errorBefore));
  if (worse.length > 0) {
    const shown = worse.slice(0, 3).map((region) =>
      `${region.width}x${region.height} px at (${region.x}, ${region.y}) ${region.errorBefore} -> ${region.errorAfter}`).join("; ");
    findings.push({
      slide: slide.id,
      kind: "region-regression",
      detail: `${worse.length} changed region(s) moved away from Google's thumbnail (mean RGB error before -> after, limit +${limits.regionRise}): ${shown}${worse.length > 3 ? "; …" : ""}`,
    });
  }
  if (slide.hasGolden && slide.goldenDriftPercent === null) {
    findings.push({ slide: slide.id, kind: "missing-render", detail: "the user blessed a golden but the fork rendered nothing to compare" });
  }
  const baselineDrift = slide.baselineGoldenDriftPercent ?? 0;
  if (slide.goldenDriftPercent !== null && slide.goldenDriftPercent > limits.goldenDrift && slide.goldenDriftPercent - baselineDrift > limits.goldenDrift) {
    findings.push({
      slide: slide.id,
      kind: "golden-drift",
      detail: `the render now differs from the user's golden by ${slide.goldenDriftPercent}% of pixels (${baselineDrift}% before the fix, limit ${limits.goldenDrift})`,
    });
  }
  return findings;
}
