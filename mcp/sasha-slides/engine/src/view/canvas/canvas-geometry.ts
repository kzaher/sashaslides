// THE CANVAS'S PURE GEOMETRY: the slide as a gesture previews it, what the pointer is over, and the
// boxes the selection overlay draws. Kept apart from the canvas component so each rule is a tested
// function of values, and the overlay draws exactly what the state module computed (contracts/
// geometry.ts rules), never a second opinion.
//
// Key decisions:
//
//  * THE PREVIEW REPLACES ONLY WHAT MOVES. `applyFramePreview` returns the same slide object when
//    there is nothing to preview and replaces only the touched elements otherwise, so the element
//    components of everything else bail out of rendering (render-context.ts).
//  * A GROUP'S BOX DURING A PREVIEW is re-derived from its previewed children in the group's own
//    rotated axes, the same rule the model uses for snapshots (document.ts "every element has a
//    frame"), so the handles follow the drag.
//  * HIT TESTING READS THE STABLE DATA ATTRIBUTES (contracts/render.ts) on the event target's
//    ancestors, and turns attribute strings back into typed ids by finding them in the snapshot --
//    never by casting a string to an id.

import { assertNever } from "../../contracts/assert-never.ts";
import type { FrameUpdate } from "../../contracts/commands.ts";
import type { CommentThread, DiscussionSnapshot } from "../../contracts/discussion.ts";
import type { ElementSnapshot, SlideSnapshot, TableElement } from "../../contracts/document.ts";
import type { ElementMeasurement, HitTarget } from "../../contracts/editor-state.ts";
import {
  boundsOfBoxes,
  boundsOfPoints,
  frameCentre,
  frameCorners,
  lineFrame,
  rotatePoint,
  rotatedBounds,
  type Box,
  type Frame,
  type Point,
  type ResizeHandle,
} from "../../contracts/geometry.ts";
import type { ElementId } from "../../contracts/ids.ts";
import { ELEMENT_ID_ATTRIBUTE, SLIDE_ID_ATTRIBUTE } from "../../contracts/render.ts";
import type { Selection, TextTarget } from "../../contracts/selection.ts";
import { TABLE_CELL_COLUMN_ATTRIBUTE, TABLE_ROW_ATTRIBUTE } from "../render/element-view.tsx";

export const HANDLE_ATTRIBUTE = "data-sasha-handle";
export const ROTATION_HANDLE_ATTRIBUTE = "data-sasha-rotation-handle";
export const LINE_END_ATTRIBUTE = "data-sasha-line-end";
export const HANDLE_ELEMENT_ATTRIBUTE = "data-sasha-handle-element-id";
export const TABLE_COLUMN_BOUNDARY_ATTRIBUTE = "data-sasha-table-column-boundary";
export const TABLE_ROW_BOUNDARY_ATTRIBUTE = "data-sasha-table-row-boundary";
export const COMMENT_PIN_ATTRIBUTE = "data-sasha-comment-pin";

export const RESIZE_HANDLES: readonly ResizeHandle[] = ["topLeft", "top", "topRight", "right", "bottomRight", "bottom", "bottomLeft", "left"];

/** The slide with every previewed frame applied (see the header). */
export function applyFramePreview(slide: SlideSnapshot, updates: readonly FrameUpdate[]): SlideSnapshot {
  if (updates.length === 0) return slide;
  const byId = new Map<ElementId, FrameUpdate>();
  for (const update of updates) byId.set(update.elementId, update);
  const elements = previewElements(slide.elements, byId);
  return elements === slide.elements ? slide : { ...slide, elements };
}

/** Reads one ancestor's attributes; the canvas wraps DOM elements in it, tests pass records. */
export type AttributeReader = (name: string) => string | null;

