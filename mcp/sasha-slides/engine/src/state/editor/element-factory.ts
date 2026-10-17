// BUILDING COMPLETE ELEMENTS AND SLIDES. Commands carry complete values with caller-chosen ids
// (contracts/commands.ts), so creating, duplicating, pasting and laying out all produce full element
// trees here, with ids from the reduce step's minter. Two rules matter beyond defaults:
//
//  * RE-IDENTIFYING keeps or replaces each id independently (a cut pasted back into its deck keeps
//    every id that is still free, so comments stay on their element) and, unless asked otherwise,
//    keeps morph keys, so a duplicated slide still morphs like Keynote's Magic Move.
//  * A SLIDE'S BUILD SEQUENCE FOLLOWS ITS ELEMENTS: re-identifying a slide remaps every step to the
//    copy's element and mints fresh step ids (`reidentifySlide`).
//  * TRANSLATING a tree moves leaves and line end points; a group's frame is derived by the model and
//    moved only so the value stays consistent.

import {
  assertNever,
  DEFAULT_TEXT_BOX_STYLE,
  EMPTY_TEXT_BODY,
  identityFrame,
  lineFrame,
  NEW_TEXT_BOX_STYLE,
  PLAIN_BOX_STYLE,
  themeColour,
  type AnimationStep,
  type AssetRecord,
  type Box,
  type ElementId,
  type ElementSnapshot,
  type ImageElement,
  type InsertTool,
  type LineElement,
  type Point,
  type ShapeElement,
  type ShapePreset,
  type SlideId,
  type SlideSnapshot,
  type TableElement,
  type TextBody,
} from "../../contracts/index.ts";
import { DEFAULT_STROKE, isTextBoxPreset } from "../../shared/element-defaults.ts";
import { childrenOf } from "./document-lookup.ts";
import type { IdMinter } from "./id-minter.ts";

export function createShape(options: Readonly<{ id: ElementId; preset: ShapePreset; box: Box; text: TextBody }>): ShapeElement {
  const isTextBox = isTextBoxPreset(options.preset);
  return {
    kind: "shape",
    id: options.id,
    name: "",
    description: "",
    frame: identityFrame(options.box),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    preset: options.preset,
    customOutline: null,
    box: isTextBox ? PLAIN_BOX_STYLE : { ...PLAIN_BOX_STYLE, fill: { kind: "solid", colour: themeColour({ slot: "accent1", alpha: 1 }) } },
    textBox: isTextBox ? NEW_TEXT_BOX_STYLE : DEFAULT_TEXT_BOX_STYLE,
    text: options.text,
  };
}

export function createLine(options: Readonly<{ id: ElementId; tool: Extract<InsertTool, { kind: "line" }>; start: Point; end: Point }>): LineElement {
  return {
    kind: "line",
    id: options.id,
    name: "",
    description: "",
    frame: lineFrame({ start: options.start, end: options.end }),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    start: options.start,
    end: options.end,
    routing: options.tool.routing,
    stroke: DEFAULT_STROKE,
    startArrow: options.tool.startArrow,
    endArrow: options.tool.endArrow,
    opacity: 1,
  };
}

export function createTable(options: Readonly<{ id: ElementId; minter: IdMinter; rowCount: number; columnCount: number; box: Box }>): TableElement {
  const rowCount = Math.max(1, Math.round(options.rowCount));
  const columnCount = Math.max(1, Math.round(options.columnCount));
  const columns = Array.from({ length: columnCount }, () => ({ id: options.minter.next("tableColumn"), width: options.box.width / columnCount }));
  const rows = Array.from({ length: rowCount }, () => ({ id: options.minter.next("tableRow"), minimumHeight: options.box.height / rowCount }));
  const stroke = { width: 1, colour: themeColour({ slot: "dark2", alpha: 1 }), dash: "solid" as const };
  return {
    kind: "table",
    id: options.id,
    name: "",
    description: "",
    frame: identityFrame(options.box),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    columns,
    rows,
    cells: rows.flatMap((row) =>
      columns.map((column) => ({
        rowId: row.id,
        columnId: column.id,
        rowSpan: 1,
        columnSpan: 1,
        fill: { kind: "none" as const },
        borders: { top: stroke, right: stroke, bottom: stroke, left: stroke },
        textBox: { ...DEFAULT_TEXT_BOX_STYLE, paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 },
        text: EMPTY_TEXT_BODY,
      })),
    ),
    opacity: 1,
  };
}

