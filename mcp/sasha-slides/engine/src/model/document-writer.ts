// WRITING VALUES INTO THE Y.Doc, exactly as yjs-schema.ts lays them out. Callers are inside a
// transaction (command-application.ts, the seed, repairs); nothing here validates -- commands are
// validated before anything is written (command-validation.ts), because a transaction cannot be
// rolled back.
//
// The layout rules that matter here:
//  * the frame, a line's two end points and each style group are ONE plain value each;
//  * a group stores only its rotation, and its children are written as separate elements with
//    `groupId` derived from the tree (a disagreeing `groupId` field in the input is ignored);
//  * every text body is a Y.Text written with the attribute rules of text-body.ts;
//  * a table stores row and column id ARRAYS, size maps keyed by id, and cell maps keyed
//    "rowId|columnId";
//  * a slide's build steps are maps under `animations`, each with its own order key and one plain
//    value per field (yjs-schema.ts), so concurrent edits to different fields of a step both land.

import * as Y from "yjs";
import type { AnimationStep } from "../contracts/animations.ts";
import type { ElementSnapshot, LayoutSnapshot, SlideSnapshot, TableCell, TableElement, TextBody, ThemeSnapshot } from "../contracts/document.ts";
import type { ElementId, RandomSource } from "../contracts/ids.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { DOCUMENT_SCHEMA_VERSION, EMPTY_TEXT_BODY } from "../contracts/document.ts";
import { ANIMATION_STEP_KEY, ELEMENT_KEY, LAYOUT_KEY, META_KEY, SLIDE_KEY, TABLE_CELL_KEY, tableCellKey, THEME_KEY } from "../contracts/yjs-schema.ts";
import type { BlankDeck } from "./blank-deck.ts";
import type { DocumentRoots } from "./document-paths.ts";
import { defaultTableCell } from "./element-tree.ts";
import { mintOrderKeys } from "./order-keys.ts";
import { writeTextBody } from "./text-body.ts";

/** Write element trees into `elementsMap` under `groupId`, the top-level items taking `keys` in order. */
export function writeElementTrees(
  options: Readonly<{ elementsMap: Y.Map<unknown>; elements: readonly ElementSnapshot[]; groupId: ElementId | null; keys: readonly string[]; random: RandomSource }>,
): void {
  options.elements.forEach((element, index) => {
    const key = options.keys[index];
    if (key === undefined) return;
    writeElement({ elementsMap: options.elementsMap, element, groupId: options.groupId, key, random: options.random });
  });
}

/** Write a new Y.Text holding `body` under `key` of `map`. */
export function setTextBody(options: Readonly<{ map: Y.Map<unknown>; key: string; body: TextBody }>): Y.Text {
  const text = new Y.Text();
  options.map.set(options.key, text);
  writeTextBody(text, options.body.paragraphs.length === 0 ? EMPTY_TEXT_BODY : options.body);
  return text;
}

export function writeSlide(options: Readonly<{ slides: Y.Map<unknown>; slide: SlideSnapshot; key: string; random: RandomSource }>): void {
  const { slide } = options;
  const map = new Y.Map<unknown>();
  options.slides.set(slide.id, map);
  map.set(SLIDE_KEY.id, slide.id);
  map.set(SLIDE_KEY.position, options.key);
  map.set(SLIDE_KEY.layoutId, slide.layoutId);
  map.set(SLIDE_KEY.background, slide.background);
  map.set(SLIDE_KEY.skipped, slide.skipped);
  setTextBody({ map, key: SLIDE_KEY.speakerNotes, body: slide.speakerNotes });
  map.set(SLIDE_KEY.transition, slide.transition);
  writeElementList({ owner: map, elements: slide.elements, random: options.random });
  const animations = new Y.Map<unknown>();
  map.set(SLIDE_KEY.animations, animations);
  const keys = mintOrderKeys({ lower: null, upper: null, count: slide.animations.length, random: options.random }) ?? [];
  slide.animations.forEach((step, index) => {
    const key = keys[index];
    if (key !== undefined) writeAnimationStep({ animations, step, key });
  });
}

/** Write one build step as a new map under `animations`, at order key `key`. */
export function writeAnimationStep(options: Readonly<{ animations: Y.Map<unknown>; step: AnimationStep; key: string }>): void {
  const { step } = options;
  const map = new Y.Map<unknown>();
  options.animations.set(step.id, map);
  map.set(ANIMATION_STEP_KEY.id, step.id);
  map.set(ANIMATION_STEP_KEY.position, options.key);
  map.set(ANIMATION_STEP_KEY.elementId, step.elementId);
  map.set(ANIMATION_STEP_KEY.effect, step.effect);
  map.set(ANIMATION_STEP_KEY.trigger, step.trigger);
  map.set(ANIMATION_STEP_KEY.durationMilliseconds, step.durationMilliseconds);
  map.set(ANIMATION_STEP_KEY.delayMilliseconds, step.delayMilliseconds);
  map.set(ANIMATION_STEP_KEY.easing, step.easing);
}

