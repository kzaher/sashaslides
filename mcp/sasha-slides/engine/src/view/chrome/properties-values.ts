// WHAT THE PROPERTIES PANEL SHOWS, as pure values of the editor state: which elements the panel
// edits, the value each control shows across them ("mixed" when they differ), the controls a newer
// version's value locks, and the event an edited field becomes. The panel component only draws
// these, so acceptance test 5 is a test of values, not of a page.
//
// Key decisions:
//
//  * FONT SIZES ARE POINTS IN THE PANEL, SLIDE UNITS IN THE DOCUMENT (style.ts `RunStyle.fontSize`):
//    32 units show as 18; typing 24 dispatches 42.67 units, rounded to hundredths so the document
//    never stores 42.666666... and the panel shows exactly what was typed.
//  * MIXED IS A VALUE. A control over several elements or runs that disagree shows an empty field
//    with a "mixed" placeholder; typing into it sets every one of them.
//  * A VALUE FROM A NEWER VERSION LOCKS ITS CONTROL. An element listing a key in `unsupportedKeys`
//    holds something this client cannot show faithfully; the control for that key is disabled with
//    an explanation, and the editor never writes that key (document.ts "values from newer clients
//    survive").

import { assertNever } from "../../contracts/assert-never.ts";
import { textRunLength, type ElementSnapshot, type SlideSnapshot, type TextBody } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorState } from "../../contracts/editor-state.ts";
import { pointsFromSlideUnits, rotatedBounds, slideUnitsFromPoints } from "../../contracts/geometry.ts";
import type { CellAddress, TextTarget } from "../../contracts/selection.ts";
import type { Colour, NoColour, ParagraphStyle, RunStyle } from "../../contracts/style.ts";
import type { ElementKey } from "../../contracts/yjs-schema.ts";
import { findElement, visibleFrame } from "../canvas/canvas-geometry.ts";
import { paragraphBaseRunStyle, resolveParagraphStyle, resolveRunStyle, textStyleContextOf, type TextStyleContext } from "../render/text-layout.ts";

/** One control's value across everything it edits. */
export type SharedValue<TValue> = Readonly<{ kind: "value"; value: TValue }> | Readonly<{ kind: "mixed" }> | Readonly<{ kind: "none" }>;

export const MIXED_PLACEHOLDER = "mixed";

export function sharedValue<TValue>(values: readonly TValue[], equal: (first: TValue, second: TValue) => boolean = Object.is): SharedValue<TValue> {
  const first = values[0];
  if (first === undefined) return { kind: "none" };
  return values.every((value) => equal(value, first)) ? { kind: "value", value: first } : { kind: "mixed" };
}

/** What the panel is editing. */
export type PanelSubject =
  | Readonly<{ kind: "elements"; slide: SlideSnapshot; elements: readonly ElementSnapshot[] }>
  /** Text editing or table cells: the element holding the text, and the range inside it. */
  | Readonly<{ kind: "text"; slide: SlideSnapshot; element: ElementSnapshot; target: TextTarget; start: number; end: number }>
  | Readonly<{ kind: "slide"; slide: SlideSnapshot }>
  | Readonly<{ kind: "none" }>;

export function panelSubject(state: EditorState): PanelSubject {
  const current = state.document.slides.find((slide) => slide.id === state.currentSlideId) ?? null;
  const selection = state.selection;
  switch (selection.kind) {
    case "elements": {
      const slide = state.document.slides.find((candidate) => candidate.id === selection.slideId) ?? null;
      if (slide === null) return { kind: "none" };
      const elements = selection.elementIds.map((id) => findElement(slide.elements, id)).filter((element): element is ElementSnapshot => element !== null);
      return elements.length === 0 ? { kind: "slide", slide } : { kind: "elements", slide, elements };
    }
    case "text": {
      const target = selection.target;
      const slide = state.document.slides.find((candidate) => candidate.id === target.slideId) ?? null;
      if (slide === null) return { kind: "none" };
      const elementId = textTargetElement(target);
      const element = elementId === null ? null : findElement(slide.elements, elementId);
      if (element === null) return { kind: "slide", slide };
      return { kind: "text", slide, element, target, start: Math.min(selection.anchor, selection.focus), end: Math.max(selection.anchor, selection.focus) };
    }
    case "tableCells": {
      const slide = state.document.slides.find((candidate) => candidate.id === selection.slideId) ?? null;
      const element = slide === null ? null : findElement(slide.elements, selection.elementId);
      if (slide === null || element === null) return { kind: "none" };
      return { kind: "text", slide, element, target: { kind: "tableCell", slideId: slide.id, elementId: element.id, cell: selection.anchor }, start: 0, end: Number.POSITIVE_INFINITY };
    }
    case "slides":
    case "none":
      return current === null ? { kind: "none" } : { kind: "slide", slide: current };
    default:
      return assertNever(selection);
  }
}

