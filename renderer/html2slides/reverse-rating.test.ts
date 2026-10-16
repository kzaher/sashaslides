/**
 * reverse-rating.test.ts — unit tests for the reverse SxS model (reverse-rating.ts).
 *
 * Why: the rating server's reverse mode is only as trustworthy as the mapping from
 * a results directory to slides. These tests pin the parts that can silently go
 * wrong: metrics parsing at the boundary, matching a metrics row to a screenshot
 * under the spellings a pipeline may use, the per-set directory layout, and the
 * goldens guard that keeps a reverse bless out of the forward goldens.
 *
 * Run: npx tsx --test renderer/html2slides/reverse-rating.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertReverseGoldensDirectory,
  blessReverseGolden,
  candidateSlideIds,
  findReverseSlide,
  fixtureDirectoryForSet,
  isReverseDirection,
  parseRatingDirection,
  parseReverseMetrics,
  parseReverseView,
  scanReverseResults,
  summarizeReverse,
  type FixtureDirectories,
  type ReverseMetric,
} from "./reverse-rating.js";
import { fakeReverseCases, writeFakeReverseResults } from "./reverse-rating-fake-results.js";

test("parseRatingDirection accepts the two directions and rejects anything else", () => {
  assert.equal(parseRatingDirection("forward"), "forward");
  assert.equal(parseRatingDirection("reverse"), "reverse");
  assert.throws(() => parseRatingDirection("backward"), /forward" or "reverse/);
  assert.equal(isReverseDirection("reverse"), true);
  assert.equal(isReverseDirection("forward"), false);
});

test("parseReverseView treats anything but round-trip as the reverse step", () => {
  const rows: ReadonlyArray<Readonly<{ input: unknown; expected: string }>> = [
    { input: "round-trip", expected: "round-trip" },
    { input: "reverse", expected: "reverse" },
    { input: undefined, expected: "reverse" },
    { input: 7, expected: "reverse" },
  ];
  for (const row of rows) assert.equal(parseReverseView(row.input), row.expected, JSON.stringify(row.input));
});

test("assertReverseGoldensDirectory refuses the forward goldens directories", () => {
  const rows: ReadonlyArray<Readonly<{ directory: string; refused: boolean }>> = [
    { directory: "/repo/renderer/html2slides/e2e/goldens", refused: true },
    { directory: "/repo/renderer/html2slides/e2e/goldens-complex", refused: true },
    { directory: "/repo/renderer/html2slides/e2e/goldens-reverse", refused: false },
    { directory: "/tmp/test-goldens", refused: false },
  ];
  for (const row of rows) {
    if (row.refused) assert.throws(() => assertReverseGoldensDirectory(row.directory), /forward goldens/, row.directory);
    else assert.doesNotThrow(() => assertReverseGoldensDirectory(row.directory), row.directory);
  }
});

test("parseReverseMetrics keeps good rows, normalises textMatch and reports bad rows", () => {
  const reading = parseReverseMetrics({
    source: "metrics.json",
    raw: [
      { caseId: "slide_01", set: "basic", slideNumber: 1, reverseMismatchPercent: 1.5, roundTripMismatchPercent: null, textMatch: 0.9, notes: "x" },
      { caseId: "slide_02", set: "basic", slideNumber: 1, textMatch: 93, notes: ["a", "b"] },
      { caseId: "slide_03", set: "basic", textMatch: true },
      { set: "basic", slideNumber: 1 },
      { caseId: "slide_04", slideNumber: 0 },
      "not a row",
    ],
  });
  assert.equal(reading.metrics.length, 3);
  assert.equal(reading.problems.length, 3);
  const [first, second, third] = reading.metrics;
  assert.equal(first?.reverseMismatchPercent, 1.5);
  assert.equal(first?.roundTripMismatchPercent, null);
  assert.equal(first?.textMatch, 0.9);
  assert.equal(second?.textMatch, 0.93);
  assert.equal(second?.notes, "a; b");
  assert.equal(third?.textMatch, 1);
  assert.equal(third?.slideNumber, 1);
  assert.deepEqual(parseReverseMetrics({ source: "m", raw: { not: "an array" } }).metrics, []);
});

test("candidateSlideIds covers the spellings a pipeline may write, and only the explicit id when given", () => {
  const metric = parsedMetric({ caseId: "slide_07", set: "complex", slideNumber: 3 });
  const rows: ReadonlyArray<Readonly<{ id: string; caseSlideCount: number; expected: boolean }>> = [
    { id: "complex__slide_07__03", caseSlideCount: 5, expected: true },
    { id: "complex-slide_07-3", caseSlideCount: 5, expected: true },
    { id: "slide_07_slide_003", caseSlideCount: 5, expected: true },
    { id: "complex__slide_07", caseSlideCount: 5, expected: false },
    // A single-slide case may be written with no slide suffix at all: the control row above shows the suffix is required otherwise.
    { id: "complex__slide_07", caseSlideCount: 1, expected: true },
    { id: "slide_07", caseSlideCount: 1, expected: true },
    { id: "basic__slide_07", caseSlideCount: 1, expected: false },
  ];
  for (const row of rows) {
    assert.equal(candidateSlideIds({ metric, caseSlideCount: row.caseSlideCount }).includes(row.id), row.expected, row.id);
  }
  const explicit = parsedMetric({ caseId: "slide_07", set: "complex", slideNumber: 3, slideId: "custom_name" });
  assert.deepEqual(candidateSlideIds({ metric: explicit, caseSlideCount: 5 }), ["custom_name"]);
});

test("fixtureDirectoryForSet maps the free-text set onto a fixture directory", () => {
  const fixtureDirectories: FixtureDirectories = { basic: "/b", complex: "/c" };
  const rows: ReadonlyArray<Readonly<{ set: string; expected: string | null }>> = [
    { set: "basic", expected: "/b" },
    { set: "fixtures-basic", expected: "/b" },
    { set: "complex", expected: "/c" },
    { set: "fixtures", expected: "/c" },
    { set: "google", expected: null },
  ];
  for (const row of rows) assert.equal(fixtureDirectoryForSet({ set: row.set, fixtureDirectories }), row.expected, row.set);
});

test("scanReverseResults pairs the fake layout with its metrics and reports the failed render", () => {
  const { directory, fixtureDirectories } = fakeWorkspace();
  const scan = scanReverseResults({ resultsDirectory: directory, fixtureDirectories });
  const expectedIds = fakeReverseCases.filter((fakeCase) => fakeCase.hasSashaRender).map((fakeCase) => fakeCase.id).sort();
  assert.deepEqual(scan.slides.map((slide) => slide.id).sort(), expectedIds);
  assert.deepEqual(scan.missingSashaRender, ["complex__slide_09"]);
  assert.deepEqual(scan.problems, []);
  for (const slide of scan.slides) {
    const fakeCase = fakeReverseCases.find((candidate) => candidate.id === slide.id);
    assert.ok(fakeCase, slide.id);
    assert.equal(slide.metric?.caseId, fakeCase.caseId, `${slide.id} metric`);
    assert.equal(slide.metric?.slideNumber, fakeCase.slideNumber, `${slide.id} slide number`);
    assert.equal(slide.fixturePng !== null, fakeCase.hasRoundTrip, `${slide.id} round trip`);
    assert.ok(slide.sashaHtmlFile?.endsWith(`${slide.id}.html`), `${slide.id} html`);
  }
  const basic = scan.slides.find((slide) => slide.id === "basic__slide_01_solid_rect");
  assert.equal(basic?.fixtureHtmlFile, join(fixtureDirectories.basic, "slide_01_solid_rect.html"));
  assert.equal(basic?.navigationLabel, "B01");
  assert.equal(scan.slides.find((slide) => slide.id === "google__test_deck__02")?.navigationLabel, "G02");
});

test("scanReverseResults reads one layout per subdirectory and prefixes ids with it", () => {
  const root = mkdtempSync(join(tmpdir(), "reverse-rating-sets-"));
  const fixtureDirectories: FixtureDirectories = { basic: join(root, "no-basic"), complex: join(root, "no-complex") };
  for (const set of ["basic", "complex"]) {
    mkdirSync(join(root, set, "originals"), { recursive: true });
    mkdirSync(join(root, set, "slides"), { recursive: true });
    writeFileSync(join(root, set, "originals", "slide_01.png"), "png");
    writeFileSync(join(root, set, "slides", "slide_01.png"), "png");
  }
  // Both sets name their file slide_01; the top-level rows are told apart by the subdirectory prefix.
  writeFileSync(join(root, "metrics.json"), JSON.stringify([
    { caseId: "slide_01", set: "basic", slideNumber: 1, reverseMismatchPercent: 1 },
    { caseId: "slide_01", set: "complex", slideNumber: 1, reverseMismatchPercent: 9 },
  ]));
  const scan = scanReverseResults({ resultsDirectory: root, fixtureDirectories });
  assert.deepEqual(scan.slides.map((slide) => [slide.id, slide.metric?.reverseMismatchPercent]), [
    ["basic__slide_01", 1],
    ["complex__slide_01", 9],
  ]);
  assert.deepEqual(scan.problems, []);
});

// The layout reverse-roundtrip.ts really writes: each set has its own metrics.json and the root a
// combined copy. Complex's case id `slide_17` used to be the ONLY claimant of basic's slide_17.png
// (basic's own case ids carry a suffix, `slide_17_table_rounded`), so basic's slide showed complex's
// 95 % mismatch and the deck mean read 8.3 % instead of 5.1 %.
test("a per-set root never takes another set's row, even when it is the only claimant", () => {
  const root = mkdtempSync(join(tmpdir(), "reverse-rating-cross-set-"));
  const fixtureDirectories: FixtureDirectories = { basic: join(root, "no-basic"), complex: join(root, "no-complex") };
  const basicRow = { caseId: "slide_17_table_rounded", set: "basic", slideNumber: 17, reverseMismatchPercent: 7.8, slideId: "slide_17" };
  const complexRow = { caseId: "slide_17", set: "complex", slideNumber: 17, reverseMismatchPercent: 95.5, slideId: "slide_17" };
  const legacyComplexRow = { caseId: "slide_17", set: "complex", slideNumber: 17, reverseMismatchPercent: 95.5 };
  for (const [set, row] of [["basic", basicRow], ["complex", complexRow]] as const) {
    mkdirSync(join(root, set, "originals"), { recursive: true });
    mkdirSync(join(root, set, "slides"), { recursive: true });
    writeFileSync(join(root, set, "originals", "slide_17.png"), "png");
    writeFileSync(join(root, set, "slides", "slide_17.png"), "png");
    writeFileSync(join(root, set, "metrics.json"), JSON.stringify([row]));
  }
  writeFileSync(join(root, "metrics.json"), JSON.stringify([basicRow, complexRow]));
  const scan = scanReverseResults({ resultsDirectory: root, fixtureDirectories });
  assert.deepEqual(scan.slides.map((slide) => [slide.id, slide.metric?.reverseMismatchPercent]), [
    ["basic__slide_17", 7.8],
    ["complex__slide_17", 95.5],
  ]);
  // The combined file repeats each set's rows; a repeated row is not "unmatched".
  assert.deepEqual(scan.problems, []);

  // Rows without the explicit id (results written before it existed): complex's row still must not
  // land on basic's screenshot; basic's slide is left without a row instead.
  writeFileSync(join(root, "basic", "metrics.json"), JSON.stringify([{ ...basicRow, slideId: undefined }]));
  writeFileSync(join(root, "complex", "metrics.json"), JSON.stringify([legacyComplexRow]));
  writeFileSync(join(root, "metrics.json"), JSON.stringify([legacyComplexRow]));
  const legacy = scanReverseResults({ resultsDirectory: root, fixtureDirectories });
  assert.deepEqual(legacy.slides.map((slide) => [slide.id, slide.metric?.reverseMismatchPercent ?? null]), [
    ["basic__slide_17", null],
    ["complex__slide_17", 95.5],
  ]);
});

test("an id two rows claim with no set to tell them apart stays unmatched and is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "reverse-rating-ambiguous-"));
  mkdirSync(join(root, "originals"), { recursive: true });
  mkdirSync(join(root, "slides"), { recursive: true });
  writeFileSync(join(root, "originals", "slide_01.png"), "png");
  writeFileSync(join(root, "slides", "slide_01.png"), "png");
  writeFileSync(join(root, "metrics.json"), JSON.stringify([
    { caseId: "slide_01", set: "basic", slideNumber: 1 },
    { caseId: "slide_01", set: "complex", slideNumber: 1 },
  ]));
  const scan = scanReverseResults({ resultsDirectory: root, fixtureDirectories: { basic: root, complex: root } });
  assert.equal(scan.slides[0]?.metric, null);
  assert.match(scan.problems.join("\n"), /fits 2 metrics rows/);
  assert.match(scan.problems.join("\n"), /2 metrics row\(s\) match no screenshot/);
});

test("blessReverseGolden copies the Sasha screenshot into the given directory only", () => {
  const { directory, fixtureDirectories } = fakeWorkspace();
  const slide = findReverseSlide({ resultsDirectory: directory, fixtureDirectories, slideId: "complex__slide_07" });
  assert.ok(slide);
  const goldensDirectory = join(directory, "..", "goldens-reverse-test");
  const written = blessReverseGolden({ slide, goldensDirectory });
  assert.equal(written, join(goldensDirectory, "complex__slide_07.png"));
  assert.deepEqual(readFileSync(written), readFileSync(slide.sashaPng));
  assert.throws(() => blessReverseGolden({ slide, goldensDirectory: join(directory, "..", "goldens") }), /forward goldens/);
  assert.equal(existsSync(join(directory, "..", "goldens")), false);
});

test("summarizeReverse averages only the metrics that exist and names the worst slides", () => {
  const { directory, fixtureDirectories } = fakeWorkspace();
  const scan = scanReverseResults({ resultsDirectory: directory, fixtureDirectories });
  const summary = summarizeReverse({
    scan,
    statusById: new Map([["complex__slide_07", "bad"], ["basic__slide_01_solid_rect", "good"]]),
    goldensDirectory: join(directory, "no-goldens-yet"),
    ratingsFile: join(directory, "ratings-reverse.json"),
  });
  assert.equal(summary.slideCount, 4);
  assert.equal(summary.ratedGood, 1);
  assert.equal(summary.ratedBad, 1);
  assert.equal(summary.meanReverseMismatchPercent?.toFixed(3), ((1.4 + 11.8 + 6.3 + 3.1) / 4).toFixed(3));
  assert.equal(summary.meanRoundTripMismatchPercent?.toFixed(3), ((2.9 + 17.2) / 2).toFixed(3));
  assert.deepEqual(summary.worstReverse, { id: "complex__slide_07", mismatchPercent: 11.8 });
  assert.equal(summary.goldenCount, 0);
  assert.deepEqual(summary.missingSashaRender, ["complex__slide_09"]);
});

function fakeWorkspace(): Readonly<{ directory: string; fixtureDirectories: FixtureDirectories }> {
  const root = mkdtempSync(join(tmpdir(), "reverse-rating-unit-"));
  const directory = join(root, "results");
  const fixtureDirectories: FixtureDirectories = { basic: join(root, "fixtures-basic"), complex: join(root, "fixtures") };
  mkdirSync(fixtureDirectories.basic, { recursive: true });
  writeFileSync(join(fixtureDirectories.basic, "slide_01_solid_rect.html"), "<!doctype html>");
  writeFakeReverseResults({ directory, googleThumbnails: [] });
  return { directory, fixtureDirectories };
}

function parsedMetric(fields: Readonly<Record<string, unknown>>): ReverseMetric {
  const reading = parseReverseMetrics({ source: "test", raw: [fields] });
  const metric = reading.metrics[0];
  assert.ok(metric, reading.problems.join("; "));
  return metric;
}
