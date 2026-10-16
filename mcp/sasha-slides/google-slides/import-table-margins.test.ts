/**
 * TABLE CELL MARGINS AND TRANSPARENT BORDERS, against a recorded `presentations.get` of the reverse
 * round trip's basic slide 17 (fixtures/table-margins-presentation.json: that slide's first two
 * tables, its layout and master, from the deck the forward converter itself uploaded).
 *
 * WHY THIS IS PINNED. The Slides API returns no cell margins, and the importer used to give every
 * cell a fixed 12 unit margin on every side. The fixture's cells hold 12 unit text in rows Google
 * stored 26.88 units high (text 14.4 + 6 + 6), so a 12 unit margin made every row 38.4 units and
 * the table 43 percent taller than in Slides; on the complex set the same fault pushed a table out
 * of its card and every overlay off its row. Its borders between body rows are stored with alpha
 * 0, which Slides draws as nothing, but the engine drew them as transparent collapsed borders that
 * opened a faint grid between the cells' fills.
 *
 * The forward converter wrote these margins into the pptx it uploaded (`<a:tcPr marT="42863"
 * marL="71438">`: 6 and 10 units), so they are the values the inference must land near, and the
 * values a pptx-export reader hands in exactly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { TableElement, TextBody } from "../engine/src/contracts/document.ts";
import { planImport } from "./import-presentation.ts";
import { parsePresentation, type SlidesCellMargins, type SlidesPresentation } from "./slides-presentation.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/table-margins-presentation.json", import.meta.url), "utf-8"));
const UNITS_PER_ENGLISH_METRIC_UNIT = 1280 / 9_144_000;
/** The engine's line box per unit of line spacing (render/inline-styles.ts LINE_HEIGHT_PER_LINE_SPACING). */
const LINE_BOX = 1.2;
/** What the forward converter wrote for this slide's cells, in engine units. */
const FORWARD_VERTICAL_MARGIN = 42_863 * UNITS_PER_ENGLISH_METRIC_UNIT;
const FORWARD_HORIZONTAL_MARGIN = 71_438 * UNITS_PER_ENGLISH_METRIC_UNIT;

describe("table cells: margins that keep Google's row heights, and no line where Google draws none", () => {
  test("with no margins supplied, every row's text plus its margins fits the height Google stored", () => {
    for (const table of tablesOf(parsedRecording())) {
      for (const row of table.rows) {
        for (const cell of table.cells.filter((candidate) => candidate.rowId === row.id && candidate.rowSpan === 1)) {
          const needed = textHeightOf(cell.text) + cell.textBox.paddingTop + cell.textBox.paddingBottom;
          assert.ok(needed <= row.minimumHeight + 0.01, `${table.id} row ${row.id}: text and margins need ${needed.toFixed(2)} of ${row.minimumHeight}`);
        }
      }
    }
  });

  test("the inferred top and bottom margin lands within half a unit of the one the forward pptx wrote", () => {
    for (const table of tablesOf(parsedRecording())) {
      for (const cell of table.cells) {
        assert.ok(Math.abs(cell.textBox.paddingTop - FORWARD_VERTICAL_MARGIN) < 0.5, `${table.id}: top ${cell.textBox.paddingTop}`);
        assert.equal(cell.textBox.paddingBottom, cell.textBox.paddingTop);
      }
    }
  });

  test("margins read from the pptx export are taken exactly, side by side", () => {
    const margins: SlidesCellMargins = { top: 42_863, right: 71_438, bottom: 35_725, left: 142_875 };
    for (const table of tablesOf(withCellMargins({ presentation: parsedRecording(), margins }))) {
      for (const cell of table.cells) {
        const padding = [cell.textBox.paddingTop, cell.textBox.paddingRight, cell.textBox.paddingBottom, cell.textBox.paddingLeft];
        const expected = [margins.top, margins.right, margins.bottom, margins.left].map((value) => value * UNITS_PER_ENGLISH_METRIC_UNIT);
        padding.forEach((value, index) => assert.ok(Math.abs(value - (expected[index] ?? Number.NaN)) < 0.01, `${table.id} side ${index}: ${value}`));
      }
    }
    assert.ok(Math.abs(FORWARD_HORIZONTAL_MARGIN - 10) < 0.01, "the forward converter's 10 pixel side margin is 10 units");
  });

  test("a border stored fully transparent imports as no border; an opaque one is kept", () => {
    const [transparentTable, whiteGridTable] = tablesOf(parsedRecording());
    assert.ok(transparentTable !== undefined && whiteGridTable !== undefined);
    // p17_i18: every line inside the table and around it is alpha 0 in the recording.
    for (const cell of transparentTable.cells) assert.deepEqual(cell.borders, { top: null, right: null, bottom: null, left: null }, `${transparentTable.id} cell`);
    // p17_i35: white 1 pixel lines between the cells, alpha 1.
    const inner = whiteGridTable.cells.find((cell) => cell.rowId === whiteGridTable.rows[1]?.id && cell.columnId === whiteGridTable.columns[1]?.id);
    assert.deepEqual(inner?.borders.top?.colour, { kind: "literal", hexadecimal: "#ffffff", alpha: 1 });
  });
});

function parsedRecording(): SlidesPresentation {
  const parsed = parsePresentation(RECORDED);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return parsed.presentation;
}

/** The recording with every cell's margins set, as a reader of the pptx export would hand it in. */
function withCellMargins(options: Readonly<{ presentation: SlidesPresentation; margins: SlidesCellMargins }>): SlidesPresentation {
  return {
    ...options.presentation,
    slides: options.presentation.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) =>
        element.content.kind === "table"
          ? { ...element, content: { ...element.content, cells: element.content.cells.map((cell) => ({ ...cell, marginsEnglishMetricUnits: options.margins })) } }
          : element,
      ),
    })),
  };
}

function tablesOf(presentation: SlidesPresentation): readonly TableElement[] {
  const plan = planImport({ presentation, images: new Map(), idSeed: { sessionPrefix: "Margins", counter: 0 }, pptxSupplement: null });
  const tables = (plan.slides[0]?.elements ?? []).filter((element): element is TableElement => element.kind === "table");
  assert.equal(tables.length, 2, "the fixture holds two tables");
  return tables;
}

/** One line per paragraph, as the engine draws a cell whose text does not wrap. */
function textHeightOf(body: TextBody): number {
  return body.paragraphs.reduce((total, paragraph) => {
    const fontSize = Math.max(0, ...paragraph.runs.map((run) => run.style.fontSize ?? 0));
    return total + (paragraph.style.spaceAbove ?? 0) + (paragraph.style.spaceBelow ?? 0) + fontSize * (paragraph.style.lineSpacing ?? 1) * LINE_BOX;
  }, 0);
}
