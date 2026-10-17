// POINTER GESTURES ON THE CANVAS (SPEC.md section 7, the gesture table). The view reports WHERE (slide
// units, with the client position for thresholds) and ON WHAT (the hit target); whether that becomes
// a click, a move, a resize, a rotation, a marquee or a new element is decided here from the tool, the
// selection and the 3 client pixel drag threshold.
//
// Every drag previews in `gesture.preview` (frame updates, frame-updates.ts) and commits ONE
// `setFrames` envelope on release -- one gesture, one undo step, one shared update. Escape and pointer
// cancel drop the gesture and commit nothing.

import {
  assertNever,
  frameCentre,
  marqueeBox,
  resizeFrame,
  snapRotation,
  EMPTY_TEXT_BODY,
  type Box,
  type CommentComposer,
  type DocumentCommand,
  type EditorEvent,
  type EditorState,
  type ElementId,
  type ElementSnapshot,
  type FrameUpdate,
  type Gesture,
  type HitTarget,
  type InsertTool,
  type Marking,
  type Modifiers,
  type Point,
  type PointerSample,
  type Selection,
  type SlideSnapshot,
  type TableElement,
} from "../../contracts/index.ts";
import { editingRefusal } from "../../shared/access-refusals.ts";
import {
  DEFAULT_LINE_LENGTH,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_ROW_HEIGHT,
  DEFAULT_TEXT_BOX_SIZE,
  isTextBoxPreset,
} from "../../shared/element-defaults.ts";
import {
  boxesIntersect,
  elementBounds,
  findElement,
  findSlide,
  leavesOf,
  selectableElements,
  slideBox,
  textShapeOf,
} from "./document-lookup.ts";
import { queueCommands, queueEnvelope, refuse } from "./editor-queue.ts";
import { isElementSelected, selectedElements, selectElements, textSelectionOf } from "./editor-selection.ts";
import { createLine, createShape, createTable } from "./element-factory.ts";
import { createIdMinter } from "./id-minter.ts";
import {
  boundsOfUpdates,
  groupRotationUpdates,
  leafUpdates,
  rotateUpdates,
  sameUpdates,
  scaleUpdates,
  selectionFrame,
  translateUpdates,
} from "./frame-updates.ts";
import { snapMove } from "./snapping.ts";
import { applyCapturedFormat } from "./format-painter.ts";
import { openComposer, referenceBoxForComposer } from "./comments.ts";
import { startTextEditing } from "./text-editing.ts";

/** Pointer travel, in client pixels, that turns a press into a drag (SPEC.md section 7). */
export const DRAG_THRESHOLD_CLIENT_PIXELS = 3;
export const ROTATION_SNAP_DEGREES = 15;
/** The narrowest a table column or row can be dragged, slide units. */
export const MINIMUM_TABLE_LINE_SIZE = 8;
/** Marking colours are stored in the discussion log (data, not chrome): the Tidepool accent and a highlighter yellow. */
export const MARKING_COLOUR = "#4338ca";
export const HIGHLIGHT_COLOUR = "#fde68a";

type PointerDown = Extract<EditorEvent, { kind: "canvasPointerDown" }>;

export function reducePointerDown(state: EditorState, event: PointerDown): EditorState {
  if (!gestureIsIdle(state.gesture)) return state;
  const closed: EditorState = { ...state, chrome: { ...state.chrome, openMenu: null, contextMenu: null } };
  switch (event.button) {
    case "primary":
      break;
    case "secondary":
      return selectForContextMenu(closed, event.target);
    case "middle":
      return closed;
    default:
      return assertNever(event.button);
  }
  const point = event.sample.slidePoint;
  const tool = closed.tool;
  switch (tool.kind) {
    case "select":
      return pressWithSelect(closed, event);
    case "shape":
    case "line":
    case "table": {
      const refusal = editingRefusal(closed);
      if (refusal !== null) return refuse({ ...closed, tool: { kind: "select" } }, refusal);
      return { ...closed, gesture: { kind: "creating", tool, origin: point, current: point } };
    }
    case "comment":
    case "formatPainter":
      return { ...closed, gesture: { kind: "pressed", origin: event.sample, target: event.target, modifiers: event.modifiers } };
    case "annotate":
      return startMarking(closed, tool.marking, point);
    case "pan":
      return { ...closed, gesture: { kind: "panning", origin: event.sample, startScroll: closed.viewport.scroll } };
    default:
      return assertNever(tool);
  }
}