export function writeLayout(options: Readonly<{ layouts: Y.Map<unknown>; layout: LayoutSnapshot; key: string; random: RandomSource }>): void {
  const { layout } = options;
  const map = new Y.Map<unknown>();
  options.layouts.set(layout.id, map);
  map.set(LAYOUT_KEY.id, layout.id);
  map.set(LAYOUT_KEY.name, layout.name);
  map.set(LAYOUT_KEY.position, options.key);
  map.set(LAYOUT_KEY.background, layout.background);
  writeElementList({ owner: map, elements: layout.elements, random: options.random });
}

/** Replace the `elements` map of a slide or layout with these trees. */
export function writeElementList(options: Readonly<{ owner: Y.Map<unknown>; elements: readonly ElementSnapshot[]; random: RandomSource }>): void {
  const elementsMap = new Y.Map<unknown>();
  options.owner.set(SLIDE_KEY.elements, elementsMap);
  const keys = mintOrderKeys({ lower: null, upper: null, count: options.elements.length, random: options.random }) ?? [];
  writeElementTrees({ elementsMap, elements: options.elements, groupId: null, keys, random: options.random });
}

/** Write every field of a theme patch that is present. */
export function writeThemePatch(options: Readonly<{ theme: Y.Map<unknown>; patch: Partial<ThemeSnapshot> }>): void {
  const { theme, patch } = options;
  if (patch.name !== undefined) theme.set(THEME_KEY.name, patch.name);
  if (patch.colours !== undefined) theme.set(THEME_KEY.colours, patch.colours);
  if (patch.headingFontFamily !== undefined) theme.set(THEME_KEY.headingFontFamily, patch.headingFontFamily);
  if (patch.bodyFontFamily !== undefined) theme.set(THEME_KEY.bodyFontFamily, patch.bodyFontFamily);
  if (patch.background !== undefined) theme.set(THEME_KEY.background, patch.background);
  if (patch.placeholderStyles !== undefined) theme.set(THEME_KEY.placeholderStyles, patch.placeholderStyles);
  if (patch.defaultRunStyle !== undefined) theme.set(THEME_KEY.defaultRunStyle, patch.defaultRunStyle);
}

/** Seed an empty document (document-store.ts, `seed: "blankDeck"`). */
export function writeBlankDeck(options: Readonly<{ roots: DocumentRoots; deck: BlankDeck; createdAt: number; random: RandomSource }>): void {
  const { roots, deck, random } = options;
  roots.meta.set(META_KEY.deckId, deck.deckId);
  roots.meta.set(META_KEY.schemaVersion, DOCUMENT_SCHEMA_VERSION);
  roots.meta.set(META_KEY.title, deck.title);
  roots.meta.set(META_KEY.pageHeight, deck.pageHeight);
  roots.meta.set(META_KEY.createdAt, options.createdAt);
  writeThemePatch({ theme: roots.theme, patch: deck.theme });
  const layoutKeys = mintOrderKeys({ lower: null, upper: null, count: deck.layouts.length, random }) ?? [];
  deck.layouts.forEach((layout, index) => writeLayout({ layouts: roots.layouts, layout, key: layoutKeys[index] ?? "V", random }));
  const slideKeys = mintOrderKeys({ lower: null, upper: null, count: deck.slides.length, random }) ?? [];
  deck.slides.forEach((slide, index) => writeSlide({ slides: roots.slides, slide, key: slideKeys[index] ?? "V", random }));
}

/** A new, empty table cell map under `cells` (the first edit of a missing cell creates it). */
export function createCellMap(options: Readonly<{ cells: Y.Map<unknown>; cell: TableCell }>): Y.Map<unknown> {
  const { cell } = options;
  const map = new Y.Map<unknown>();
  options.cells.set(tableCellKey({ rowId: cell.rowId, columnId: cell.columnId }), map);
  map.set(TABLE_CELL_KEY.rowSpan, cell.rowSpan);
  map.set(TABLE_CELL_KEY.columnSpan, cell.columnSpan);
  map.set(TABLE_CELL_KEY.fill, cell.fill);
  map.set(TABLE_CELL_KEY.borders, cell.borders);
  map.set(TABLE_CELL_KEY.textBox, cell.textBox);
  setTextBody({ map, key: TABLE_CELL_KEY.text, body: cell.text });
  return map;
}