/** The text style values the Text tab shows. */
export type TextValues = Readonly<{
  fontFamily: SharedValue<string>;
  /** Points, rounded to one decimal (see the header). */
  fontSizePoints: SharedValue<number>;
  fontWeight: SharedValue<number>;
  italic: SharedValue<boolean>;
  underline: SharedValue<boolean>;
  strikethrough: SharedValue<boolean>;
  baselineOffset: SharedValue<RunStyle["baselineOffset"]>;
  textCase: SharedValue<RunStyle["textCase"]>;
  letterSpacing: SharedValue<number>;
  colour: SharedValue<Colour>;
  highlight: SharedValue<Colour | NoColour>;
  alignment: SharedValue<ParagraphStyle["alignment"]>;
  lineSpacing: SharedValue<number>;
  spaceAbove: SharedValue<number>;
  spaceBelow: SharedValue<number>;
  indentStart: SharedValue<number>;
  indentFirstLine: SharedValue<number>;
  direction: SharedValue<ParagraphStyle["direction"]>;
  listKind: SharedValue<"none" | "bulleted" | "numbered">;
}>;

export function textValues(state: EditorState): TextValues {
  const subject = panelSubject(state);
  const sources = textSources(subject, state);
  const runs = sources.flatMap((source) => source.runs);
  const paragraphs = sources.flatMap((source) => source.paragraphs);
  return {
    fontFamily: sharedValue(runs.map((style) => style.fontFamily)),
    fontSizePoints: sharedValue(runs.map((style) => roundTo(pointsFromSlideUnits(style.fontSize), 1))),
    fontWeight: sharedValue(runs.map((style) => style.fontWeight)),
    italic: sharedValue(runs.map((style) => style.fontStyle === "italic")),
    underline: sharedValue(runs.map((style) => style.underline)),
    strikethrough: sharedValue(runs.map((style) => style.strikethrough)),
    baselineOffset: sharedValue(runs.map((style) => style.baselineOffset)),
    textCase: sharedValue(runs.map((style) => style.textCase)),
    letterSpacing: sharedValue(runs.map((style) => style.letterSpacing)),
    colour: sharedValue(runs.map((style) => style.colour), sameValue),
    highlight: sharedValue(runs.map((style) => style.highlight), sameValue),
    alignment: sharedValue(paragraphs.map((style) => style.alignment)),
    lineSpacing: sharedValue(paragraphs.map((style) => style.lineSpacing)),
    spaceAbove: sharedValue(paragraphs.map((style) => style.spaceAbove)),
    spaceBelow: sharedValue(paragraphs.map((style) => style.spaceBelow)),
    indentStart: sharedValue(paragraphs.map((style) => style.indentStart)),
    indentFirstLine: sharedValue(paragraphs.map((style) => style.indentFirstLine)),
    direction: sharedValue(paragraphs.map((style) => style.direction)),
    listKind: sharedValue(paragraphs.map((style) => listKindOf(style))),
  };
}

/** The event a font size typed in points becomes; null for text that is not a usable size. */
export function fontSizeEvent(pointsText: string): EditorEvent | null {
  const points = Number(pointsText.trim());
  if (!Number.isFinite(points) || points <= 0 || points > 2000) return null;
  return { kind: "runStyleRequested", patch: { fontSize: roundTo(slideUnitsFromPoints(points), 2) }, clear: [] };
}

/** The frame fields the Arrange tab shows, slide units and degrees. */
export type FrameValues = Readonly<{ x: SharedValue<number>; y: SharedValue<number>; width: SharedValue<number>; height: SharedValue<number>; rotation: SharedValue<number> }>;

export function frameValues(state: EditorState): FrameValues {
  const subject = panelSubject(state);
  const elements = subjectElements(subject);
  const frames = elements.map((element) => visibleFrame({ element, measured: state.measuredLayouts }));
  const bounds = frames.map(rotatedBounds);
  return {
    x: sharedValue(bounds.map((box) => roundTo(box.x, 1))),
    y: sharedValue(bounds.map((box) => roundTo(box.y, 1))),
    width: sharedValue(frames.map((frame) => roundTo(frame.width, 1))),
    height: sharedValue(frames.map((frame) => roundTo(frame.height, 1))),
    rotation: sharedValue(frames.map((frame) => roundTo(frame.rotation, 1))),
  };
}

/** The elements a style control edits: the selection, or the element whose text is being edited. */
export function subjectElements(subject: PanelSubject): readonly ElementSnapshot[] {
  switch (subject.kind) {
    case "elements":
      return subject.elements;
    case "text":
      return [subject.element];
    case "slide":
    case "none":
      return [];
    default:
      return assertNever(subject);
  }
}

/** The panel's controls and the element key each one writes. */
export type PanelControl = "frame" | "fill" | "border" | "cornerRadius" | "shadow" | "opacity" | "textBox" | "text" | "preset" | "stroke" | "crop";

export const CONTROL_KEY: Readonly<Record<PanelControl, ElementKey>> = {
  frame: "frame",
  fill: "fill",
  border: "border",
  cornerRadius: "cornerRadius",
  shadow: "shadow",
  opacity: "opacity",
  textBox: "textBox",
  text: "text",
  preset: "preset",
  stroke: "stroke",
  crop: "crop",
};

