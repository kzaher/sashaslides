/**
 * IMPORT FIDELITY against the development test deck (1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U),
 * trimmed to the three slides reported as broken after import (fixtures/import-fidelity-presentation.json:
 * slides 1, 3 and 6 of a read-only `presentations.get`, with their layouts and master, speaker
 * notes and the one picture removed).
 *
 * WHY THESE ARE PINS AND NOT FIXES. Measured on 2026-10-15: Google's OWN thumbnails of these slides
 * show the same faults the imported deck shows. Slide 1 is two empty placeholders (blank in
 * Slides too); slide 3's second paragraph box starts 10 units above the first one's bottom and its
 * text wraps to a third line, so the two overlap in Slides; slide 6's "Spend" box is narrower than
 * the word in bold Arial once the text inset is taken off, so Slides wraps it "Spen / d". The deck
 * was built by the add-on's HTML-to-native insert, which sized those frames, so the faults are in
 * the deck, and the import reproduces them exactly. These tests hold the import to Google's values,
 * so a change that "fixes" the import by drawing something Slides does not draw fails here.
 *
 * The paragraph indent conversion (Slides measures the first line from the start edge, the engine
 * from `indentStart`) is checked in both directions at the end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ElementSnapshot, ShapeElement, SlideSnapshot } from "../engine/src/contracts/document.ts";
import { plainText } from "../engine/src/contracts/document.ts";
import type { ParagraphStylePatch } from "../engine/src/contracts/style.ts";
import { textRequests } from "./export-text.ts";
import { planImport, type ImportPlan } from "./import-presentation.ts";
import { createLossCollector } from "./interchange-losses.ts";
import { parsePresentation } from "./slides-presentation.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/import-fidelity-presentation.json", import.meta.url), "utf-8"));
const UNITS_PER_ENGLISH_METRIC_UNIT = 1280 / 9_144_000;
const UNITS_PER_POINT = 1280 / 720;
/** Slides' default text inset on each side, in engine units (import-presentation.ts). */
const TEXT_INSET = 12;
/** Arial Bold advance widths in thousandths of an em (the font's own metrics), for "Spend". */
const ARIAL_BOLD_SPEND_THOUSANDTHS = 667 + 611 + 556 + 611 + 611;

