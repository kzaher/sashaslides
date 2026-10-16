/**
 * TEXT INSETS on import. `presentations.get` reports no text inset, so the importer used to give
 * every shape Slides' measured default, 85725 EMU (12 units of a 1280 page) on all four sides. A
 * presentation uploaded from a pptx keeps that file's insets instead: the html2slides converter
 * writes 0 on 1051 of its 1052 text shapes, and Google's own pptx export of the uploaded deck says
 * so (`<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0">`). With the default, the reverse round trip
 * drew every text 12 units right of and below where Slides draws it, and a box sized tightly
 * around its word wrapped mid-word: complex fixture 38's "41%" rendered "41" over "%".
 *
 * `planImport` now takes the insets the export states, per Slides object id, and resolves each
 * edge along the placeholder chain the way a bare `<a:bodyPr/>` inherits. These tests run it on
 * the RECORDED answers: fixtures/inset-complex-slide-38.json is the `presentations.get` answer of
 * the complex SxS deck, trimmed to slide 38's "41%" box with its layout and master; its export
 * insets are copied from Google's pptx export of the same deck (ppt/slides/slide38.xml).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ShapeElement } from "../engine/src/contracts/document.ts";
import { planImport, type ImportPlan, type TextInsetsEnglishMetricUnits } from "./import-presentation.ts";
import { parsePresentation } from "./slides-presentation.ts";

const COMPLEX_SLIDE_38: unknown = JSON.parse(readFileSync(new URL("./fixtures/inset-complex-slide-38.json", import.meta.url), "utf-8"));
const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/presentation.json", import.meta.url), "utf-8"));
const UNITS_PER_ENGLISH_METRIC_UNIT = 1280 / 9_144_000;
/** Google's export of slide 38 states these for the "41%" box (Google Shape;2260;p40). */
const EXPORTED_ZERO: TextInsetsEnglishMetricUnits = { left: 0, top: 0, right: 0, bottom: 0 };
/** The OOXML defaults a pptx placeholder states: 0.1 inch left and right, 0.05 inch top and bottom. */
const OFFICE_DEFAULT: TextInsetsEnglishMetricUnits = { left: 91_440, top: 45_720, right: 91_440, bottom: 45_720 };
/** Slides' measured default for a box nobody states an inset for (import-presentation.ts). */
const FALLBACK = 12;

describe("text insets come from the pptx export when it states them", () => {
  test('complex 38 "41%": the export\'s zero insets give the text the whole 58.5 unit frame; without them it had 34.5', () => {
    // Columns: label, insets passed, expected [left, top, right, bottom] padding.
    const rows: readonly Readonly<{ label: string; textInsets: ReadonlyMap<string, TextInsetsEnglishMetricUnits> | undefined; padding: readonly number[] }>[] = [
      { label: "export read", textInsets: new Map([["p38_i13", EXPORTED_ZERO]]), padding: [0, 0, 0, 0] },
      { label: "no export (control)", textInsets: undefined, padding: [FALLBACK, FALLBACK, FALLBACK, FALLBACK] },
    ];
    for (const row of rows) {
      const box = shapeByObjectId({ plan: planOf({ raw: COMPLEX_SLIDE_38, textInsets: row.textInsets }), objectId: "p38_i13" });
      assert.deepEqual(paddingOf(box), row.padding, row.label);
      const column = box.frame.width - box.textBox.paddingLeft - box.textBox.paddingRight;
      const expectedColumn = 3_000_000 * 0.13935066666666668 * UNITS_PER_ENGLISH_METRIC_UNIT - row.padding[0]! - row.padding[2]!;
      assert.ok(Math.abs(column - expectedColumn) < 0.01, `${row.label}: column ${column}, expected ${expectedColumn}`);
    }
  });

  test("one stated edge: the converter's top-only inset moves the text down and leaves the other three at 0", () => {
    const box = shapeByObjectId({
      plan: planOf({ raw: COMPLEX_SLIDE_38, textInsets: new Map([["p38_i13", { left: 0, top: 21_425, right: 0, bottom: 0 }]]) }),
      objectId: "p38_i13",
    });
    assert.deepEqual(paddingOf(box), [0, roundToThousandth(21_425 * UNITS_PER_ENGLISH_METRIC_UNIT), 0, 0]);
  });
});

