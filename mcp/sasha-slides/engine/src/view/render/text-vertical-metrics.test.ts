// Where a line sits (text-vertical-metrics.ts), checked two ways. First the numbers against Google's
// measured rule: a line is `lineSpacing` x 1.2 x its largest size tall and its baseline sits
// min(lineSpacing, 1) x 0.9465 x that size below its top, for every family. Then the declarations the
// renderer writes, run through the stylesheet's own line-box rule (each inline box centred on its
// font's content area, moved by vertical-align; a line box spanning every box and the paragraph's
// strut), so a regression in either the formulas or the markup
// shows as a misplaced baseline.
// Measured cases: complex slide 25 (Inter at 173 %, one BIG word) drew its first line 10-14 px low
// at 1600 x 900 before; a 70 % box drew 5 px high; Playfair Display drew 4 px low at 24 pt.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_PARAGRAPH_STYLE, type RunStyle } from "../../contracts/style.ts";
import { sampleTheme } from "../sample/snapshot-builders.ts";
import { paragraphDeclarations, paragraphRunsDeclarations, runDeclarations, runFitsParagraphSpan } from "./inline-styles.ts";
import { resolveRunStyle } from "./text-layout.ts";
import { FONT_VERTICAL_METRICS, paragraphLineDropEm, SLIDES_BASELINE_PER_FONT_SIZE, strutLineHeight, stylesheetBaselineInLineBox } from "./text-vertical-metrics.ts";

const theme = sampleTheme();
const SPACINGS = [0.5, 0.7, 0.8333, 1, 1.15, 1.2, 1.7333, 2, 3] as const;
/**
 * Each written em length is two terms rounded to a thousandth (roundNumber), so a laid-out 30 px
 * line is exact to under a tenth of a pixel.
 */
const WRITTEN_PRECISION = 0.1;
const FAMILIES = ["Arial", "Inter", "Playfair Display", "Roboto Mono", "Source Code Pro", "Some Unlisted Family"] as const;

describe("Google's line placement", () => {
  it("at 100 % an Arial run needs no move: the stylesheet already puts its baseline where Google does", () => {
    assert.ok(Math.abs(runDropEm({ lineSpacing: 1, family: "Arial" })) < 1e-9);
    assert.ok(Math.abs(strutLineHeight({ lineSpacing: 1, family: "Arial" }) - 1.2) < 1e-9);
  });

  it("extra spacing goes below the glyphs: at 200 % the run drops by the stylesheet's half-leading, 0.6 em", () => {
    assert.ok(Math.abs(runDropEm({ lineSpacing: 2, family: "Arial" }) - 0.6) < 1e-9);
  });

  it("under 100 % the line shrinks from its top: at 70 % the baseline is 0.7 x 0.9465 em down", () => {
    const line = layOutLine({ lineSpacing: 0.7, runs: [{ size: 40, family: "Arial" }] });
    assert.ok(Math.abs(line.baseline - 0.7 * SLIDES_BASELINE_PER_FONT_SIZE * 40) < WRITTEN_PRECISION, `baseline ${line.baseline}`);
  });

  it("a family's own metrics do not move its baseline: Playfair Display drops 0.069 em more than Arial", () => {
    assert.ok(Math.abs(runDropEm({ lineSpacing: 1, family: "Playfair Display" }) - 0.069) < 1e-9);
    assert.equal(stylesheetBaselineInLineBox("Some Unlisted Family"), SLIDES_BASELINE_PER_FONT_SIZE);
    assert.equal(stylesheetBaselineInLineBox("  INTER "), stylesheetBaselineInLineBox("Inter"));
  });

  for (const lineSpacing of SPACINGS) {
    for (const family of FAMILIES) {
      it(`a ${family} line at ${Math.round(lineSpacing * 100)} % is Google's height with Google's baseline`, () => {
        const line = layOutLine({ lineSpacing, runs: [{ size: 30, family }] });
        assert.ok(Math.abs(line.baseline - Math.min(lineSpacing, 1) * SLIDES_BASELINE_PER_FONT_SIZE * 30) < WRITTEN_PRECISION, `baseline ${line.baseline}`);
        assert.ok(Math.abs(line.height - lineSpacing * 1.2 * 30) < WRITTEN_PRECISION, `height ${line.height}`);
      });
    }
  }

  it("a BIG word sets its line's height and baseline, as on complex slide 25 (Inter 18 px at 173 % with one 24 px word)", () => {
    const lineSpacing = 1.7333;
    const plain = layOutLine({ lineSpacing, runs: [{ size: 18, family: "Inter" }] });
    const big = layOutLine({ lineSpacing, runs: [{ size: 18, family: "Inter" }, { size: 24, family: "Inter" }, { size: 15, family: "Source Code Pro" }] });
    assert.ok(Math.abs(big.baseline - SLIDES_BASELINE_PER_FONT_SIZE * 24) < WRITTEN_PRECISION, `baseline ${big.baseline}`);
    assert.ok(Math.abs(big.height - lineSpacing * 1.2 * 24) < WRITTEN_PRECISION, `height ${big.height}`);
    assert.ok(Math.abs(plain.baseline - SLIDES_BASELINE_PER_FONT_SIZE * 18) < WRITTEN_PRECISION);
  });
});

