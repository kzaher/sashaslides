// THE ELEMENT TREE OF ONE SLIDE (or layout): the shared document stores every element in one flat
// map with a `groupId` pointer (yjs-schema.ts); the snapshot shows a tree (document.ts). This file
// turns the first into the second, and it is the one place that decides what the tree IS -- the
// command writer and validation read the same `SlideStructure`, so "front", "the group's place" and
// "a dangling child" mean the same thing to everyone.
//
// Key decisions:
//
//  * CYCLE-SAFE. Two concurrent "group" writes can make A a child of B and B a child of A. The
//    parent graph is walked with a visited set, and in each cycle the member with the LARGER id is
//    shown at the top level, so every replica breaks it the same way and nothing recurses forever.
//  * DISPLACED ELEMENTS SHOW IN FRONT. A child whose group is missing (dangling), is not a group,
//    or loses a cycle is shown at the top level after (in front of) the regular top-level
//    elements, in its own key order. The repairing replica re-keys it to exactly that place
//    (validation.ts), so a repair never makes anything jump.
//  * EMPTY GROUPS ARE NOT SHOWN; a group's box is derived from its leaves in its own rotated axes,
//    and a line's frame from its end points (geometry.ts), never stored.
//  * STRUCTURAL SHARING. A node is rebuilt only when its own map changed in this transaction, its
//    effective parent changed, or (for a group) one of its children's nodes changed; otherwise the
//    previous snapshot's object is returned, which React memoisation relies on (document.ts).

import * as Y from "yjs";
import type { CellBorders, ElementCommon, ElementSnapshot, ImageCrop, TableCell, TableColumn, TableElement, TableRow } from "../contracts/document.ts";
import type { Frame } from "../contracts/geometry.ts";
import type { AssetId, ElementId, TableColumnId, TableRowId } from "../contracts/ids.ts";
import type { BoxStyle, Fill } from "../contracts/style.ts";
import type { StoredElementKind } from "../contracts/yjs-schema.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { EMPTY_TEXT_BODY } from "../contracts/document.ts";
import { identityFrame, lineFrame } from "../contracts/geometry.ts";
import { DEFAULT_TEXT_BOX_STYLE } from "../contracts/style.ts";
import { ELEMENT_KEY, TABLE_CELL_KEY, tableCellKey } from "../contracts/yjs-schema.ts";
import { DEFAULT_STROKE } from "../shared/element-defaults.ts";
import { derivedGroupFrame } from "../shared/element-tree.ts";
import { childArray, childMap, childText } from "./document-paths.ts";
import { compareOrderedSiblings } from "./order-keys.ts";
import {
  ARROW_HEAD,
  BORDER,
  CELL_BORDERS,
  CORNER_RADIUS,
  CUSTOM_OUTLINE,
  FILL,
  FRAME,
  IMAGE_CROP,
  LINE_GEOMETRY,
  LINE_ROUTING,
  NUMBER,
  OPACITY,
  PLACEHOLDER,
  POSITIVE_NUMBER,
  readStored,
  SHADOW,
  SHAPE_PRESET,
  SPAN,
  STROKE,
  TEXT,
  TEXT_BOX_STYLE,
  valueOr,
  type LineGeometry,
  type StoredValueCheck,
} from "./stored-values.ts";
import { projectTextBody } from "./text-body.ts";

/** One stored element map, as the structure needs it. */
export type ElementRecord = Readonly<{
  id: ElementId;
  map: Y.Map<unknown>;
  /** The stored `kind` when it is a string; null when it is missing or damaged. */
  storedKind: string | null;
  /** The stored `groupId` when it is a string. */
  storedGroupId: string | null;
  /** The stored order key; "" when it is missing or damaged (it then sorts first). */
  key: string;
}>;

/** How a slide's elements are arranged, as the snapshot shows them (see the header). */
export type SlideStructure = Readonly<{
  records: ReadonlyMap<ElementId, ElementRecord>;
  /** The effective parent of every element: its group, or null at the top level. */
  parentOf: ReadonlyMap<ElementId, ElementId | null>;
  /** Elements with a stored `groupId` that are shown at the top level instead. */
  displaced: ReadonlySet<ElementId>;
  /** The members that lost a group cycle (the larger id of each). */
  cycleBreaks: ReadonlySet<ElementId>;
  /** Children of a group (or of the top level, for null) in display order, back to front. */
  childrenOf: (parent: ElementId | null) => readonly ElementRecord[];
}>;