describe("an edge the shape does not state inherits along the placeholder chain (agenda_title -> p4_i0 -> p1_i0)", () => {
  const office = (value: number): number => roundToThousandth(value * UNITS_PER_ENGLISH_METRIC_UNIT);
  // Columns: label, insets by object id, expected [left, top, right, bottom] padding of agenda_title.
  const rows: readonly Readonly<{ label: string; textInsets: ReadonlyMap<string, TextInsetsEnglishMetricUnits>; padding: readonly number[] }>[] = [
    { label: "only the master states", textInsets: new Map([["p1_i0", OFFICE_DEFAULT]]), padding: [office(91_440), office(45_720), office(91_440), office(45_720)] },
    {
      label: "the layout overrides the left edge",
      textInsets: new Map([["p1_i0", OFFICE_DEFAULT], ["p4_i0", { left: 0 }]]),
      padding: [0, office(45_720), office(91_440), office(45_720)],
    },
    {
      label: "the shape overrides the top, the layout the left",
      textInsets: new Map([["p1_i0", OFFICE_DEFAULT], ["p4_i0", { left: 0 }], ["agenda_title", { top: 0 }]]),
      padding: [0, 0, office(91_440), office(45_720)],
    },
    { label: "an unrelated element states (control)", textInsets: new Map([["numbered_box", EXPORTED_ZERO]]), padding: [FALLBACK, FALLBACK, FALLBACK, FALLBACK] },
  ];
  for (const row of rows) {
    test(row.label, () => {
      const title = shapeByObjectId({ plan: planOf({ raw: RECORDED, textInsets: row.textInsets }), objectId: "agenda_title" });
      assert.deepEqual(paddingOf(title), row.padding);
    });
  }
});

describe("Google's own 0.1 inch inset, exported as 91425, is drawn as its measured 85725", () => {
  // Google stores insets on a 25 EMU grid (the converter's 21431 / 34290 / 91440 came back from the
  // upload as 21425 / 34275 / 91425), so 91425 is its stored 0.1 inch: what every box the Slides API
  // creates carries, and what a pptx's 0.1 inch becomes. Slides DRAWS the left and right of it 85725
  // EMU from the frame (converter/geometry.ts; the test deck's ink). Taken at face value it took
  // 2 x 0.8 units from every such column, and boxes the forward converter sized to their text
  // wrapped in Sasha only: the test deck's "Q3 revenue, bold light" (slide 9), "02 / 03" (slide 7).
  // Top and bottom stay as stated: the vertical line model was measured with them (import-presentation.ts).
  test("the left and right edges of a box whose export states 91425 get 12 units of a 1280 page", () => {
    const box = shapeByObjectId({
      plan: planOf({ raw: COMPLEX_SLIDE_38, textInsets: new Map([["p38_i13", { left: 91_425, top: 91_425, right: 91_425, bottom: 91_425 }]]) }),
      objectId: "p38_i13",
    });
    const stated = roundToThousandth(91_425 * UNITS_PER_ENGLISH_METRIC_UNIT);
    assert.deepEqual(paddingOf(box), [FALLBACK, stated, FALLBACK, stated]);
  });

  test("an inset the converter chose keeps its stated value (control)", () => {
    const box = shapeByObjectId({
      plan: planOf({ raw: COMPLEX_SLIDE_38, textInsets: new Map([["p38_i13", { left: 0, top: 91_400, right: 0, bottom: 0 }]]) }),
      objectId: "p38_i13",
    });
    assert.deepEqual(paddingOf(box), [0, roundToThousandth(91_400 * UNITS_PER_ENGLISH_METRIC_UNIT), 0, 0]);
  });
});

function planOf(options: Readonly<{ raw: unknown; textInsets: ReadonlyMap<string, TextInsetsEnglishMetricUnits> | undefined }>): ImportPlan {
  const parsed = parsePresentation(options.raw);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return planImport({
    presentation: parsed.presentation,
    images: new Map(),
    idSeed: { sessionPrefix: "Insets00", counter: 0 },
    pptxSupplement: null,
    ...(options.textInsets === undefined ? {} : { textInsets: options.textInsets }),
  });
}

/** Element ids are kept when they are valid object ids (import-presentation.ts), as both of these are. */
function shapeByObjectId(options: Readonly<{ plan: ImportPlan; objectId: string }>): ShapeElement {
  for (const slide of options.plan.slides) {
    const element = slide.elements.find((candidate) => candidate.id === options.objectId);
    if (element === undefined) continue;
    if (element.kind !== "shape") throw new Error(`${options.objectId} is a ${element.kind}`);
    return element;
  }
  throw new Error(`no element ${options.objectId}`);
}

function paddingOf(shape: ShapeElement): readonly number[] {
  return [shape.textBox.paddingLeft, shape.textBox.paddingTop, shape.textBox.paddingRight, shape.textBox.paddingBottom];
}

function roundToThousandth(value: number): number {
  return Math.round(value * 1000) / 1000;
}