describe("the declarations carry it", () => {
  it("the paragraph keeps an empty line's full height; its runs' span carries the base's typography and line box", () => {
    const base = runStyle({ fontFamily: "Arial", fontSize: 30 });
    const paragraph = paragraphDeclarations({ style: { ...DEFAULT_PARAGRAPH_STYLE, lineSpacing: 2 }, base, theme, fontScale: 1, listIndent: 0 });
    assert.equal(paragraph.lineHeight, 1.2);
    assert.equal(paragraph.minHeight, "2.4em");
    const span = paragraphRunsDeclarations({ base, lineSpacing: 2, theme, fontScale: 1 });
    assert.equal(span.lineHeight, 2.4);
    assert.equal(span.verticalAlign, "-0.6em");
    assert.equal(span.top, "-0.6em");
    assert.equal(span.fontSize, "30px");
    assert.equal(span.fontWeight, base.fontWeight);
  });

  it("a run in the paragraph's own style declares nothing, so HTML editors can type into the paragraph (complex slide 25)", () => {
    const base = runStyle({ fontFamily: "Inter", fontSize: 18 });
    assert.deepEqual(runDeclarations({ style: base, base, lineSpacing: 1.7333, theme, fontScale: 1 }), {});
    const bold = runDeclarations({ style: { ...base, fontWeight: 700, underline: true }, base, lineSpacing: 1.7333, theme, fontScale: 1 });
    assert.deepEqual(bold, { fontWeight: 700, textDecoration: "underline" });
  });

  it("a smaller run in another family fits the span's line box and declares no placement (complex slide 25's code)", () => {
    const base = runStyle({ fontFamily: "Inter", fontSize: 18 });
    const code = runStyle({ fontFamily: "Source Code Pro", fontSize: 15 });
    assert.equal(runFitsParagraphSpan({ style: code, base, lineSpacing: 1.7333 }), true);
    assert.deepEqual(runDeclarations({ style: code, base, lineSpacing: 1.7333, theme, fontScale: 1 }), { fontFamily: '"Source Code Pro", monospace', fontSize: "15px" });
  });

  it("a larger run is lowered and raised by the difference of the two drops, inside the one span", () => {
    const base = runStyle({ fontFamily: "Arial", fontSize: 30 });
    const big = runStyle({ fontFamily: "Arial", fontSize: 40 });
    assert.equal(runFitsParagraphSpan({ style: big, base, lineSpacing: 2 }), false);
    const declarations = runDeclarations({ style: big, base, lineSpacing: 2, theme, fontScale: 1 });
    assert.equal(declarations.verticalAlign, "-6px");
    assert.equal(declarations.top, "-6px");
    assert.equal(declarations.position, "relative");
    assert.equal(declarations.lineHeight, undefined);
  });

  it("a superscript keeps the stylesheet's raise and takes no room, as Google's lines ignore it", () => {
    const base = runStyle({ fontFamily: "Inter", fontSize: 30 });
    const declarations = runDeclarations({ style: { ...base, baselineOffset: "superscript" }, base, lineSpacing: 1, theme, fontScale: 1 });
    assert.equal(declarations.verticalAlign, "super");
    assert.equal(declarations.lineHeight, 0);
    assert.equal(declarations.top, undefined);
  });

  it("every listed family has a plausible ascent and descent", () => {
    for (const [family, metrics] of Object.entries(FONT_VERTICAL_METRICS)) {
      assert.equal(family, family.toLowerCase());
      assert.ok(metrics.ascent > 0.7 && metrics.ascent < 1.3 && metrics.descent > 0.1 && metrics.descent < 0.5, family);
    }
  });
});