export function reducePointerMove(state: EditorState, sample: PointerSample, modifiers: Modifiers): EditorState {
  const gesture = state.gesture;
  switch (gesture.kind) {
    case "idle":
    case "draggingSlides":
      return state;
    case "pressed":
      if (clientDistance(gesture.origin, sample) <= DRAG_THRESHOLD_CLIENT_PIXELS) return state;
      return beginDrag(state, gesture, sample, modifiers);
    case "moving":
      return updateMove(state, gesture, sample, modifiers);
    case "resizing":
      return updateResize(state, gesture, sample, modifiers);
    case "rotating":
      return updateRotate(state, gesture, sample, modifiers);
    case "movingLineEnd":
      return { ...state, gesture: { ...gesture, point: lineEndPoint(state, gesture.elementId, gesture.end, sample.slidePoint, modifiers.shift) } };
    case "marquee":
      return { ...state, gesture: { ...gesture, current: sample.slidePoint } };
    case "creating":
      return { ...state, gesture: { ...gesture, current: modifiers.shift ? squareCorner(gesture.origin, sample.slidePoint) : sample.slidePoint } };
    case "resizingTableLine":
      return { ...state, gesture: { ...gesture, current: sample.slidePoint } };
    case "drawingMarking":
      return { ...state, gesture: { ...gesture, marking: extendMarking(gesture.marking, toFraction(referenceBoxForComposer(state), sample.slidePoint)) } };
    case "panning":
      return {
        ...state,
        viewport: {
          ...state.viewport,
          scroll: {
            x: gesture.startScroll.x - (sample.clientPoint.x - gesture.origin.clientPoint.x),
            y: gesture.startScroll.y - (sample.clientPoint.y - gesture.origin.clientPoint.y),
          },
        },
      };
    default:
      return assertNever(gesture);
  }
}

export function reducePointerUp(state: EditorState, sample: PointerSample, modifiers: Modifiers): EditorState {
  const moved = reducePointerMove(state, sample, modifiers);
  const gesture = moved.gesture;
  const idle: EditorState = { ...moved, gesture: { kind: "idle" } };
  switch (gesture.kind) {
    case "idle":
    case "draggingSlides":
      return moved;
    case "pressed":
      return click(idle, gesture.target, gesture.modifiers);
    case "moving":
    case "resizing":
    case "rotating":
      return commitFrames(idle, gesture.startFrames, gesture.preview);
    case "movingLineEnd":
      return commitLineEnd(idle, gesture.elementId, gesture.end, gesture.point);
    case "marquee":
      return commitMarquee(idle, marqueeBox(gesture), gesture.additive);
    case "creating":
      return commitCreate(idle, gesture.tool, gesture.origin, gesture.current);
    case "resizingTableLine":
      return commitTableLine(idle, gesture);
    case "drawingMarking":
      return commitMarking(idle, gesture.marking);
    case "panning":
      return idle;
    default:
      return assertNever(gesture);
  }
}

/** Escape or pointer cancel: the gesture is dropped and nothing is committed. */
export function cancelGesture(state: EditorState): EditorState {
  return gestureIsIdle(state.gesture) ? state : { ...state, gesture: { kind: "idle" } };
}

export function gestureIsIdle(gesture: Gesture): boolean {
  switch (gesture.kind) {
    case "idle":
      return true;
    case "pressed":
    case "moving":
    case "resizing":
    case "rotating":
    case "movingLineEnd":
    case "marquee":
    case "creating":
    case "resizingTableLine":
    case "draggingSlides":
    case "drawingMarking":
    case "panning":
      return false;
    default:
      return assertNever(gesture);
  }
}

/** The element a click on `elementPath` selects: the group unless that group was entered. */
export function selectableIdOf(elementPath: readonly ElementId[], enteredGroupId: ElementId | null): ElementId | null {
  const enteredIndex = enteredGroupId === null ? -1 : elementPath.indexOf(enteredGroupId);
  return elementPath[enteredIndex + 1] ?? elementPath.at(-1) ?? null;
}

function pressWithSelect(state: EditorState, event: PointerDown): EditorState {
  const pressed: EditorState = { ...state, gesture: { kind: "pressed", origin: event.sample, target: event.target, modifiers: event.modifiers } };
  const target = event.target;
  switch (target.kind) {
    case "element": {
      const slideId = state.currentSlideId;
      const enteredGroupId = state.enteredGroupId !== null && target.elementPath.includes(state.enteredGroupId) ? state.enteredGroupId : null;
      const selectableId = selectableIdOf(target.elementPath, enteredGroupId);
      if (slideId === null || selectableId === null) return state;
      if (event.clickCount >= 2) return doubleClick({ ...state, enteredGroupId }, target.elementPath, selectableId);
      if (editingTextOf(state, selectableId)) return state;
      if (isElementSelected(state.selection, selectableId) || event.modifiers.shift) return { ...pressed, enteredGroupId };
      return selectElements({ ...pressed, enteredGroupId }, [selectableId]);
    }
    case "outside":
    case "slideBackground":
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
    case "commentPin":
      return pressed;
    default:
      return assertNever(target);
  }
}