/** Why a control is locked for these elements, or null when it is editable (see the header). */
export function lockedExplanation(options: Readonly<{ elements: readonly ElementSnapshot[]; control: PanelControl }>): string | null {
  const key = CONTROL_KEY[options.control];
  const locked = options.elements.some((element) => element.unsupportedKeys.includes(key) || element.kind === "unsupported");
  if (!locked) return null;
  return "Made with a newer version of Sasha. This value is kept as it is and cannot be changed here.";
}

/** Equality for small style values (colours): same fields, same values. */
export function sameValue<TValue>(first: TValue, second: TValue): boolean {
  return first === second || JSON.stringify(first) === JSON.stringify(second);
}

/** Rounds to `digits` decimals, without -0. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

type TextSource = Readonly<{ runs: readonly RunStyle[]; paragraphs: readonly ParagraphStyle[] }>;

function textSources(subject: PanelSubject, state: EditorState): readonly TextSource[] {
  switch (subject.kind) {
    case "elements":
      return subject.elements.flatMap((element) => elementBodies(element).map((body) => bodySource({ body, context: textStyleContextOf({ theme: state.document.theme, element }), start: 0, end: Number.POSITIVE_INFINITY })));
    case "text": {
      const body = bodyOfTarget(subject.element, subject.target);
      if (body === null) return [];
      const context = textStyleContextOf({ theme: state.document.theme, element: subject.element });
      const source = bodySource({ body, context, start: subject.start, end: subject.end });
      if (subject.start !== subject.end || Object.keys(state.textEditing.typingStyle).length === 0) return [source];
      return [{ ...source, runs: source.runs.map((style) => ({ ...style, ...definedPatch(state.textEditing.typingStyle) })) }];
    }
    case "slide":
    case "none":
      return [];
    default:
      return assertNever(subject);
  }
}

/** The resolved run and paragraph styles of a body's characters in [start, end); a caret reads the run before it. */
function bodySource(options: Readonly<{ body: TextBody; context: TextStyleContext; start: number; end: number }>): TextSource {
  const runs: RunStyle[] = [];
  const paragraphs: ParagraphStyle[] = [];
  const caret = options.start === options.end;
  let index = 0;
  let caretRun: RunStyle | null = null;
  for (const paragraph of options.body.paragraphs) {
    const paragraphStart = index;
    let touched = false;
    if (paragraph.runs.length === 0 && (caret ? options.start === index : options.start <= index && index < options.end)) {
      runs.push(paragraphBaseRunStyle({ context: options.context, paragraph }));
      touched = true;
    }
    for (const run of paragraph.runs) {
      const length = textRunLength(run);
      const style = resolveRunStyle({ context: options.context, patch: run.style });
      if (caret) {
        if (index < options.start && options.start <= index + length) caretRun = style;
        if (index === options.start && caretRun === null) caretRun = style;
      } else if (index < options.end && index + length > options.start) {
        runs.push(style);
        touched = true;
      }
      index += length;
    }
    if (caret && options.start >= paragraphStart && options.start <= index) touched = true;
    if (touched) paragraphs.push(resolveParagraphStyle({ context: options.context, patch: paragraph.style }));
    index += 1;
  }
  if (caret && caretRun !== null) runs.push(caretRun);
  return { runs, paragraphs };
}

function elementBodies(element: ElementSnapshot): readonly TextBody[] {
  switch (element.kind) {
    case "shape":
      return [element.text];
    case "table":
      return element.cells.map((cell) => cell.text);
    case "group":
      return element.children.flatMap(elementBodies);
    case "image":
    case "line":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function bodyOfTarget(element: ElementSnapshot, target: TextTarget): TextBody | null {
  switch (target.kind) {
    case "element":
      return elementBodies(element)[0] ?? null;
    case "tableCell":
      return tableCellBody(element, target.cell);
    case "speakerNotes":
      return null;
    default:
      return assertNever(target);
  }
}

function tableCellBody(element: ElementSnapshot, cell: CellAddress): TextBody | null {
  switch (element.kind) {
    case "table":
      return element.cells.find((candidate) => candidate.rowId === cell.rowId && candidate.columnId === cell.columnId)?.text ?? null;
    case "shape":
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function textTargetElement(target: TextTarget): ElementSnapshot["id"] | null {
  switch (target.kind) {
    case "element":
    case "tableCell":
      return target.elementId;
    case "speakerNotes":
      return null;
    default:
      return assertNever(target);
  }
}

function listKindOf(style: ParagraphStyle): "none" | "bulleted" | "numbered" {
  const list = style.list;
  switch (list.kind) {
    case "none":
      return "none";
    case "list":
      return NUMBERED_GLYPHS.has(list.glyph) ? "numbered" : "bulleted";
    default:
      return assertNever(list);
  }
}

const NUMBERED_GLYPHS: ReadonlySet<string> = new Set(["decimal", "decimalZeroPadded", "upperAlphabetic", "lowerAlphabetic", "upperRoman", "lowerRoman"]);

function definedPatch(patch: Partial<RunStyle>): Partial<RunStyle> {
  return Object.fromEntries(Object.entries(patch).filter((entry) => entry[1] !== undefined));
}