/** An image at its pixel size, scaled down to fit inside the slide and centred on `centre`. */
export function createImage(options: Readonly<{ id: ElementId; asset: AssetRecord; centre: Point; slide: Box }>): ImageElement {
  const pixelWidth = Math.max(1, options.asset.pixelWidth);
  const pixelHeight = Math.max(1, options.asset.pixelHeight);
  const fit = Math.min(1, (options.slide.width * 0.8) / pixelWidth, (options.slide.height * 0.8) / pixelHeight);
  const width = pixelWidth * fit;
  const height = pixelHeight * fit;
  return {
    kind: "image",
    id: options.id,
    name: options.asset.name,
    description: "",
    frame: identityFrame({ x: options.centre.x - width / 2, y: options.centre.y - height / 2, width, height }),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    assetId: options.asset.id,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    box: PLAIN_BOX_STYLE,
  };
}

/** A text box holding `text`, as pasting text onto the canvas creates. */
export function textBodyFromPlainText(text: string): TextBody {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  return { paragraphs: lines.map((line) => ({ style: {}, runs: line.length === 0 ? [] : [{ kind: "text", text: line, style: {} }] })) };
}

export type Reidentify = Readonly<{
  minter: IdMinter;
  /** True: keep this id (a cut pasted into its own deck, where the id is free). */
  keepElementId: (elementId: ElementId) => boolean;
  /** False: the copy gets its own morph key (duplicating elements on one slide). */
  keepMorphKeys: boolean;
}>;

/** The element tree with ids kept or freshly minted, child `groupId`s pointing at the new parents. */
export function reidentifyElement(element: ElementSnapshot, options: Reidentify, groupId: ElementId | null): ElementSnapshot {
  const id = options.keepElementId(element.id) ? element.id : options.minter.next("element");
  const morphKey = options.keepMorphKeys ? element.morphKey : id;
  switch (element.kind) {
    case "group":
      return { ...element, id, morphKey, groupId, children: element.children.map((child) => reidentifyElement(child, options, id)) };
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return { ...element, id, morphKey, groupId };
    default:
      return assertNever(element);
  }
}

/**
 * The slide with its element trees re-identified and its build sequence carried along: each step
 * names the copy's element and gets a fresh id; a step whose element is not on the slide (left
 * dangling by a concurrent delete) is dropped, since nothing in the copy could play it.
 */
export function reidentifySlide(slide: SlideSnapshot, options: Reidentify & Readonly<{ keepSlideId: (slideId: SlideId) => boolean }>): SlideSnapshot {
  const id = options.keepSlideId(slide.id) ? slide.id : options.minter.next("slide");
  const elements = slide.elements.map((element) => reidentifyElement(element, options, null));
  const copyOf = copiedElementIds({ originals: slide.elements, copies: elements });
  const animations = slide.animations.flatMap((step): AnimationStep[] => {
    const elementId = copyOf.get(step.elementId);
    return elementId === undefined ? [] : [{ ...step, id: options.minter.next("animationStep"), elementId }];
  });
  return { ...slide, id, elements, animations };
}

export function translateElement(element: ElementSnapshot, deltaX: number, deltaY: number): ElementSnapshot {
  const frame = { ...element.frame, x: element.frame.x + deltaX, y: element.frame.y + deltaY };
  switch (element.kind) {
    case "group":
      return { ...element, frame, children: element.children.map((child) => translateElement(child, deltaX, deltaY)) };
    case "line":
      return { ...element, frame, start: { x: element.start.x + deltaX, y: element.start.y + deltaY }, end: { x: element.end.x + deltaX, y: element.end.y + deltaY } };
    case "shape":
    case "image":
    case "table":
    case "unsupported":
      return { ...element, frame };
    default:
      return assertNever(element);
  }
}

/** Every element id in the trees, groups included. */
export function elementIdsOf(elements: readonly ElementSnapshot[]): readonly ElementId[] {
  return elements.flatMap((element) => {
    switch (element.kind) {
      case "group":
        return [element.id, ...elementIdsOf(element.children)];
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        return [element.id];
      default:
        return assertNever(element);
    }
  });
}

/** Original element id to its copy's, by walking the two trees side by side (reidentifyElement keeps the shape). */
function copiedElementIds(options: Readonly<{ originals: readonly ElementSnapshot[]; copies: readonly ElementSnapshot[] }>): ReadonlyMap<ElementId, ElementId> {
  const pairs = new Map<ElementId, ElementId>();
  const visit = (originals: readonly ElementSnapshot[], copies: readonly ElementSnapshot[]): void => {
    originals.forEach((original, index) => {
      const copy = copies[index];
      if (copy === undefined) return;
      pairs.set(original.id, copy.id);
      visit(childrenOf(original), childrenOf(copy));
    });
  };
  visit(options.originals, options.copies);
  return pairs;
}