/** Double click: enter the group, or start editing the text of a text-bearing element. */
function doubleClick(state: EditorState, elementPath: readonly ElementId[], selectableId: ElementId): EditorState {
  const slide = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
  const element = slide === null ? null : findElement(slide, selectableId);
  if (slide === null || element === null) return state;
  switch (element.kind) {
    case "group": {
      const childId = elementPath[elementPath.indexOf(selectableId) + 1];
      const entered: EditorState = { ...state, enteredGroupId: element.id };
      return childId === undefined ? entered : selectElements(entered, [childId]);
    }
    case "shape":
      return startTextEditing(state, { kind: "element", slideId: slide.id, elementId: element.id }, "end");
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return selectElements(state, [selectableId]);
    default:
      return assertNever(element);
  }
}

function selectForContextMenu(state: EditorState, target: HitTarget): EditorState {
  switch (target.kind) {
    case "element": {
      const selectableId = selectableIdOf(target.elementPath, state.enteredGroupId);
      if (selectableId === null || isElementSelected(state.selection, selectableId) || editingTextOf(state, selectableId)) return state;
      return selectElements(state, [selectableId]);
    }
    case "outside":
    case "slideBackground":
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
    case "commentPin":
      return state;
    default:
      return assertNever(target);
  }
}

function editingTextOf(state: EditorState, elementId: ElementId): boolean {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return false;
  switch (selection.target.kind) {
    case "element":
    case "tableCell":
      return selection.target.elementId === elementId;
    case "speakerNotes":
      return false;
    default:
      return assertNever(selection.target);
  }
}

function beginDrag(state: EditorState, pressed: Extract<Gesture, { kind: "pressed" }>, sample: PointerSample, modifiers: Modifiers): EditorState {
  const target = pressed.target;
  // A drag that would change the document is refused up front for a viewer or commenter (access-refusals.ts),
  // so nothing previews a move that could never be saved.
  const refusal = dragEditsDocument({ target, tool: state.tool }) ? editingRefusal(state) : null;
  if (refusal !== null) return refuse({ ...state, gesture: { kind: "idle" } }, refusal);
  switch (target.kind) {
    case "element":
      return beginElementDrag(state, pressed, target.elementPath, sample, modifiers);
    case "resizeHandle": {
      const selected = selectedElements(state);
      if (selected === null) return { ...state, gesture: { kind: "idle" } };
      const startFrames = [...leafUpdates(selected.elements), ...groupRotationUpdates(selected.elements)];
      const resizing: Gesture = { kind: "resizing", handle: target.handle, origin: pressed.origin, current: sample, startFrames, preview: startFrames, guides: [] };
      return reducePointerMove({ ...state, gesture: resizing }, sample, modifiers);
    }
    case "rotationHandle": {
      const selected = selectedElements(state);
      const frame = selected === null ? null : selectionFrame(selected.elements, state.measuredLayouts);
      if (selected === null || frame === null) return { ...state, gesture: { kind: "idle" } };
      const startFrames = [...leafUpdates(selected.elements), ...groupRotationUpdates(selected.elements)];
      const rotating: Gesture = { kind: "rotating", centre: frameCentre(frame), origin: pressed.origin, current: sample, startFrames, preview: startFrames };
      return reducePointerMove({ ...state, gesture: rotating }, sample, modifiers);
    }
    case "lineEnd":
      return { ...state, gesture: { kind: "movingLineEnd", elementId: target.elementId, end: target.end, point: lineEndPoint(state, target.elementId, target.end, sample.slidePoint, modifiers.shift), guides: [] } };
    case "tableColumnBoundary":
      return { ...state, gesture: { kind: "resizingTableLine", elementId: target.elementId, line: { kind: "column", columnId: target.columnId }, origin: pressed.origin.slidePoint, current: sample.slidePoint } };
    case "tableRowBoundary":
      return { ...state, gesture: { kind: "resizingTableLine", elementId: target.elementId, line: { kind: "row", rowId: target.rowId }, origin: pressed.origin.slidePoint, current: sample.slidePoint } };
    case "outside":
    case "slideBackground":
      return { ...state, gesture: { kind: "marquee", origin: pressed.origin.slidePoint, current: sample.slidePoint, additive: pressed.modifiers.shift } };
    case "commentPin":
      return { ...state, gesture: { kind: "idle" } };
    default:
      return assertNever(target);
  }
}