type LineRun = Readonly<{ size: number; family: string }>;

/**
 * How far a stylesheet's centred line box must move DOWN, in em of the run's own size, for its top
 * to sit Google's baseline offset above the baseline: the stylesheet's own offset at this spacing
 * (its half-leading plus the font's) minus Google's. The oracle the renderer's written drops match.
 */
function runDropEm(options: Readonly<{ lineSpacing: number; family: string }>): number {
  return stylesheetBaselineInLineBox(options.family) + paragraphLineDropEm(options.lineSpacing);
}

/**
 * One line laid out by the stylesheet's rule from the values the renderer writes: the strut (the
 * paragraph's font, size and line height, centred), the one span every run sits in (lowered by its
 * vertical-align in em), and each run inside it (the span's unitless line height in its own size,
 * centred on its content, on the span's baseline, lowered further by its own vertical-align in px).
 * Glyphs are raised back by the same `top`s, so they sit on the baseline. Returns the baseline below
 * the line's top, and the line's height.
 */
function layOutLine(options: Readonly<{ lineSpacing: number; runs: readonly LineRun[] }>): Readonly<{ baseline: number; height: number }> {
  const first = options.runs[0];
  assert.ok(first !== undefined);
  const base = runStyle({ fontFamily: first.family, fontSize: first.size });
  const paragraph = paragraphDeclarations({ style: { ...DEFAULT_PARAGRAPH_STYLE, lineSpacing: options.lineSpacing }, base, theme, fontScale: 1, listIndent: 0 });
  const strut = centredBox({ size: first.size, family: first.family, lineHeight: Number(paragraph.lineHeight) * first.size, lowered: 0 });
  const spanDeclarations = paragraphRunsDeclarations({ base, lineSpacing: options.lineSpacing, theme, fontScale: 1 });
  const lineHeight = Number(spanDeclarations.lineHeight);
  const spanLowered = -ems(spanDeclarations.verticalAlign) * first.size;
  const span = centredBox({ size: first.size, family: first.family, lineHeight: lineHeight * first.size, lowered: spanLowered });
  const runs = options.runs.map((run) => {
    const declarations = runDeclarations({ style: runStyle({ fontFamily: run.family, fontSize: run.size }), base, lineSpacing: options.lineSpacing, theme, fontScale: 1 });
    return centredBox({ size: run.size, family: run.family, lineHeight: lineHeight * run.size, lowered: spanLowered - pixels(declarations.verticalAlign) });
  });
  const boxes = [strut, span, ...runs];
  const above = Math.max(...boxes.map((entry) => entry.above));
  const below = Math.max(...boxes.map((entry) => entry.below));
  return { baseline: above, height: above + below };
}

/** A declared length in pixels; an absent one is 0. */
function pixels(value: unknown): number {
  if (value === undefined) return 0;
  assert.ok(typeof value === "string" && value.endsWith("px"), String(value));
  return Number(value.slice(0, -2));
}

/** A declared length in em. */
function ems(value: unknown): number {
  assert.ok(typeof value === "string" && value.endsWith("em"), String(value));
  return Number(value.slice(0, -2));
}

/** A box's extent above and below the line's baseline: half-leading around the font's own content area. */
function centredBox(options: Readonly<{ size: number; family: string; lineHeight: number; lowered: number }>): Readonly<{ above: number; below: number }> {
  const centre = stylesheetBaselineInLineBox(options.family) - 0.6;
  const above = (options.lineHeight / 2 + centre * options.size) - options.lowered;
  return { above, below: options.lineHeight - above };
}

function runStyle(patch: Partial<RunStyle>): RunStyle {
  return resolveRunStyle({ context: { theme, placeholder: null }, patch });
}