function writeElement(
  options: Readonly<{ elementsMap: Y.Map<unknown>; element: ElementSnapshot; groupId: ElementId | null; key: string; random: RandomSource }>,
): void {
  const { element } = options;
  const map = new Y.Map<unknown>();
  options.elementsMap.set(element.id, map);
  map.set(ELEMENT_KEY.id, element.id);
  map.set(ELEMENT_KEY.kind, element.kind);
  map.set(ELEMENT_KEY.name, element.name);
  map.set(ELEMENT_KEY.description, element.description);
  map.set(ELEMENT_KEY.groupId, options.groupId);
  map.set(ELEMENT_KEY.position, options.key);
  map.set(ELEMENT_KEY.morphKey, element.morphKey);
  map.set(ELEMENT_KEY.placeholder, element.placeholder);
  switch (element.kind) {
    case "shape":
      map.set(ELEMENT_KEY.frame, element.frame);
      writeBoxStyle(map, element.box);
      map.set(ELEMENT_KEY.preset, element.preset);
      map.set(ELEMENT_KEY.textBox, element.textBox);
      setTextBody({ map, key: ELEMENT_KEY.text, body: element.text });
      return;
    case "image":
      map.set(ELEMENT_KEY.frame, element.frame);
      writeBoxStyle(map, element.box);
      map.set(ELEMENT_KEY.assetId, element.assetId);
      map.set(ELEMENT_KEY.crop, element.crop);
      return;
    case "line":
      map.set(ELEMENT_KEY.lineGeometry, { start: element.start, end: element.end });
      map.set(ELEMENT_KEY.routing, element.routing);
      map.set(ELEMENT_KEY.stroke, element.stroke);
      map.set(ELEMENT_KEY.startArrow, element.startArrow);
      map.set(ELEMENT_KEY.endArrow, element.endArrow);
      map.set(ELEMENT_KEY.opacity, element.opacity);
      return;
    case "table":
      writeTable(map, element);
      return;
    case "group": {
      map.set(ELEMENT_KEY.rotation, element.frame.rotation);
      const keys = mintOrderKeys({ lower: null, upper: null, count: element.children.length, random: options.random }) ?? [];
      writeElementTrees({ elementsMap: options.elementsMap, elements: element.children, groupId: element.id, keys, random: options.random });
      return;
    }
    case "unsupported":
      // Validation rejects inserting these; nothing beyond the common keys could be written.
      return;
    default:
      assertNever(element);
  }
}

function writeBoxStyle(map: Y.Map<unknown>, box: Extract<ElementSnapshot, { kind: "shape" }>["box"]): void {
  map.set(ELEMENT_KEY.fill, box.fill);
  map.set(ELEMENT_KEY.border, box.border);
  map.set(ELEMENT_KEY.cornerRadius, box.cornerRadius);
  map.set(ELEMENT_KEY.shadow, box.shadow);
  map.set(ELEMENT_KEY.opacity, box.opacity);
}

function writeTable(map: Y.Map<unknown>, table: TableElement): void {
  map.set(ELEMENT_KEY.frame, table.frame);
  map.set(ELEMENT_KEY.opacity, table.opacity);
  const rows = new Y.Array<unknown>();
  map.set(ELEMENT_KEY.rows, rows);
  rows.push(table.rows.map((row) => row.id));
  const columns = new Y.Array<unknown>();
  map.set(ELEMENT_KEY.columns, columns);
  columns.push(table.columns.map((column) => column.id));
  const heights = new Y.Map<unknown>();
  map.set(ELEMENT_KEY.rowHeights, heights);
  for (const row of table.rows) heights.set(row.id, row.minimumHeight);
  const widths = new Y.Map<unknown>();
  map.set(ELEMENT_KEY.columnWidths, widths);
  for (const column of table.columns) widths.set(column.id, column.width);
  const cells = new Y.Map<unknown>();
  map.set(ELEMENT_KEY.cells, cells);
  const given = new Map(table.cells.map((cell) => [tableCellKey({ rowId: cell.rowId, columnId: cell.columnId }), cell] as const));
  for (const row of table.rows) {
    for (const column of table.columns) {
      const cell = given.get(tableCellKey({ rowId: row.id, columnId: column.id })) ?? defaultTableCell({ rowId: row.id, columnId: column.id });
      createCellMap({ cells, cell });
    }
  }
}