/** What the pointer is over, from the event target outwards (contracts/editor-state.ts `HitTarget`). */
export function hitTargetOf(options: Readonly<{ path: readonly AttributeReader[]; slide: SlideSnapshot | null; discussion: DiscussionSnapshot }>): HitTarget {
  const elementIds: ElementId[] = [];
  let onSlide = false;
  for (const read of options.path) {
    const handle = read(HANDLE_ATTRIBUTE);
    if (handle !== null) {
      const parsed = parseResizeHandle(handle);
      if (parsed !== null) return { kind: "resizeHandle", handle: parsed };
    }
    if (read(ROTATION_HANDLE_ATTRIBUTE) !== null) return { kind: "rotationHandle" };
    const special = specialTarget({ read, slide: options.slide, discussion: options.discussion });
    if (special !== null) return special;
    const elementId = read(ELEMENT_ID_ATTRIBUTE);
    if (elementId !== null && options.slide !== null) {
      const element = findElement(options.slide.elements, elementId);
      if (element !== null) elementIds.push(element.id);
    }
    if (read(SLIDE_ID_ATTRIBUTE) !== null) onSlide = true;
  }
  if (elementIds.length > 0) return { kind: "element", elementPath: [...elementIds].reverse() };
  return onSlide ? { kind: "slideBackground" } : { kind: "outside" };
}

/**
 * The table cell under a double click, from the rendered cell's column attribute, its row's row
 * attribute and the table's element id, resolved against the slide so every id is one the
 * document holds; null anywhere else.
 */
export function tableCellTargetOf(options: Readonly<{ path: readonly AttributeReader[]; slide: SlideSnapshot | null }>): Extract<TextTarget, { kind: "tableCell" }> | null {
  const slide = options.slide;
  if (slide === null) return null;
  let columnText: string | null = null;
  let rowText: string | null = null;
  for (const read of options.path) {
    columnText ??= read(TABLE_CELL_COLUMN_ATTRIBUTE);
    rowText ??= read(TABLE_ROW_ATTRIBUTE);
    const elementText = read(ELEMENT_ID_ATTRIBUTE);
    if (elementText === null) continue;
    const element = findElement(slide.elements, elementText);
    const table = element === null ? null : tableElementOf(element);
    if (table === null) return null;
    const row = table.rows.find((candidate) => candidate.id === rowText);
    const column = table.columns.find((candidate) => candidate.id === columnText);
    if (row === undefined || column === undefined) return null;
    return { kind: "tableCell", slideId: slide.id, elementId: table.id, cell: { rowId: row.id, columnId: column.id } };
  }
  return null;
}

/** An element anywhere in a tree, by id text. */
export function findElement(elements: readonly ElementSnapshot[], id: string): ElementSnapshot | null {
  for (const element of elements) {
    if (element.id === id) return element;
    const inside = childElements(element);
    if (inside.length === 0) continue;
    const found = findElement(inside, id);
    if (found !== null) return found;
  }
  return null;
}

/** What the selection overlay draws for a selection on this slide. */
export type SelectionOutline =
  /** One frame with handles (a shape, image, table or group), or a line with its two ends. */
  | Readonly<{ kind: "single"; element: ElementSnapshot; frame: Frame; showHandles: boolean }>
  /** Several elements: each outlined, plus their common bounds with handles. */
  | Readonly<{ kind: "multiple"; frames: readonly Frame[]; bounds: Box }>
  | Readonly<{ kind: "none" }>;