/** Whether dragging from this target with this tool would move, resize or reshape something. */
function dragEditsDocument(options: Readonly<{ target: Extract<Gesture, { kind: "pressed" }>["target"]; tool: EditorState["tool"] }>): boolean {
  const target = options.target;
  switch (target.kind) {
    case "element":
      return toolIsSelect(options.tool);
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
      return true;
    case "outside":
    case "slideBackground":
    case "commentPin":
      return false;
    default:
      return assertNever(target);
  }
}

/** Whether the select tool is active: only it moves elements by dragging them. */
export function toolIsSelect(tool: EditorState["tool"]): boolean {
  switch (tool.kind) {
    case "select":
      return true;
    case "comment":
    case "formatPainter":
    case "shape":
    case "line":
    case "table":
    case "annotate":
    case "pan":
      return false;
    default:
      return assertNever(tool);
  }
}

function beginElementDrag(
  state: EditorState,
  pressed: Extract<Gesture, { kind: "pressed" }>,
  elementPath: readonly ElementId[],
  sample: PointerSample,
  modifiers: Modifiers,
): EditorState {
  switch (state.tool.kind) {
    case "select":
      break;
    case "comment":
      return { ...state, gesture: { kind: "marquee", origin: pressed.origin.slidePoint, current: sample.slidePoint, additive: false } };
    case "formatPainter":
    case "shape":
    case "line":
    case "table":
    case "annotate":
    case "pan":
      return { ...state, gesture: { kind: "idle" } };
    default:
      return assertNever(state.tool);
  }
  const selectableId = selectableIdOf(elementPath, state.enteredGroupId);
  if (selectableId === null) return { ...state, gesture: { kind: "idle" } };
  const withTarget = isElementSelected(state.selection, selectableId)
    ? state
    : selectElements(state, pressed.modifiers.shift ? [...selectedIdsOnSlide(state), selectableId] : [selectableId]);
  const selected = selectedElements(withTarget);
  if (selected === null) return { ...withTarget, gesture: { kind: "idle" } };
  const startFrames = leafUpdates(selected.elements);
  const moving: Gesture = { kind: "moving", origin: pressed.origin, current: sample, startFrames, preview: startFrames, guides: [] };
  return reducePointerMove({ ...withTarget, gesture: moving }, sample, modifiers);
}

function selectedIdsOnSlide(state: EditorState): readonly ElementId[] {
  const selection = state.selection;
  switch (selection.kind) {
    case "elements":
      return selection.slideId === state.currentSlideId ? selection.elementIds : [];
    case "none":
    case "slides":
    case "text":
    case "tableCells":
      return [];
    default:
      return assertNever(selection);
  }
}

function updateMove(state: EditorState, gesture: Extract<Gesture, { kind: "moving" }>, sample: PointerSample, modifiers: Modifiers): EditorState {
  const rawX = sample.slidePoint.x - gesture.origin.slidePoint.x;
  const rawY = sample.slidePoint.y - gesture.origin.slidePoint.y;
  const horizontalDominant = Math.abs(rawX) >= Math.abs(rawY);
  const axes = modifiers.shift ? { horizontal: horizontalDominant, vertical: !horizontalDominant } : { horizontal: true, vertical: true };
  const moving = boundsOfUpdates(gesture.startFrames, state.measuredLayouts);
  const slide = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
  if (moving === null || slide === null) return { ...state, gesture: { ...gesture, current: sample } };
  const snapped = snapMove({
    moving,
    deltaX: rawX,
    deltaY: rawY,
    targets: snapTargets(state, slide, gesture.startFrames),
    slide: slideBox(state.document),
    scale: state.viewport.scale,
    axes,
  });
  return {
    ...state,
    gesture: { ...gesture, current: sample, preview: translateUpdates(gesture.startFrames, snapped.deltaX, snapped.deltaY), guides: snapped.guides },
  };
}

/** Rotated bounds of the elements at the selection's depth that are not moving. */
function snapTargets(state: EditorState, slide: SlideSnapshot, moving: readonly FrameUpdate[]): readonly Box[] {
  const movingIds = new Set(moving.map((update) => update.elementId));
  return selectableElements(slide, state.enteredGroupId)
    .filter((element) => !leavesOf(element).some((leaf) => movingIds.has(leaf.id)))
    .map((element) => elementBounds(element, state.measuredLayouts));
}