describe("import fidelity: the development test deck's slides 1, 3 and 6", () => {
  const plan = planOf(RECORDED);

  test("slide 1 is blank in Slides too: two placeholders with no text import as two empty bodies", () => {
    const slide = slideAt({ plan, index: 0 });
    assert.equal(slide.elements.length, 2);
    for (const element of slide.elements) {
      const shape = asShape(element);
      assert.equal(plainText({ body: shape.text, slideNumber: 1 }), "", `${shape.id} has text`);
    }
  });

  test("slide 3 keeps Slides' own overlapping paragraph frames, to the hundredth of a unit", () => {
    const first = shapeById({ plan, slideIndex: 1, elementId: "sasha_tmjoi2szdday_text3" });
    const second = shapeById({ plan, slideIndex: 1, elementId: "sasha_tmjoi2szdday_text4" });
    // Columns: element, translateY and scaleY of the 3,000,000 unit box, as recorded.
    const rows = [
      { shape: first, translateY: 2_375_154, scaleY: 0.2019 },
      { shape: second, translateY: 2_909_435, scaleY: 0.2019 },
    ];
    for (const row of rows) {
      assertClose({ actual: row.shape.frame.y, expected: row.translateY * UNITS_PER_ENGLISH_METRIC_UNIT, label: `${row.shape.id} y` });
      assertClose({ actual: row.shape.frame.height, expected: 3_000_000 * row.scaleY * UNITS_PER_ENGLISH_METRIC_UNIT, label: `${row.shape.id} height` });
      assert.equal(row.shape.text.paragraphs[0]?.style.lineSpacing, 1.337, `${row.shape.id} line spacing`);
      assert.equal(row.shape.text.paragraphs[0]?.style.spaceAbove, 0, `${row.shape.id} space above`);
      assert.equal(row.shape.text.paragraphs[0]?.style.spaceBelow, 0, `${row.shape.id} space below`);
    }
    // The overlap is the deck's: the first box ends below where the second begins.
    assert.ok(first.frame.y + first.frame.height > second.frame.y, "the recorded frames overlap in Slides");
  });

  test('slide 6 "Spend": the frame, inset, indents and size are Slides\', so it wraps where Slides wraps', () => {
    const spend = shapeById({ plan, slideIndex: 2, elementId: "sasha_3j4z7gwb53h0_text10" });
    assertClose({ actual: spend.frame.width, expected: 3_000_000 * 0.3813 * UNITS_PER_ENGLISH_METRIC_UNIT, label: "width" });
    assert.deepEqual(
      [spend.textBox.paddingLeft, spend.textBox.paddingRight, spend.textBox.wrap, spend.textBox.autofit],
      [TEXT_INSET, TEXT_INSET, true, "none"],
    );
    const paragraph = spend.text.paragraphs[0];
    assert.deepEqual([paragraph?.style.indentStart, paragraph?.style.indentFirstLine, paragraph?.style.list], [0, 0, { kind: "none" }]);
    const fontSize = paragraph?.runs[0]?.style.fontSize ?? 0;
    assertClose({ actual: fontSize, expected: 26.44 * UNITS_PER_POINT, label: "font size" });
    // Why it wraps in both: the word is wider than the frame less its two insets.
    const wordWidth = (ARIAL_BOLD_SPEND_THOUSANDTHS / 1000) * fontSize;
    assert.ok(wordWidth > spend.frame.width - 2 * TEXT_INSET, `"Spend" ${wordWidth} fits ${spend.frame.width - 2 * TEXT_INSET}`);
  });
});

describe("paragraph indents cross in both directions", () => {
  test("an engine hanging indent exports as Slides' start-edge first-line indent: 64 / -32 units -> 36 / 18 points", () => {
    const style: ParagraphStylePatch = { indentStart: 64, indentFirstLine: -32 };
    const requests = textRequests({
      objectId: "box",
      body: { paragraphs: [{ style, runs: [{ kind: "text", text: "Spend", style: {} }] }] },
      role: null,
      cellLocation: null,
      context: { theme: planOf(RECORDED).theme, pointsPerUnit: 1 / UNITS_PER_POINT, slideNumber: 1, exportedSlideIds: new Set(), losses: createLossCollector().sink },
    });
    const paragraphStyle = requests.flatMap((request) => ("updateParagraphStyle" in request ? [request.updateParagraphStyle.style] : []))[0];
    assert.deepEqual([paragraphStyle?.indentStart?.magnitude, paragraphStyle?.indentFirstLine?.magnitude], [36, 18]);
  });
});

function planOf(raw: unknown): ImportPlan {
  const parsed = parsePresentation(raw);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return planImport({ presentation: parsed.presentation, images: new Map(), idSeed: { sessionPrefix: "Fidelity", counter: 0 } });
}

function slideAt(options: Readonly<{ plan: ImportPlan; index: number }>): SlideSnapshot {
  const slide = options.plan.slides[options.index];
  if (slide === undefined) throw new Error(`no slide ${options.index}`);
  return slide;
}

function shapeById(options: Readonly<{ plan: ImportPlan; slideIndex: number; elementId: string }>): ShapeElement {
  const element = slideAt({ plan: options.plan, index: options.slideIndex }).elements.find((candidate) => candidate.id === options.elementId);
  if (element === undefined) throw new Error(`no ${options.elementId}`);
  return asShape(element);
}

function asShape(element: ElementSnapshot): ShapeElement {
  if (element.kind !== "shape") throw new Error(`${element.id} is a ${element.kind}`);
  return element;
}

function assertClose(options: Readonly<{ actual: number; expected: number; label: string }>): void {
  assert.ok(Math.abs(options.actual - options.expected) < 0.01, `${options.label}: ${options.actual} vs ${options.expected}`);
}