export const STORED_ELEMENT_KINDS: readonly StoredElementKind[] = ["shape", "image", "line", "table", "group"];

/** What a table falls back to for a row or column without a stored size. */
export const DEFAULT_ROW_HEIGHT = 40;
export const DEFAULT_COLUMN_WIDTH = 120;

export const NO_CELL_BORDERS: CellBorders = { top: null, right: null, bottom: null, left: null };

export function readSlideStructure(elementsMap: Y.Map<unknown>): SlideStructure {
  const records = new Map<ElementId, ElementRecord>();
  elementsMap.forEach((value, key) => {
    if (!(value instanceof Y.Map)) return;
    // Keys of an elements map are element ids by construction (document-writer.ts); the element
    // type parameter of a Y.Map is erased at runtime.
    records.set(key as ElementId, readRecord({ id: key as ElementId, map: value as Y.Map<unknown> }));
  });

  const parentOf = new Map<ElementId, ElementId | null>();
  const displaced = new Set<ElementId>();
  for (const record of records.values()) {
    const groupId = record.storedGroupId;
    if (groupId === null) {
      parentOf.set(record.id, null);
      continue;
    }
    // A stored groupId is only an element id if it names an element of this slide, checked here.
    const group = records.get(groupId as ElementId);
    if (group !== undefined && group.storedKind === "group" && group.id !== record.id) {
      parentOf.set(record.id, group.id);
      continue;
    }
    parentOf.set(record.id, null);
    displaced.add(record.id);
  }
  const cycleBreaks = breakCycles(parentOf);
  for (const id of cycleBreaks) displaced.add(id);

  const children = new Map<ElementId | null, ElementRecord[]>();
  const displacedRecords: ElementRecord[] = [];
  for (const record of records.values()) {
    if (displaced.has(record.id)) {
      displacedRecords.push(record);
      continue;
    }
    const parent = parentOf.get(record.id) ?? null;
    const list = children.get(parent) ?? [];
    list.push(record);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(compareRecords);
  displacedRecords.sort(compareRecords);
  const topLevel = [...(children.get(null) ?? []), ...displacedRecords];
  children.set(null, topLevel);

  return {
    records,
    parentOf,
    displaced,
    cycleBreaks,
    childrenOf: (parent) => children.get(parent) ?? [],
  };
}

/** Every element of a tree by id (groups and their descendants included). */
export function flattenElements(elements: readonly ElementSnapshot[]): ReadonlyMap<ElementId, ElementSnapshot> {
  const byId = new Map<ElementId, ElementSnapshot>();
  const visit = (list: readonly ElementSnapshot[]): void => {
    for (const element of list) {
      byId.set(element.id, element);
      if (element.kind === "group") visit(element.children);
    }
  };
  visit(elements);
  return byId;
}

/**
 * The snapshot tree of a structure. `previous` is the last snapshot's nodes by id; `touched` the
 * ids whose maps changed in this transaction ("all" rebuilds every node).
 */
export function projectElementTree(
  options: Readonly<{ structure: SlideStructure; previous: ReadonlyMap<ElementId, ElementSnapshot>; touched: ReadonlySet<string> | "all" }>,
): readonly ElementSnapshot[] {
  const { structure, previous, touched } = options;
  const visited = new Set<ElementId>();
  const build = (record: ElementRecord): ElementSnapshot | null => {
    // The structure already broke every cycle; the visited set is the second line of defence.
    if (visited.has(record.id)) return null;
    visited.add(record.id);
    const groupId = structure.parentOf.get(record.id) ?? null;
    const old = previous.get(record.id);
    const untouched = touched !== "all" && !touched.has(record.id) && old !== undefined && old.groupId === groupId;
    if (record.storedKind !== "group") {
      if (untouched && old.kind !== "group") return old;
      return projectLeaf({ record, groupId });
    }
    const children = structure.childrenOf(record.id).map(build).filter(isElement);
    if (children.length === 0) return null;
    if (untouched && old.kind === "group" && sameNodes(old.children, children)) return old;
    return projectGroup({ record, groupId, children });
  };
  return structure.childrenOf(null).map(build).filter(isElement);
}

/** The empty cell shown where a row and a column inserted concurrently meet (yjs-schema.ts). */
export function defaultTableCell(options: Readonly<{ rowId: TableRowId; columnId: TableColumnId }>): TableCell {
  return {
    rowId: options.rowId,
    columnId: options.columnId,
    rowSpan: 1,
    columnSpan: 1,
    fill: { kind: "none" },
    borders: NO_CELL_BORDERS,
    textBox: DEFAULT_TEXT_BOX_STYLE,
    text: EMPTY_TEXT_BODY,
  };
}

/** The ids of a table's row or column array, first occurrence kept. */
export function tableLineIds(array: Y.Array<unknown> | null): readonly string[] {
  if (array === null) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of array.toArray()) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

const DEFAULT_FRAME: Frame = identityFrame({ x: 0, y: 0, width: 100, height: 100 });
const PLAIN_FILL: Fill = { kind: "none" };

function readRecord(options: Readonly<{ id: ElementId; map: Y.Map<unknown> }>): ElementRecord {
  const kind = options.map.get(ELEMENT_KEY.kind);
  const groupId = options.map.get(ELEMENT_KEY.groupId);
  const key = options.map.get(ELEMENT_KEY.position);
  return {
    id: options.id,
    map: options.map,
    storedKind: typeof kind === "string" ? kind : null,
    storedGroupId: typeof groupId === "string" ? groupId : null,
    key: typeof key === "string" ? key : "",
  };
}

function compareRecords(first: ElementRecord, second: ElementRecord): number {
  return compareOrderedSiblings(first, second);
}

/** Break every cycle of the parent graph at its largest id; returns the ids that were cut loose. */
function breakCycles(parentOf: Map<ElementId, ElementId | null>): ReadonlySet<ElementId> {
  const state = new Map<ElementId, "visiting" | "done">();
  const breaks = new Set<ElementId>();
  for (const start of parentOf.keys()) {
    const path: ElementId[] = [];
    let current: ElementId | null = start;
    while (current !== null && state.get(current) === undefined) {
      state.set(current, "visiting");
      path.push(current);
      current = parentOf.get(current) ?? null;
    }
    if (current !== null && state.get(current) === "visiting") {
      const cycle = path.slice(path.indexOf(current));
      const largest = cycle.reduce((best, id) => (id > best ? id : best));
      parentOf.set(largest, null);
      breaks.add(largest);
    }
    for (const id of path) state.set(id, "done");
  }
  return breaks;
}

function isElement(candidate: ElementSnapshot | null): candidate is ElementSnapshot {
  return candidate !== null;
}

function sameNodes(first: readonly ElementSnapshot[], second: readonly ElementSnapshot[]): boolean {
  return first.length === second.length && first.every((node, index) => node === second[index]);
}

/** Reads keys of one element map, collecting the keys whose values this client does not understand. */
type KeyReader = Readonly<{
  read: <TValue>(key: string, kind: StoredValueCheck<TValue>, fallback: TValue) => TValue;
  unsupportedKeys: () => readonly string[];
}>;

function keyReader(map: Y.Map<unknown>): KeyReader {
  const unsupported: string[] = [];
  return {
    read: (key, kind, fallback) => {
      const parsed = readStored({ map, key, kind });
      if (parsed.kind === "unsupported" && !unsupported.includes(key)) unsupported.push(key);
      return valueOr(parsed, fallback);
    },
    unsupportedKeys: () => unsupported,
  };
}

function projectLeaf(options: Readonly<{ record: ElementRecord; groupId: ElementId | null }>): ElementSnapshot {
  const { record, groupId } = options;
  const reader = keyReader(record.map);
  const kind = storedElementKind(record.storedKind);
  switch (kind) {
    case "shape": {
      const preset = reader.read(ELEMENT_KEY.preset, SHAPE_PRESET, "rectangle");
      // Optional key (yjs-schema.ts): absent on preset shapes and on decks older than freeforms.
      const customOutline = reader.read(ELEMENT_KEY.customOutline, CUSTOM_OUTLINE, null);
      const box = readBoxStyle(reader);
      const textBox = reader.read(ELEMENT_KEY.textBox, TEXT_BOX_STYLE, DEFAULT_TEXT_BOX_STYLE);
      const text = childText(record.map, ELEMENT_KEY.text);
      const frame = reader.read(ELEMENT_KEY.frame, FRAME, DEFAULT_FRAME);
      return { ...readCommon({ record, reader, groupId, frame }), kind: "shape", preset, customOutline, box, textBox, text: text === null ? EMPTY_TEXT_BODY : projectTextBody(text) };
    }
    case "image": {
      // An asset id is the content address the writer stored (commands validate it); the brand
      // records that, and a damaged value only makes the image render as missing.
      const assetId = reader.read(ELEMENT_KEY.assetId, TEXT, "") as AssetId;
      const crop = reader.read(ELEMENT_KEY.crop, IMAGE_CROP, NO_CROP);
      const box = readBoxStyle(reader);
      const frame = reader.read(ELEMENT_KEY.frame, FRAME, DEFAULT_FRAME);
      return { ...readCommon({ record, reader, groupId, frame }), kind: "image", assetId, crop, box };
    }
    case "line": {
      const geometry = reader.read(ELEMENT_KEY.lineGeometry, LINE_GEOMETRY, DEFAULT_LINE);
      const routing = reader.read(ELEMENT_KEY.routing, LINE_ROUTING, "straight");
      const stroke = reader.read(ELEMENT_KEY.stroke, STROKE, DEFAULT_STROKE);
      const startArrow = reader.read(ELEMENT_KEY.startArrow, ARROW_HEAD, "none");
      const endArrow = reader.read(ELEMENT_KEY.endArrow, ARROW_HEAD, "none");
      const opacity = reader.read(ELEMENT_KEY.opacity, OPACITY, 1);
      const frame = lineFrame({ start: geometry.start, end: geometry.end });
      return { ...readCommon({ record, reader, groupId, frame }), kind: "line", start: geometry.start, end: geometry.end, routing, stroke, startArrow, endArrow, opacity };
    }
    case "table":
      return projectTable({ record, reader, groupId });
    case "group":
      // A group only reaches here when it has no shown children; callers never show it.
      return projectGroup({ record, groupId, children: [] });
    case null: {
      const frame = unsupportedFrame(record.map);
      return { ...readCommon({ record, reader, groupId, frame }), kind: "unsupported", storedKind: record.storedKind ?? "" };
    }
    default:
      return assertNever(kind);
  }
}

const NO_CROP: ImageCrop = { left: 0, top: 0, right: 0, bottom: 0 };
const DEFAULT_LINE: LineGeometry = { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };

function storedElementKind(kind: string | null): StoredElementKind | null {
  return STORED_ELEMENT_KINDS.find((candidate) => candidate === kind) ?? null;
}

function readCommon(options: Readonly<{ record: ElementRecord; reader: KeyReader; groupId: ElementId | null; frame: Frame }>): ElementCommon {
  const { record, reader } = options;
  const name = reader.read(ELEMENT_KEY.name, TEXT, "");
  const description = reader.read(ELEMENT_KEY.description, TEXT, "");
  const morphKey = reader.read(ELEMENT_KEY.morphKey, TEXT, record.id);
  const placeholder = reader.read(ELEMENT_KEY.placeholder, PLACEHOLDER, null);
  return {
    id: record.id,
    name,
    description,
    frame: options.frame,
    groupId: options.groupId,
    morphKey,
    placeholder,
    unsupportedKeys: reader.unsupportedKeys(),
  };
}

function readBoxStyle(reader: KeyReader): BoxStyle {
  return {
    fill: reader.read(ELEMENT_KEY.fill, FILL, PLAIN_FILL),
    border: reader.read(ELEMENT_KEY.border, BORDER, { kind: "none" }),
    cornerRadius: reader.read(ELEMENT_KEY.cornerRadius, CORNER_RADIUS, { kind: "uniform", radius: 0 }),
    shadow: reader.read(ELEMENT_KEY.shadow, SHADOW, null),
    opacity: reader.read(ELEMENT_KEY.opacity, OPACITY, 1),
  };
}

function projectTable(options: Readonly<{ record: ElementRecord; reader: KeyReader; groupId: ElementId | null }>): TableElement {
  const { record, reader } = options;
  const frame = reader.read(ELEMENT_KEY.frame, FRAME, DEFAULT_FRAME);
  const opacity = reader.read(ELEMENT_KEY.opacity, OPACITY, 1);
  const heights = childMap(record.map, ELEMENT_KEY.rowHeights);
  const widths = childMap(record.map, ELEMENT_KEY.columnWidths);
  const cells = childMap(record.map, ELEMENT_KEY.cells);
  // Row and column arrays hold row and column ids by construction (document-writer.ts).
  const rows: TableRow[] = tableLineIds(childArray(record.map, ELEMENT_KEY.rows)).map((id) => ({
    id: id as TableRowId,
    minimumHeight: heights === null ? DEFAULT_ROW_HEIGHT : valueOr(readStored({ map: heights, key: id, kind: POSITIVE_NUMBER }), DEFAULT_ROW_HEIGHT),
  }));
  const columns: TableColumn[] = tableLineIds(childArray(record.map, ELEMENT_KEY.columns)).map((id) => ({
    id: id as TableColumnId,
    width: widths === null ? DEFAULT_COLUMN_WIDTH : valueOr(readStored({ map: widths, key: id, kind: POSITIVE_NUMBER }), DEFAULT_COLUMN_WIDTH),
  }));
  const tableCells: TableCell[] = [];
  for (const row of rows) {
    for (const column of columns) {
      const cell = cells === null ? null : childMap(cells, tableCellKey({ rowId: row.id, columnId: column.id }));
      tableCells.push(cell === null ? defaultTableCell({ rowId: row.id, columnId: column.id }) : projectCell({ cell, rowId: row.id, columnId: column.id }));
    }
  }
  return { ...readCommon({ record, reader, groupId: options.groupId, frame }), kind: "table", columns, rows, cells: tableCells, opacity };
}

function projectCell(options: Readonly<{ cell: Y.Map<unknown>; rowId: TableRowId; columnId: TableColumnId }>): TableCell {
  const { cell } = options;
  const text = childText(cell, TABLE_CELL_KEY.text);
  return {
    rowId: options.rowId,
    columnId: options.columnId,
    rowSpan: valueOr(readStored({ map: cell, key: TABLE_CELL_KEY.rowSpan, kind: SPAN }), 1),
    columnSpan: valueOr(readStored({ map: cell, key: TABLE_CELL_KEY.columnSpan, kind: SPAN }), 1),
    fill: valueOr(readStored({ map: cell, key: TABLE_CELL_KEY.fill, kind: FILL }), PLAIN_FILL),
    borders: valueOr(readStored({ map: cell, key: TABLE_CELL_KEY.borders, kind: CELL_BORDERS }), NO_CELL_BORDERS),
    textBox: valueOr(readStored({ map: cell, key: TABLE_CELL_KEY.textBox, kind: TEXT_BOX_STYLE }), DEFAULT_TEXT_BOX_STYLE),
    text: text === null ? EMPTY_TEXT_BODY : projectTextBody(text),
  };
}

function projectGroup(options: Readonly<{ record: ElementRecord; groupId: ElementId | null; children: readonly ElementSnapshot[] }>): ElementSnapshot {
  const reader = keyReader(options.record.map);
  const rotation = reader.read(ELEMENT_KEY.rotation, NUMBER, 0);
  const frame = derivedGroupFrame({ rotation, children: options.children });
  return { ...readCommon({ record: options.record, reader, groupId: options.groupId, frame }), kind: "group", children: options.children };
}

/** Where to draw an element of an unknown kind: its frame, else its end points' bounds, else a default box. */
function unsupportedFrame(map: Y.Map<unknown>): Frame {
  const frame = readStored({ map, key: ELEMENT_KEY.frame, kind: FRAME });
  if (frame.kind === "valid") return frame.value;
  const geometry = readStored({ map, key: ELEMENT_KEY.lineGeometry, kind: LINE_GEOMETRY });
  if (geometry.kind === "valid") return lineFrame(geometry.value);
  return DEFAULT_FRAME;
}
