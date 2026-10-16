/**
 * The trailing spacing an uploaded .pptx box leaves off its last line (import-uploaded-leading.ts),
 * on a RECORDED `presentations.get` answer: fixtures/uploaded-leading-presentation.json is a
 * calibration deck written with pptxgenjs (as html2slides' converter writes them), uploaded through
 * Drive, then trimmed to six boxes. Its thumbnail measured (1600 x 900, 2026-10-15):
 *   * p1_i2 / p1_i3 / p1_i4: one 20.25 pt line centred in a 90 pt square at 100, 120 and 200 % sat
 *     at the SAME height (ink rows 84-115 in all three);
 *   * p2_i4 / p2_i5: two lines bottom-aligned at 120 and 200 % ended at the SAME height (224-255).
 * The engine counts the last line's spacing in its block (render/text-vertical-metrics.ts), so the
 * importer must hand it back to the inset for these and only these.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ShapeElement } from "../engine/src/contracts/document.ts";
import { planImport, type ImportPlan } from "./import-presentation.ts";
import { insetsForUploadedText, uploadedTrailingSpacingPoints } from "./import-uploaded-leading.ts";
import { parsePresentation } from "./slides-presentation.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/uploaded-leading-presentation.json", import.meta.url), "utf-8"));
const UNITS_PER_POINT = 1280 / 720;
/** Slides' baseline below a line's top, per unit of size (engine render/text-vertical-metrics.ts). */
const SLIDES_BASELINE_PER_FONT_SIZE = 0.9465;
const FONT_SIZE_UNITS = 20.25 * UNITS_PER_POINT;

describe("uploaded .pptx text keeps Slides' place for centred and bottom-aligned lines", () => {
  test("a centred single line sits at one height whatever its spacing, as Slides drew it", () => {
    const plan = planOf(RECORDED);
    const baselines = ["p1_i2", "p1_i3", "p1_i4"].map((objectId) => centredFirstBaseline(shapeOf(plan, objectId)));
    for (const baseline of baselines) assert.ok(Math.abs(baseline - (baselines[0] ?? 0)) < 0.01, `baselines ${baselines.join(", ")}`);
  });

  test("the extra spacing of a centred box goes to its top inset, and 100 % adds nothing", () => {
    const plan = planOf(RECORDED);
    const single = shapeOf(plan, "p1_i2").textBox;
    const wider = shapeOf(plan, "p1_i3").textBox;
    assert.equal(wider.paddingTop, round(single.paddingTop + 0.2 * 1.2 * FONT_SIZE_UNITS));
    assert.equal(wider.paddingBottom, single.paddingBottom);
  });

  test("a bottom-aligned box gives the last line's spacing back from its bottom inset, never below zero", () => {
    const plan = planOf(RECORDED);
    const top = shapeOf(plan, "p2_i3").textBox;
    assert.deepEqual(top, shapeOf(planOf(withSpacingMode(RECORDED, "COLLAPSE_LISTS")), "p2_i3").textBox, "a top-aligned box is unchanged");
    for (const [objectId, spacing] of [["p2_i4", 1.2], ["p2_i5", 2]] as const) {
      const bottom = shapeOf(plan, objectId).textBox;
      assert.equal(bottom.paddingBottom, Math.max(0, round(top.paddingBottom - (spacing - 1) * 1.2 * FONT_SIZE_UNITS)), objectId);
      assert.equal(bottom.paddingTop, top.paddingTop, objectId);
    }
  });

  test("the same box made in Slides (COLLAPSE_LISTS) keeps its insets: Slides counts its last line's spacing", () => {
    const native = planOf(withSpacingMode(RECORDED, "COLLAPSE_LISTS"));
    const uploaded = planOf(RECORDED);
    assert.equal(shapeOf(native, "p1_i4").textBox.paddingTop, shapeOf(native, "p1_i2").textBox.paddingTop);
    assert.notEqual(shapeOf(uploaded, "p1_i4").textBox.paddingTop, shapeOf(uploaded, "p1_i2").textBox.paddingTop);
  });

  test("spacing at or under 100 %, an inherited size and an empty body add nothing", () => {
    const paragraph = (lineSpacingPercent: number | undefined, fontSizePoints: number | undefined) => ({
      paragraphs: [{ style: { spacingMode: "NEVER_COLLAPSE", ...(lineSpacingPercent === undefined ? {} : { lineSpacingPercent }) }, bullet: null, nestingLevel: 0, runs: [{ kind: "text" as const, content: "Text", style: fontSizePoints === undefined ? {} : { fontSizePoints } }], markStyle: {} }],
    });
    assert.equal(uploadedTrailingSpacingPoints(paragraph(90, 20)), 0);
    assert.equal(uploadedTrailingSpacingPoints(paragraph(100, 20)), 0);
    assert.equal(uploadedTrailingSpacingPoints(paragraph(undefined, 20)), 0);
    assert.equal(uploadedTrailingSpacingPoints(paragraph(150, undefined)), 0);
    assert.equal(uploadedTrailingSpacingPoints(paragraph(150, 20)), 12);
    assert.equal(uploadedTrailingSpacingPoints(null), 0);
    assert.deepEqual(insetsForUploadedText({ verticalAlignment: "top", top: 3, bottom: 4, trailingSpacing: 10 }), { top: 3, bottom: 4 });
  });
});

function planOf(raw: unknown): ImportPlan {
  const parsed = parsePresentation(raw);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return planImport({ presentation: parsed.presentation, images: new Map(), idSeed: { sessionPrefix: "Lead1ng0", counter: 0 }, pptxSupplement: null });
}

function shapeOf(plan: ImportPlan, objectId: string): ShapeElement {
  for (const slide of plan.slides) {
    for (const element of slide.elements) if (element.kind === "shape" && element.id === objectId) return element;
  }
  throw new Error(`no shape ${objectId}`);
}

/** The first baseline of a centred box as the engine draws it: its block is the full lines' height. */
function centredFirstBaseline(shape: ShapeElement): number {
  const paragraph = shape.text.paragraphs[0];
  const spacing = paragraph?.style.lineSpacing ?? 1;
  const block = spacing * 1.2 * FONT_SIZE_UNITS;
  const available = shape.frame.height - shape.textBox.paddingTop - shape.textBox.paddingBottom;
  return shape.frame.y + shape.textBox.paddingTop + (available - block) / 2 + SLIDES_BASELINE_PER_FONT_SIZE * FONT_SIZE_UNITS;
}

function withSpacingMode(raw: unknown, spacingMode: string): unknown {
  return JSON.parse(JSON.stringify(raw).replaceAll('"spacingMode":"NEVER_COLLAPSE"', `"spacingMode":"${spacingMode}"`));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