function updateResize(state: EditorState, gesture: Extract<Gesture, { kind: "resizing" }>, sample: PointerSample, modifiers: Modifiers): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return { ...state, gesture: { ...gesture, current: sample } };
  const only = selected.elements.length === 1 ? selected.elements[0] : undefined;
  const resize = { handle: gesture.handle, pointer: sample.slidePoint, keepAspectRatio: modifiers.shift || state.chrome.aspectRatioLocked, fromCentre: modifiers.alt };
  if (only !== undefined && resizesOwnFrame(only)) {
    const preview: FrameUpdate[] = [{ kind: "box", elementId: only.id, frame: resizeFrame({ frame: only.frame, ...resize }) }];
    return { ...state, gesture: { ...gesture, current: sample, preview } };
  }
  const from = selectionFrame(selected.elements, state.measuredLayouts);
  if (from === null) return { ...state, gesture: { ...gesture, current: sample } };
  const to = resizeFrame({ frame: from, ...resize });
  return { ...state, gesture: { ...gesture, current: sample, preview: scaleUpdates(gesture.startFrames, from, to) } };
}

/** A lone shape, image or table resizes its own frame; lines and groups scale their members. */
function resizesOwnFrame(element: ElementSnapshot): boolean {
  switch (element.kind) {
    case "shape":
    case "image":
    case "table":
      return true;
    case "line":
    case "group":
    case "unsupported":
      return false;
    default:
      return assertNever(element);
  }
}

function updateRotate(state: EditorState, gesture: Extract<Gesture, { kind: "rotating" }>, sample: PointerSample, modifiers: Modifiers): EditorState {
  const raw = angleAround(gesture.centre, sample.slidePoint) - angleAround(gesture.centre, gesture.origin.slidePoint);
  const degrees = modifiers.shift ? snappedRotationDelta(state, raw) : raw;
  return { ...state, gesture: { ...gesture, current: sample, preview: rotateUpdates(gesture.startFrames, gesture.centre, degrees) } };
}

/** Shift while rotating: a lone element's resulting rotation lands on 15 degrees; several turn by 15s. */
function snappedRotationDelta(state: EditorState, raw: number): number {
  const selected = selectedElements(state);
  const only = selected !== null && selected.elements.length === 1 ? selected.elements[0] : undefined;
  if (only === undefined) return snapRotation({ degrees: raw, step: ROTATION_SNAP_DEGREES });
  const base = only.frame.rotation;
  return snapRotation({ degrees: base + raw, step: ROTATION_SNAP_DEGREES }) - base;
}

