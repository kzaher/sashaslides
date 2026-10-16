// Where a line sits (text-vertical-metrics.ts), checked two ways. First the numbers against Google's
// measured rule: a line is `lineSpacing` x 1.2 x its largest size tall and its baseline sits
// min(lineSpacing, 1) x 0.9465 x that size below its top, for every family. Then the declarations the
// renderer writes, run through the stylesheet's own line-box rule (each inline box centred on its
// font's content area, moved by vertical-align; a line box spanning every box and the paragraph's
// strut), so a regression in either the formulas or the markup shows as a misplaced baseline.
// Measured cases: complex slide 25 (Inter at 173 %, one BIG word) drew its first line 10-14 px low
// at 1600 x 900 before; a 70 % box drew 5 px high; Playfair Display drew 4 px low at 24 pt.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_PARAGRAPH_STYLE, type RunStyle } from "../../contracts/style.ts";
import { sampleTheme } from "../sample/snapshot-builders.ts";
import { LINE_DROP_PROPERTY, LINE_SPACING_PROPERTY, paragraphDeclarations, runDeclarations } from "./inline-styles.ts";
import { resolveRunStyle } from "./text-layout.ts";
import { FONT_VERTICAL_METRICS, paragraphLineDropEm, runDropEm, SLIDES_BASELINE_PER_FONT_SIZE, strutLineHeight, stylesheetBaselineInLineBox } from "./text-vertical-metrics.ts";

const theme = sampleTheme();
const SPACINGS = [0.5, 0.7, 0.8333, 1, 1.15, 1.2, 1.7333, 2, 3] as const;
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
    assert.ok(Math.abs(line.baseline - 0.7 * SLIDES_BASELINE_PER_FONT_SIZE * 40) < 1e-6, `baseline ${line.baseline}`);
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
        assert.ok(Math.abs(line.baseline - Math.min(lineSpacing, 1) * SLIDES_BASELINE_PER_FONT_SIZE * 30) < 1e-6, `baseline ${line.baseline}`);
        assert.ok(Math.abs(line.height - lineSpacing * 1.2 * 30) < 1e-6, `height ${line.height}`);
      });
    }
  }

  it("a BIG word sets its line's height and baseline, as on complex slide 25 (Inter 18 px at 173 % with one 24 px word)", () => {
    const lineSpacing = 1.7333;
    const plain = layOutLine({ lineSpacing, runs: [{ size: 18, family: "Inter" }] });
    const big = layOutLine({ lineSpacing, runs: [{ size: 18, family: "Inter" }, { size: 24, family: "Inter" }, { size: 15, family: "Source Code Pro" }] });
    assert.ok(Math.abs(big.baseline - SLIDES_BASELINE_PER_FONT_SIZE * 24) < 1e-6, `baseline ${big.baseline}`);
    assert.ok(Math.abs(big.height - lineSpacing * 1.2 * 24) < 1e-6, `height ${big.height}`);
    assert.ok(Math.abs(plain.baseline - SLIDES_BASELINE_PER_FONT_SIZE * 18) < 1e-6);
  });
});

describe("the declarations carry it", () => {
  it("the paragraph hands its spacing and drop to its runs, and keeps an empty line's full height", () => {
    const declarations = paragraphDeclarations({ style: { ...DEFAULT_PARAGRAPH_STYLE, lineSpacing: 2 }, base: runStyle({ fontFamily: "Arial", fontSize: 30 }), theme, fontScale: 1, listIndent: 0 });
    const custom = new Map<string, unknown>(Object.entries(declarations));
    assert.equal(custom.get(LINE_SPACING_PROPERTY), "2");
    assert.equal(custom.get(LINE_DROP_PROPERTY), String(Math.round(paragraphLineDropEm(2) * 1000) / 1000));
    assert.equal(declarations.lineHeight, 1.2);
    assert.equal(declarations.minHeight, "2.4em");
  });

  it("a run is lowered and raised by one length in em, so shrink-on-overflow scales it with the font", () => {
    const declarations = runDeclarations({ style: runStyle({ fontFamily: "Playfair Display", fontSize: 30 }), theme, fontScale: 1 });
    const shift = `calc(-1em * (1.016 + var(${LINE_DROP_PROPERTY}, -0.946)))`;
    assert.equal(declarations.verticalAlign, shift);
    assert.equal(declarations.top, shift);
    assert.equal(declarations.position, "relative");
    assert.equal(declarations.lineHeight, `calc(1.2 * var(${LINE_SPACING_PROPERTY}, 1))`);
  });

  it("a superscript keeps the stylesheet's raise and takes no room, as Google's lines ignore it", () => {
    const declarations = runDeclarations({ style: runStyle({ fontFamily: "Inter", fontSize: 30, baselineOffset: "superscript" }), theme, fontScale: 1 });
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
 * One line laid out by the stylesheet's rule from the values the renderer writes: the strut (the
 * paragraph's font, size and line height, centred) and each run's box (its own line height,
 * centred on its content, lowered by its drop). Returns the baseline below the line's top, and the
 * line's height. A run's glyphs are raised back by the same drop, so they sit on the baseline.
 */
function layOutLine(options: Readonly<{ lineSpacing: number; runs: readonly LineRun[] }>): Readonly<{ baseline: number; height: number }> {
  const first = options.runs[0];
  assert.ok(first !== undefined);
  const strut = centredBox({ size: first.size, family: first.family, lineHeight: strutLineHeight({ lineSpacing: options.lineSpacing, family: first.family }) * first.size, lowered: 0 });
  const boxes = options.runs.map((run) =>
    centredBox({ size: run.size, family: run.family, lineHeight: 1.2 * options.lineSpacing * run.size, lowered: runDropEm({ lineSpacing: options.lineSpacing, family: run.family }) * run.size }),
  );
  const above = Math.max(strut.above, ...boxes.map((box) => box.above));
  const below = Math.max(strut.below, ...boxes.map((box) => box.below));
  return { baseline: above, height: above + below };
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
