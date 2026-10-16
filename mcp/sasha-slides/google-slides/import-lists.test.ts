/**
 * LISTS AND SOFT LINE BREAKS on import, on RECORDED `presentations.get` answers:
 *  - fixtures/lists-complex-slides-24-30.json: the complex SxS deck (html2slides fixtures uploaded by
 *    the forward converter) trimmed to slide 24's paragraph with "containers.\v\v Each level" and
 *    slide 30's KEY PRIORITIES list (8 bullets: dots in blue, red, green and orange before grey
 *    text, both 6.75 points) and its soft-break box;
 *  - fixtures/lists-deck-slide-08.json: the development test deck
 *    (1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U, read only) trimmed to slide 8's "Next steps"
 *    list, whose bullets have Slides' default indents and the text's own colour and size.
 *
 * The reverse round trip showed the coloured dots grey (the bullet's `bulletStyle` was never
 * read). These tests hold the import to Google's bullet styles, and to writing nothing extra where
 * the bullet matches its text, so lists made anywhere else keep their old shape. The size path is
 * covered with a hand-changed copy of the same paragraph, because no recorded deck has one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ElementSnapshot, ShapeElement } from "../engine/src/contracts/document.ts";
import type { ListMembership } from "../engine/src/contracts/style.ts";
import { planImport, type ImportPlan } from "./import-presentation.ts";
import { parsePresentation } from "./slides-presentation.ts";

const COMPLEX: unknown = JSON.parse(readFileSync(new URL("./fixtures/lists-complex-slides-24-30.json", import.meta.url), "utf-8"));
const DECK: unknown = JSON.parse(readFileSync(new URL("./fixtures/lists-deck-slide-08.json", import.meta.url), "utf-8"));
const UNITS_PER_POINT = 1280 / 720;
/** The html2slides fixture's dot colours (slide_30.html), as Slides reports them. */
const BLUE = "#4a6cf7";
const RED = "#e53e3e";
const GREEN = "#38a169";
const ORANGE = "#dd6b20";

describe("a bullet's own colour and size cross as the marker's", () => {
  test("complex 30: eight dots keep their colours, in order; their size is the text's, so none is written", () => {
    const shape = shapeById({ plan: planOf(COMPLEX), slideIndex: 1, elementId: "p30_i6" });
    const lists = shape.text.paragraphs.map((paragraph) => listOf(paragraph.style.list));
    assert.deepEqual(
      lists.map((list) => list?.markerColour),
      [BLUE, RED, GREEN, BLUE, ORANGE, BLUE, GREEN, BLUE],
    );
    assert.deepEqual(new Set(lists.map((list) => list?.markerFontSize)), new Set([undefined]));
    assert.equal(shape.text.paragraphs[0]?.runs[0]?.style.fontSize, roundUnits(6.75 * UNITS_PER_POINT));
  });

  test("a bullet larger than its text writes its size", () => {
    const shape = shapeById({ plan: planOf(withBulletSize({ raw: COMPLEX, objectId: "p30_i6", points: 13.5 })), slideIndex: 1, elementId: "p30_i6" });
    const list = listOf(shape.text.paragraphs[0]?.style.list);
    assert.deepEqual([list?.markerColour, list?.markerFontSize], [BLUE, roundUnits(13.5 * UNITS_PER_POINT)]);
  });

  test("deck 8 (control): a bullet styled like its text writes no marker style, and keeps Slides' 36 / 18 point indents", () => {
    const shape = shapeById({ plan: planOf(DECK), slideIndex: 0, elementId: "sasha_6ge72p90vs1x_list4" });
    for (const paragraph of shape.text.paragraphs) {
      const list = listOf(paragraph.style.list);
      assert.ok(list !== null, "a list paragraph");
      assert.deepEqual([list.markerColour, list.markerFontSize], [undefined, undefined]);
      assert.deepEqual([paragraph.style.indentStart, paragraph.style.indentFirstLine], [64, -32]);
    }
  });
});

describe("a soft line break stays the engine's U+000B", () => {
  test("complex 24: 'containers.\\v\\v Each level' keeps both breaks inside one paragraph", () => {
    const shape = shapeById({ plan: planOf(COMPLEX), slideIndex: 0, elementId: "p24_i7" });
    const texts = shape.text.paragraphs.map((paragraph) => paragraph.runs.map((run) => (run.kind === "text" ? run.text : "")).join(""));
    const withBreaks = texts.filter((text) => text.includes("containers.\u000B\u000B Each level"));
    assert.equal(withBreaks.length, 1, JSON.stringify(texts));
  });
});

/** A deep copy of `raw` whose `objectId` shape's bullets are `points` large. */
function withBulletSize(options: Readonly<{ raw: unknown; objectId: string; points: number }>): unknown {
  return JSON.parse(JSON.stringify(options.raw), (key: string, value: unknown) => {
    if (key !== "bulletStyle" || typeof value !== "object" || value === null) return value;
    return { ...value, fontSize: { magnitude: options.points, unit: "PT" } };
  });
}

function planOf(raw: unknown): ImportPlan {
  const parsed = parsePresentation(raw);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return planImport({ presentation: parsed.presentation, images: new Map(), idSeed: { sessionPrefix: "Lists", counter: 0 }, pptxSupplement: null });
}

function shapeById(options: Readonly<{ plan: ImportPlan; slideIndex: number; elementId: string }>): ShapeElement {
  const slide = options.plan.slides[options.slideIndex];
  if (slide === undefined) throw new Error(`no slide ${options.slideIndex}`);
  const element = findElement(slide.elements, options.elementId);
  if (element === undefined) throw new Error(`no ${options.elementId}`);
  if (element.kind !== "shape") throw new Error(`${element.id} is a ${element.kind}`);
  return element;
}

function findElement(elements: readonly ElementSnapshot[], id: string): ElementSnapshot | undefined {
  return elements.find((candidate) => candidate.id === id);
}

function listOf(list: ShapeElement["text"]["paragraphs"][number]["style"]["list"]): ListMembership | null {
  return list?.kind === "list" ? list : null;
}

function roundUnits(value: number): number {
  return Math.round(value * 1000) / 1000;
}
