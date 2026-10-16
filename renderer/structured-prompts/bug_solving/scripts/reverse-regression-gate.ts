#!/usr/bin/env npx tsx
/**
 * reverse-regression-gate.ts — CLI of the reverse direction's per-fork regression gate
 * (../reverse-regression-gate.ts has the decision and why it exists).
 *
 * It measures, it does not decide: for every slide of every set it collects the baseline reverse
 * mismatch, the fork's reverse mismatch, and (for a slide the user blessed) both renders against
 * the user's golden, then hands the numbers to reverseRegressionGate and writes the result.
 * --baseline is a reverse results directory of the UNTOUCHED tree (the run's baseline recording,
 * or the canonical .sxs-reverse when that is missing): its metrics.json and <set>/slides/.
 * The goldens directory is only READ; nothing here writes goldens.
 *
 *   npx tsx reverse-regression-gate.ts --results <fork every-set dir> --baseline <baseline results dir>
 *     --goldens <renderer/html2slides/e2e/goldens-reverse> --cluster complex__slide_05[,…] --out <result.json>
 *     [--metric-rise 0.05] [--golden-drift 0.05]
 *
 * ALWAYS exits 0 and always writes --out: a crash is recorded as a failed gate, so the fork's assert
 * step fails the attempt with the reason instead of the shell node dying without one.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { compareImages, type RgbaImage } from "../../../html2slides/reverse/reverse-metrics.js";
import { setLayoutOf, type SlideMetrics } from "../../../html2slides/reverse/reverse-results.js";
import { parseReverseSlideId, REVERSE_GOLDEN_DRIFT_LIMIT, REVERSE_METRIC_RISE_LIMIT } from "../reverse-direction.js";
import { reverseRegressionGate, type ReverseGateResult, type ReverseGateSlide } from "../reverse-regression-gate.js";

type GateArguments = Readonly<{
  results: string;
  baseline: string;
  goldens: string;
  cluster: readonly string[];
  out: string;
  metricRise: number;
  goldenDrift: number;
}>;

function main(): void {
  const parsed = parseArguments(process.argv.slice(2));
  const result = reverseRegressionGate({
    slides: measuredSlides(parsed),
    clusterSlides: parsed.cluster,
    limits: { metricRise: parsed.metricRise, goldenDrift: parsed.goldenDrift },
  });
  writeResult({ path: parsed.out, result });
  console.error(
    `[reverse-gate] ${result.ok ? "PASS" : "FAIL"}: compared ${result.comparedSlides} slide(s); ` +
      `regressions [${result.regressions.join(", ")}]; targets ${result.targets.map((target) => `${target.slide} ${target.before ?? "n/a"}% -> ${target.after ?? "n/a"}%`).join("; ")}`,
  );
  for (const finding of result.findings) console.error(`  ${finding.slide} ${finding.kind}: ${finding.detail}`);
  for (const drift of result.preexistingGoldenDrift) console.error(`  (pre-existing, not failed) ${drift.slide} already ${drift.driftPercent}% from its golden before the fix`);
}

function measuredSlides(parsed: GateArguments): readonly ReverseGateSlide[] {
  const baseline = metricsById(join(parsed.baseline, "metrics.json"));
  const candidate = metricsById(join(parsed.results, "metrics.json"));
  const goldens = existsSync(parsed.goldens)
    ? new Set(readdirSync(parsed.goldens).filter((name) => name.endsWith(".png")).map((name) => name.slice(0, -".png".length)))
    : new Set<string>();
  const ids = [...new Set([...baseline.keys(), ...candidate.keys(), ...goldens])].filter((id) => parseReverseSlideId(id) !== null).sort();
  return ids.map((id) => ({
    id,
    baselineMismatchPercent: baseline.get(id)?.reverseMismatchPercent ?? null,
    candidateMismatchPercent: candidate.get(id)?.reverseMismatchPercent ?? null,
    hasGolden: goldens.has(id),
    goldenDriftPercent: goldens.has(id) ? goldenDrift({ id, goldens: parsed.goldens, results: parsed.results }) : null,
    baselineGoldenDriftPercent: goldens.has(id) ? goldenDrift({ id, goldens: parsed.goldens, results: parsed.baseline }) : null,
  }));
}

function metricsById(path: string): ReadonlyMap<string, SlideMetrics> {
  if (!existsSync(path)) return new Map();
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  // metrics.json is written only by reverse-roundtrip.ts, as an array of SlideMetrics.
  const rows = Array.isArray(raw) ? (raw as readonly SlideMetrics[]) : [];
  return new Map(rows.map((row) => [`${row.set}__${row.slideId}`, row]));
}

function goldenDrift(options: Readonly<{ id: string; goldens: string; results: string }>): number | null {
  const reference = parseReverseSlideId(options.id);
  if (reference === null) return null;
  const render = join(setLayoutOf({ outputRoot: options.results, set: reference.set }).slides, `${reference.fileId}.png`);
  if (!existsSync(render)) return null;
  const goldenBytes = readFileSync(join(options.goldens, `${options.id}.png`));
  const renderBytes = readFileSync(render);
  // Chrome renders the same page byte-identically (measured: the fresh offline render of complex
  // slide_14 matched the canonical PNG byte for byte), so identical files skip the ~0.4 s blur +
  // pixelmatch; only a changed render is compared.
  if (goldenBytes.equals(renderBytes)) return 0;
  return compareImages({ expected: decodePng(goldenBytes), actual: decodePng(renderBytes) }).mismatchPercent;
}

function decodePng(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

function writeResult(options: Readonly<{ path: string; result: ReverseGateResult }>): void {
  mkdirSync(dirname(options.path), { recursive: true });
  writeFileSync(options.path, `${JSON.stringify(options.result, null, 2)}\n`);
}

function parseArguments(argv: readonly string[]): GateArguments {
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  const required = (name: string): string => {
    const found = value(name);
    if (found === null || found.length === 0) throw new Error(`${name} is required`);
    return found;
  };
  const limit = (name: string, fallback: number): number => {
    const found = value(name);
    const parsed = found === null ? fallback : Number(found);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
    return parsed;
  };
  return {
    results: required("--results"),
    baseline: required("--baseline"),
    goldens: required("--goldens"),
    cluster: (value("--cluster") ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0),
    out: required("--out"),
    metricRise: limit("--metric-rise", REVERSE_METRIC_RISE_LIMIT),
    goldenDrift: limit("--golden-drift", REVERSE_GOLDEN_DRIFT_LIMIT),
  };
}

try {
  main();
} catch (cause) {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  console.error(`[reverse-gate] FAILED: ${message}`);
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (out !== undefined) {
    writeResult({
      path: out,
      result: {
        ok: false,
        regressions: ["(regression gate)"],
        findings: [{ slide: "(regression gate)", kind: "missing-render", detail: `the gate crashed: ${message.split("\n")[0] ?? message}` }],
        targets: [],
        preexistingGoldenDrift: [],
        comparedSlides: 0,
      },
    });
  }
}