export function selectionOutline(options: Readonly<{ slide: SlideSnapshot | null; selection: Selection; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): SelectionOutline {
  const slide = options.slide;
  if (slide === null) return { kind: "none" };
  const selection = options.selection;
  switch (selection.kind) {
    case "none":
    case "slides":
      return { kind: "none" };
    case "elements": {
      if (selection.slideId !== slide.id) return { kind: "none" };
      const elements = selection.elementIds.map((id) => findElement(slide.elements, id)).filter((element): element is ElementSnapshot => element !== null);
      const only = elements[0];
      if (elements.length === 1 && only !== undefined) return { kind: "single", element: only, frame: visibleFrame({ element: only, measured: options.measured }), showHandles: true };
      if (elements.length === 0) return { kind: "none" };
      const frames = elements.map((element) => visibleFrame({ element, measured: options.measured }));
      const bounds = boundsOfBoxes(frames.map(rotatedBounds));
      return bounds === null ? { kind: "none" } : { kind: "multiple", frames, bounds };
    }
    case "text":
    case "tableCells": {
      const elementId = selection.kind === "text" ? textTargetElementId(selection.target) : selection.elementId;
      const slideId = selection.kind === "text" ? selection.target.slideId : selection.slideId;
      if (elementId === null || slideId !== slide.id) return { kind: "none" };
      const element = findElement(slide.elements, elementId);
      return element === null ? { kind: "none" } : { kind: "single", element, frame: visibleFrame({ element, measured: options.measured }), showHandles: false };
    }
    default:
      return assertNever(selection);
  }
}

/** An element's frame as it shows: a table's height is its measured rows when known. */
export function visibleFrame(options: Readonly<{ element: ElementSnapshot; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): Frame {
  const measurement = options.measured.get(options.element.id);
  if (measurement === undefined) return options.element.frame;
  switch (measurement.kind) {
    case "table": {
      const height = measurement.rowHeights.reduce((total, row) => total + row.height, 0);
      return height > options.element.frame.height ? { ...options.element.frame, height } : options.element.frame;
    }
    case "text":
      return options.element.frame;
    default:
      return assertNever(measurement);
  }
}

/** Where each handle sits on a box, as fractions of it (rotated with the box by the overlay). */
export function handleFraction(handle: ResizeHandle): Readonly<{ x: number; y: number }> {
  switch (handle) {
    case "topLeft":
      return { x: 0, y: 0 };
    case "top":
      return { x: 0.5, y: 0 };
    case "topRight":
      return { x: 1, y: 0 };
    case "right":
      return { x: 1, y: 0.5 };
    case "bottomRight":
      return { x: 1, y: 1 };
    case "bottom":
      return { x: 0.5, y: 1 };
    case "bottomLeft":
      return { x: 0, y: 1 };
    case "left":
      return { x: 0, y: 0.5 };
    default:
      return assertNever(handle);
  }
}

/** The table's column boundaries (right edges, slide units from its left) and row boundaries. */
export function tableBoundaries(options: Readonly<{ table: TableElement; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): Readonly<{
  columns: readonly Readonly<{ columnId: TableElement["columns"][number]["id"]; offset: number }>[];
  rows: readonly Readonly<{ rowId: TableElement["rows"][number]["id"]; offset: number }>[];
}> {
  let x = 0;
  const columns = options.table.columns.map((column) => {
    x += column.width;
    return { columnId: column.id, offset: x };
  });
  const measurement = options.measured.get(options.table.id);
  const heights = new Map<string, number>();
  if (measurement !== undefined) {
    switch (measurement.kind) {
      case "table":
        for (const row of measurement.rowHeights) heights.set(row.rowId, row.height);
        break;
      case "text":
        break;
      default:
        assertNever(measurement);
    }
  }
  let y = 0;
  const rows = options.table.rows.map((row) => {
    y += heights.get(row.id) ?? row.minimumHeight;
    return { rowId: row.id, offset: y };
  });
  return { columns, rows };
}

function previewElements(elements: readonly ElementSnapshot[], updates: ReadonlyMap<ElementId, FrameUpdate>): readonly ElementSnapshot[] {
  let changed = false;
  const next = elements.map((element) => {
    const previewed = previewElement(element, updates);
    if (previewed !== element) changed = true;
    return previewed;
  });
  return changed ? next : elements;
}

function previewElement(element: ElementSnapshot, updates: ReadonlyMap<ElementId, FrameUpdate>): ElementSnapshot {
  const update = updates.get(element.id) ?? null;
  switch (element.kind) {
    case "group": {
      const children = previewElements(element.children, updates);
      const rotation = groupRotationOf(update) ?? element.frame.rotation;
      if (children === element.children && rotation === element.frame.rotation) return element;
      return { ...element, children, frame: groupFrame({ children, rotation }) };
    }
    case "line": {
      const ends = lineEndsOf(update);
      return ends === null ? element : { ...element, start: ends.start, end: ends.end, frame: lineFrame(ends) };
    }
    case "shape":
    case "image":
    case "table": {
      const frame = boxFrameOf(update);
      return frame === null ? element : { ...element, frame };
    }
    case "unsupported":
      return element;
    default:
      return assertNever(element);
  }
}

function boxFrameOf(update: FrameUpdate | null): Frame | null {
  if (update === null) return null;
  switch (update.kind) {
    case "box":
      return update.frame;
    case "line":
    case "groupRotation":
      return null;
    default:
      return assertNever(update);
  }
}

function lineEndsOf(update: FrameUpdate | null): Readonly<{ start: Point; end: Point }> | null {
  if (update === null) return null;
  switch (update.kind) {
    case "line":
      return { start: update.start, end: update.end };
    case "box":
    case "groupRotation":
      return null;
    default:
      return assertNever(update);
  }
}

function groupRotationOf(update: FrameUpdate | null): number | null {
  if (update === null) return null;
  switch (update.kind) {
    case "groupRotation":
      return update.rotation;
    case "box":
    case "line":
      return null;
    default:
      return assertNever(update);
  }
}

/** A group's box: its children's corners measured in the group's rotated axes (see the header). */
export function groupFrame(options: Readonly<{ children: readonly ElementSnapshot[]; rotation: number }>): Frame {
  const corners = options.children.flatMap((child) => frameCorners(child.frame));
  const axisAligned = boundsOfPoints(corners) ?? { x: 0, y: 0, width: 0, height: 0 };
  const centre = frameCentre(axisAligned);
  const local = boundsOfPoints(corners.map((point) => rotatePoint({ point, centre, degrees: -options.rotation }))) ?? axisAligned;
  const localCentre = rotatePoint({ point: frameCentre(local), centre, degrees: options.rotation });
  return { x: localCentre.x - local.width / 2, y: localCentre.y - local.height / 2, width: local.width, height: local.height, rotation: options.rotation, flipHorizontal: false, flipVertical: false };
}

function childElements(element: ElementSnapshot): readonly ElementSnapshot[] {
  switch (element.kind) {
    case "group":
      return element.children;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function specialTarget(options: Readonly<{ read: AttributeReader; slide: SlideSnapshot | null; discussion: DiscussionSnapshot }>): HitTarget | null {
  const read = options.read;
  const pin = read(COMMENT_PIN_ATTRIBUTE);
  if (pin !== null) {
    const thread: CommentThread | undefined = options.discussion.threads.find((candidate) => candidate.id === pin);
    if (thread !== undefined) return { kind: "commentPin", threadId: thread.id };
  }
  const handleElement = read(HANDLE_ELEMENT_ATTRIBUTE);
  if (handleElement === null || options.slide === null) return null;
  const element = findElement(options.slide.elements, handleElement);
  if (element === null) return null;
  const lineEnd = read(LINE_END_ATTRIBUTE);
  if (lineEnd === "start" || lineEnd === "end") return { kind: "lineEnd", elementId: element.id, end: lineEnd };
  const table = tableOf(element);
  if (table === null) return null;
  const columnText = read(TABLE_COLUMN_BOUNDARY_ATTRIBUTE);
  const column = columnText === null ? undefined : table.columns.find((candidate) => candidate.id === columnText);
  if (column !== undefined) return { kind: "tableColumnBoundary", elementId: table.id, columnId: column.id };
  const rowText = read(TABLE_ROW_BOUNDARY_ATTRIBUTE);
  const row = rowText === null ? undefined : table.rows.find((candidate) => candidate.id === rowText);
  if (row !== undefined) return { kind: "tableRowBoundary", elementId: table.id, rowId: row.id };
  return null;
}

function tableOf(element: ElementSnapshot): TableElement | null {
  switch (element.kind) {
    case "table":
      return element;
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

function textTargetElementId(target: Extract<Selection, { kind: "text" }>["target"]): ElementId | null {
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

function parseResizeHandle(text: string): ResizeHandle | null {
  return RESIZE_HANDLES.find((handle) => handle === text) ?? null;
}

function tableElementOf(element: ElementSnapshot): TableElement | null {
  switch (element.kind) {
    case "table":
      return element;
    case "group":
    case "shape":
    case "image":
    case "line":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}