function angleAround(centre: Point, point: Point): number {
  return (Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI;
}

function lineEndPoint(state: EditorState, elementId: ElementId, end: "start" | "end", pointer: Point, snapAngle: boolean): Point {
  if (!snapAngle) return pointer;
  const slide = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
  const element = slide === null ? null : findElement(slide, elementId);
  if (element === null) return pointer;
  switch (element.kind) {
    case "line": {
      const fixed = LINE_END_IS_START[end] ? element.end : element.start;
      const length = Math.hypot(pointer.x - fixed.x, pointer.y - fixed.y);
      const angle = snapRotation({ degrees: angleAround(fixed, pointer), step: ROTATION_SNAP_DEGREES });
      const radians = (angle * Math.PI) / 180;
      return { x: fixed.x + length * Math.cos(radians), y: fixed.y + length * Math.sin(radians) };
    }
    case "shape":
    case "image":
    case "table":
    case "group":
    case "unsupported":
      return pointer;
    default:
      return assertNever(element);
  }
}

const LINE_END_IS_START: Readonly<Record<"start" | "end", boolean>> = { start: true, end: false };

function click(state: EditorState, target: HitTarget, modifiers: Modifiers): EditorState {
  const tool = state.tool;
  switch (tool.kind) {
    case "select":
      return clickWithSelect(state, target, modifiers);
    case "comment":
      return clickWithComment(state, target);
    case "formatPainter": {
      const path = elementPathOf(target);
      const elementId = path === null ? null : selectableIdOf(path, state.enteredGroupId);
      if (elementId === null) return state;
      const painted = applyCapturedFormat(state, elementId, tool.captured);
      return tool.sticky ? painted : { ...painted, tool: { kind: "select" } };
    }
    case "shape":
    case "line":
    case "table":
    case "annotate":
    case "pan":
      return state;
    default:
      return assertNever(tool);
  }
}

function elementPathOf(target: HitTarget): readonly ElementId[] | null {
  switch (target.kind) {
    case "element":
      return target.elementPath;
    case "outside":
    case "slideBackground":
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
    case "commentPin":
      return null;
    default:
      return assertNever(target);
  }
}

function clickWithSelect(state: EditorState, target: HitTarget, modifiers: Modifiers): EditorState {
  switch (target.kind) {
    case "element": {
      const selectableId = selectableIdOf(target.elementPath, state.enteredGroupId);
      if (selectableId === null || editingTextOf(state, selectableId)) return state;
      if (!modifiers.shift) return selectElements(state, [selectableId]);
      const current = selectedIdsOnSlide(state);
      const toggled = current.includes(selectableId) ? current.filter((elementId) => elementId !== selectableId) : [...current, selectableId];
      return selectElements(state, toggled);
    }
    case "outside":
    case "slideBackground":
      if (modifiers.shift) return state;
      return { ...selectElements(state, []), enteredGroupId: null };
    case "commentPin":
      return { ...state, chrome: { ...state.chrome, focusedThreadId: target.threadId, commentsOpen: true } };
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
      return state;
    default:
      return assertNever(target);
  }
}

function clickWithComment(state: EditorState, target: HitTarget): EditorState {
  const slideId = state.currentSlideId;
  if (slideId === null) return state;
  switch (target.kind) {
    case "element": {
      const elementId = target.elementPath[0] ?? null;
      return openComposer(state, { slideId, elementId, textRange: null, region: null });
    }
    case "outside":
    case "slideBackground":
      return openComposer(state, { slideId, elementId: null, textRange: null, region: null });
    case "commentPin":
      return { ...state, chrome: { ...state.chrome, focusedThreadId: target.threadId, commentsOpen: true } };
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
      return state;
    default:
      return assertNever(target);
  }
}

function commitFrames(state: EditorState, startFrames: readonly FrameUpdate[], preview: readonly FrameUpdate[]): EditorState {
  const slideId = state.currentSlideId;
  if (slideId === null || sameUpdates(startFrames, preview)) return state;
  return queueCommands(state, [{ kind: "setFrames", slideId, frames: preview }]);
}

function commitLineEnd(state: EditorState, elementId: ElementId, end: "start" | "end", point: Point): EditorState {
  const slideId = state.currentSlideId;
  const slide = slideId === null ? null : findSlide(state.document, slideId);
  const element = slide === null ? null : findElement(slide, elementId);
  if (slideId === null || element === null) return state;
  switch (element.kind) {
    case "line": {
      const start = LINE_END_IS_START[end] ? point : element.start;
      const finish = LINE_END_IS_START[end] ? element.end : point;
      if (start.x === element.start.x && start.y === element.start.y && finish.x === element.end.x && finish.y === element.end.y) return state;
      return queueCommands(state, [{ kind: "setFrames", slideId, frames: [{ kind: "line", elementId, start, end: finish }] }]);
    }
    case "shape":
    case "image":
    case "table":
    case "group":
    case "unsupported":
      return state;
    default:
      return assertNever(element);
  }
}

function commitMarquee(state: EditorState, box: Box, additive: boolean): EditorState {
  const slideId = state.currentSlideId;
  const slide = slideId === null ? null : findSlide(state.document, slideId);
  if (slideId === null || slide === null) return state;
  switch (state.tool.kind) {
    case "comment":
      return openComposer(state, { slideId, elementId: null, textRange: null, region: fractionOf(slideBox(state.document), box) });
    case "select":
    case "shape":
    case "line":
    case "table":
    case "annotate":
    case "pan":
    case "formatPainter":
      break;
    default:
      return assertNever(state.tool);
  }
  const hits = selectableElements(slide, state.enteredGroupId)
    .filter((element) => boxesIntersect(elementBounds(element, state.measuredLayouts), box))
    .map((element) => element.id);
  const previous = additive ? selectedIdsOnSlide(state) : [];
  return selectElements(state, [...previous, ...hits.filter((elementId) => !previous.includes(elementId))]);
}

function commitCreate(state: EditorState, tool: InsertTool, origin: Point, current: Point): EditorState {
  const slideId = state.currentSlideId;
  if (slideId === null) return state;
  const clicked = Math.hypot(current.x - origin.x, current.y - origin.y) * Math.max(state.viewport.scale, 0) <= DRAG_THRESHOLD_CLIENT_PIXELS;
  const minter = createIdMinter(state.idSeed);
  const id = minter.next("element");
  const dragged = marqueeBox({ origin, current });
  const element = createdElement({ tool, id, minter, origin, current, dragged, clicked });
  const minted: EditorState = { ...state, idSeed: minter.seed(), tool: { kind: "select" } };
  const shape = textShapeOf(element);
  const textBox = shape !== null && isTextBoxPreset(shape.preset);
  const selectionAfter: Selection = textBox
    ? { kind: "text", target: { kind: "element", slideId, elementId: id }, anchor: 0, focus: 0 }
    : { kind: "elements", slideId, elementIds: [id] };
  const commands: readonly DocumentCommand[] = [{ kind: "insertElements", slideId, elements: [element], placement: { kind: "front" } }];
  const queued = queueEnvelope(minted, { commands, selectionAfter, mergeWithPrevious: false });
  return { ...queued, enteredGroupId: null, textEditing: { ...queued.textEditing, typingStyle: {} } };
}

function createdElement(
  options: Readonly<{ tool: InsertTool; id: ElementId; minter: ReturnType<typeof createIdMinter>; origin: Point; current: Point; dragged: Box; clicked: boolean }>,
): ElementSnapshot {
  const tool = options.tool;
  switch (tool.kind) {
    case "shape": {
      const size = isTextBoxPreset(tool.preset) ? DEFAULT_TEXT_BOX_SIZE : DEFAULT_SHAPE_SIZE;
      const box = options.clicked ? { x: options.origin.x, y: options.origin.y, ...size } : atLeastOneUnit(options.dragged);
      return createShape({ id: options.id, preset: tool.preset, box, text: EMPTY_TEXT_BODY });
    }
    case "line": {
      const end = options.clicked ? { x: options.origin.x + DEFAULT_LINE_LENGTH, y: options.origin.y } : options.current;
      return createLine({ id: options.id, tool, start: options.origin, end });
    }
    case "table": {
      const box = options.clicked
        ? { x: options.origin.x, y: options.origin.y, width: tool.columnCount * DEFAULT_TABLE_COLUMN_WIDTH, height: tool.rowCount * DEFAULT_TABLE_ROW_HEIGHT }
        : atLeastOneUnit(options.dragged);
      return createTable({ id: options.id, minter: options.minter, rowCount: tool.rowCount, columnCount: tool.columnCount, box });
    }
    default:
      return assertNever(tool);
  }
}

function atLeastOneUnit(box: Box): Box {
  return { ...box, width: Math.max(1, box.width), height: Math.max(1, box.height) };
}

function commitTableLine(state: EditorState, gesture: Extract<Gesture, { kind: "resizingTableLine" }>): EditorState {
  const slideId = state.currentSlideId;
  const slide = slideId === null ? null : findSlide(state.document, slideId);
  const element = slide === null ? null : findElement(slide, gesture.elementId);
  if (slideId === null || element === null) return state;
  switch (element.kind) {
    case "table":
      return queueTableLine(state, slideId, element, gesture);
    case "shape":
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return state;
    default:
      return assertNever(element);
  }
}

function queueTableLine(state: EditorState, slideId: NonNullable<EditorState["currentSlideId"]>, table: TableElement, gesture: Extract<Gesture, { kind: "resizingTableLine" }>): EditorState {
  // The drag in the table's own axes, so a rotated table resizes along its edges.
  const radians = (-table.frame.rotation * Math.PI) / 180;
  const deltaX = gesture.current.x - gesture.origin.x;
  const deltaY = gesture.current.y - gesture.origin.y;
  const localX = deltaX * Math.cos(radians) - deltaY * Math.sin(radians);
  const localY = deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
  const line = gesture.line;
  switch (line.kind) {
    case "column": {
      const index = table.columns.findIndex((column) => column.id === line.columnId);
      const column = table.columns[index];
      if (column === undefined || localX === 0) return state;
      const width = Math.max(MINIMUM_TABLE_LINE_SIZE, column.width + localX);
      const next = table.columns[index + 1];
      const widths = [{ columnId: column.id, width }];
      // An inner boundary trades width with its neighbour; the last one grows the table.
      if (next !== undefined) widths.push({ columnId: next.id, width: Math.max(MINIMUM_TABLE_LINE_SIZE, next.width - (width - column.width)) });
      const total = table.columns.reduce((sum, candidate) => sum + (widths.find((changed) => changed.columnId === candidate.id)?.width ?? candidate.width), 0);
      const commands: DocumentCommand[] = [{ kind: "setTableColumnWidths", slideId, elementId: table.id, widths }];
      if (Math.abs(total - table.frame.width) > 0.001) commands.push({ kind: "setFrames", slideId, frames: [{ kind: "box", elementId: table.id, frame: { ...table.frame, width: total } }] });
      return queueCommands(state, commands);
    }
    case "row": {
      const row = table.rows.find((candidate) => candidate.id === line.rowId);
      if (row === undefined || localY === 0) return state;
      const measured = measuredRowHeight(state, table, row.id) ?? row.minimumHeight;
      const minimumHeight = Math.max(MINIMUM_TABLE_LINE_SIZE, measured + localY);
      const total = table.rows.reduce((sum, candidate) => sum + (candidate.id === row.id ? minimumHeight : candidate.minimumHeight), 0);
      const commands: DocumentCommand[] = [{ kind: "setTableRowHeights", slideId, elementId: table.id, heights: [{ rowId: row.id, minimumHeight }] }];
      if (Math.abs(total - table.frame.height) > 0.001) commands.push({ kind: "setFrames", slideId, frames: [{ kind: "box", elementId: table.id, frame: { ...table.frame, height: total } }] });
      return queueCommands(state, commands);
    }
    default:
      return assertNever(line);
  }
}

function measuredRowHeight(state: EditorState, table: TableElement, rowId: TableElement["rows"][number]["id"]): number | null {
  const measurement = state.measuredLayouts.get(table.id);
  if (measurement === undefined) return null;
  switch (measurement.kind) {
    case "table":
      return measurement.rowHeights.find((row) => row.rowId === rowId)?.height ?? null;
    case "text":
      return null;
    default:
      return assertNever(measurement);
  }
}

function startMarking(state: EditorState, kind: Marking["kind"], point: Point): EditorState {
  const opened = ensureComposer(state);
  const at = toFraction(referenceBoxForComposer(opened), point);
  const marking: Marking = markingStartingAt(kind, at, MARKING_COLOUR);
  return { ...opened, gesture: { kind: "drawingMarking", marking } };
}

function markingStartingAt(kind: Marking["kind"], at: Point, colour: string): Marking {
  switch (kind) {
    case "pen":
      return { kind: "pen", points: [at], colour, width: 3 };
    case "rectangle":
      return { kind: "rectangle", region: { x: at.x, y: at.y, width: 0, height: 0 }, colour };
    case "arrow":
      return { kind: "arrow", from: at, to: at, colour };
    case "highlight":
      return { kind: "highlight", region: { x: at.x, y: at.y, width: 0, height: 0 }, colour: HIGHLIGHT_COLOUR };
    default:
      return assertNever(kind);
  }
}

/** While drawing, a rectangle keeps its start corner in x/y and a signed size; the commit normalises. */
function extendMarking(marking: Marking, at: Point): Marking {
  switch (marking.kind) {
    case "pen": {
      // Pointer up repeats the last move's position; a stroke never stores the same point twice in a row.
      const last = marking.points[marking.points.length - 1];
      return last !== undefined && last.x === at.x && last.y === at.y ? marking : { ...marking, points: [...marking.points, at] };
    }
    case "rectangle":
    case "highlight":
      return { ...marking, region: { x: marking.region.x, y: marking.region.y, width: at.x - marking.region.x, height: at.y - marking.region.y } };
    case "arrow":
      return { ...marking, to: at };
    default:
      return assertNever(marking);
  }
}

function commitMarking(state: EditorState, marking: Marking): EditorState {
  const normalised = normaliseMarking(marking);
  const opened = ensureComposer(state);
  const composer: CommentComposer = opened.chrome.composer;
  switch (composer.kind) {
    case "composing":
      return { ...opened, chrome: { ...opened.chrome, composer: { ...composer, markings: [...composer.markings, normalised] } } };
    case "closed":
      return opened;
    default:
      return assertNever(composer);
  }
}

function normaliseMarking(marking: Marking): Marking {
  switch (marking.kind) {
    case "rectangle":
    case "highlight": {
      const region = marking.region;
      return {
        ...marking,
        region: {
          x: Math.min(region.x, region.x + region.width),
          y: Math.min(region.y, region.y + region.height),
          width: Math.abs(region.width),
          height: Math.abs(region.height),
        },
      };
    }
    case "pen":
    case "arrow":
      return marking;
    default:
      return assertNever(marking);
  }
}

function ensureComposer(state: EditorState): EditorState {
  switch (state.chrome.composer.kind) {
    case "composing":
      return state;
    case "closed":
      return state.currentSlideId === null ? state : openComposer(state, { slideId: state.currentSlideId, elementId: null, textRange: null, region: null });
    default:
      return assertNever(state.chrome.composer);
  }
}

function toFraction(reference: Box, point: Point): Point {
  return {
    x: reference.width === 0 ? 0 : (point.x - reference.x) / reference.width,
    y: reference.height === 0 ? 0 : (point.y - reference.y) / reference.height,
  };
}

function fractionOf(reference: Box, box: Box): Box {
  const topLeft = toFraction(reference, { x: box.x, y: box.y });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: reference.width === 0 ? 0 : box.width / reference.width,
    height: reference.height === 0 ? 0 : box.height / reference.height,
  };
}

function clientDistance(first: PointerSample, second: PointerSample): number {
  return Math.hypot(second.clientPoint.x - first.clientPoint.x, second.clientPoint.y - first.clientPoint.y);
}

function squareCorner(origin: Point, point: Point): Point {
  const side = Math.max(Math.abs(point.x - origin.x), Math.abs(point.y - origin.y));
  return { x: origin.x + Math.sign(point.x - origin.x || 1) * side, y: origin.y + Math.sign(point.y - origin.y || 1) * side };
}
