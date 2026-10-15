// ARRANGE: order, alignment, distribution, grouping, flips, quarter turns, centring, nudges and the
// properties panel's frame fields. Pure functions over the selected elements' ROTATED BOUNDS, with
// measured table heights (a table whose rows grew with text aligns by what is visible), each ending
// in one envelope. Elements move as units: a group's leaves move together and its own rotation is
// untouched by a translation.
//
//  * One element aligns to the slide; several align to their common bounds.
//  * Distribution needs three or more and keeps the outermost two where they are, spacing the rest
//    with equal gaps between them.
//  * A flip mirrors every member about the selection's centre (geometry.ts `flipFrame`), negating
//    rotations and toggling flips; a group's own rotation is negated with it.

import {
  assertNever,
  boundsOfBoxes,
  frameCentre,
  normaliseRotation,
  type ArrangeAction,
  type Box,
  type DocumentCommand,
  type EditorState,
  type ElementSnapshot,
  type FrameUpdate,
  type SlideId,
} from "../../contracts/index.ts";
import { elementBounds, slideBox } from "./document-lookup.ts";
import { queueEnvelope } from "./editor-queue.ts";
import { selectedElements, type SelectedElements } from "./editor-selection.ts";
import { createIdMinter } from "./id-minter.ts";
import { boundsOfUpdates, flipUpdates, groupRotationUpdates, leafUpdates, rotateUpdates, scaleUpdates, selectionFrame, translateUpdates } from "./frame-updates.ts";

export type AlignEdge = Extract<ArrangeAction, { kind: "align" }>["edge"];

export function reduceArrange(state: EditorState, action: ArrangeAction): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return state;
  const slideId = selected.slide.id;
  switch (action.kind) {
    case "reorder":
      return queueEnvelope(state, {
        commands: [{ kind: "reorderElements", slideId, elementIds: selected.elements.map((element) => element.id), placement: action.placement }],
        selectionAfter: state.selection,
        mergeWithPrevious: false,
      });
    case "align":
      return queueFrames(state, slideId, alignUpdates({ state, selected, edge: action.edge }));
    case "distribute":
      return queueFrames(state, slideId, distributeUpdates({ state, selected, axis: action.axis }));
    case "group":
      return groupSelection(state, selected);
    case "ungroup":
      return ungroupSelection(state, selected);
    case "flip": {
      const frame = selectionFrame(selected.elements, state.measuredLayouts);
      if (frame === null) return state;
      const centre = frameCentre(frame);
      const updates = [...leafUpdates(selected.elements), ...groupRotationUpdates(selected.elements)];
      return queueFrames(state, slideId, flipUpdates(updates, action.axis, AXIS_CENTRE[action.axis](centre)));
    }
    case "rotate": {
      const frame = selectionFrame(selected.elements, state.measuredLayouts);
      if (frame === null) return state;
      const updates = [...leafUpdates(selected.elements), ...groupRotationUpdates(selected.elements)];
      return queueFrames(state, slideId, rotateUpdates(updates, frameCentre(frame), action.degrees));
    }
    case "centreOnSlide": {
      const bounds = boundsOfUpdates(leafUpdates(selected.elements), state.measuredLayouts);
      if (bounds === null) return state;
      const slide = slideBox(state.document);
      const along = AXIS_ACCESS[action.axis];
      const offset = AXIS_OFFSET[action.axis](along.start(slide) + along.size(slide) / 2 - (along.start(bounds) + along.size(bounds) / 2));
      return queueFrames(state, slideId, translateUpdates(leafUpdates(selected.elements), offset.x, offset.y));
    }
    default:
      return assertNever(action);
  }
}

/** The new frames for aligning `edge`: to the slide for one element, to the common bounds for several. */
export function alignUpdates(options: Readonly<{ state: EditorState; selected: SelectedElements; edge: AlignEdge }>): readonly FrameUpdate[] {
  const elements = options.selected.elements;
  const boundsOfEach = elements.map((element) => elementBounds(element, options.state.measuredLayouts));
  const reference = elements.length === 1 ? slideBox(options.state.document) : boundsOfBoxes(boundsOfEach);
  if (reference === null) return [];
  return elements.flatMap((element, index) => {
    const bounds = boundsOfEach[index];
    if (bounds === undefined) return [];
    const offset = alignOffset(options.edge, bounds, reference);
    return translateUpdates(leafUpdates([element]), offset.x, offset.y);
  });
}

/** Equal gaps between three or more elements; the outermost two stay where they are. */
export function distributeUpdates(options: Readonly<{ state: EditorState; selected: SelectedElements; axis: "horizontal" | "vertical" }>): readonly FrameUpdate[] {
  const elements = options.selected.elements;
  if (elements.length < 3) return [];
  const along = AXIS_ACCESS[options.axis];
  const entries = elements
    .map((element) => ({ element, bounds: elementBounds(element, options.state.measuredLayouts) }))
    .sort((first, second) => along.start(first.bounds) + along.size(first.bounds) / 2 - (along.start(second.bounds) + along.size(second.bounds) / 2));
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return [];
  const inner = entries.slice(1, -1);
  const innerSize = inner.reduce((total, entry) => total + along.size(entry.bounds), 0);
  const gap = (along.start(last.bounds) - (along.start(first.bounds) + along.size(first.bounds)) - innerSize) / (entries.length - 1);
  let cursor = along.start(first.bounds) + along.size(first.bounds) + gap;
  return inner.flatMap((entry) => {
    const offset = AXIS_OFFSET[options.axis](cursor - along.start(entry.bounds));
    cursor += along.size(entry.bounds) + gap;
    return translateUpdates(leafUpdates([entry.element]), offset.x, offset.y);
  });
}

/** Arrow keys: 1 unit, 10 with Shift (keyboard.ts). */
export function nudgeSelection(state: EditorState, deltaX: number, deltaY: number): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return state;
  switch (state.selection.kind) {
    case "elements":
      break;
    case "none":
    case "slides":
    case "text":
    case "tableCells":
      return state;
    default:
      return assertNever(state.selection);
  }
  return queueFrames(state, selected.slide.id, translateUpdates(leafUpdates(selected.elements), deltaX, deltaY));
}

/** A typed frame field: a lone element's own frame; several elements move or scale as one box. */
export function editFrameField(state: EditorState, field: "x" | "y" | "width" | "height" | "rotation", value: number): EditorState {
  const selected = selectedElements(state);
  if (selected === null || !Number.isFinite(value)) return state;
  const from = selectionFrame(selected.elements, state.measuredLayouts);
  if (from === null) return state;
  const updates = [...leafUpdates(selected.elements), ...groupRotationUpdates(selected.elements)];
  switch (field) {
    case "x":
      return queueFrames(state, selected.slide.id, translateUpdates(leafUpdates(selected.elements), value - from.x, 0));
    case "y":
      return queueFrames(state, selected.slide.id, translateUpdates(leafUpdates(selected.elements), 0, value - from.y));
    case "width": {
      const width = Math.max(1, value);
      const height = state.ui.aspectRatioLocked && from.width > 0 ? Math.max(1, (from.height * width) / from.width) : from.height;
      return queueFrames(state, selected.slide.id, scaleUpdates(updates, from, { ...from, width, height }));
    }
    case "height": {
      const height = Math.max(1, value);
      const width = state.ui.aspectRatioLocked && from.height > 0 ? Math.max(1, (from.width * height) / from.height) : from.width;
      return queueFrames(state, selected.slide.id, scaleUpdates(updates, from, { ...from, width, height }));
    }
    case "rotation": {
      const degrees = normaliseRotation(value) - from.rotation;
      return queueFrames(state, selected.slide.id, rotateUpdates(updates, frameCentre(from), degrees));
    }
    default:
      return assertNever(field);
  }
}

function queueFrames(state: EditorState, slideId: SlideId, frames: readonly FrameUpdate[]): EditorState {
  if (frames.length === 0) return state;
  const commands: readonly DocumentCommand[] = [{ kind: "setFrames", slideId, frames }];
  return queueEnvelope(state, { commands, selectionAfter: state.selection, mergeWithPrevious: false });
}

function groupSelection(state: EditorState, selected: SelectedElements): EditorState {
  if (selected.elements.length < 2) return state;
  const minter = createIdMinter(state.idSeed);
  const groupId = minter.next("element");
  return queueEnvelope(
    { ...state, idSeed: minter.seed() },
    {
      commands: [{ kind: "groupElements", slideId: selected.slide.id, elementIds: selected.elements.map((element) => element.id), groupId }],
      selectionAfter: { kind: "elements", slideId: selected.slide.id, elementIds: [groupId] },
      mergeWithPrevious: false,
    },
  );
}

function ungroupSelection(state: EditorState, selected: SelectedElements): EditorState {
  const groups = selected.elements.filter((element) => childrenIfGroup(element) !== null);
  if (groups.length === 0) return state;
  const childIds = selected.elements.flatMap((element) => (childrenIfGroup(element) ?? [element]).map((child) => child.id));
  return queueEnvelope(state, {
    commands: [{ kind: "ungroupElements", slideId: selected.slide.id, groupIds: groups.map((group) => group.id) }],
    selectionAfter: { kind: "elements", slideId: selected.slide.id, elementIds: childIds },
    mergeWithPrevious: false,
  });
}

function childrenIfGroup(element: ElementSnapshot): readonly ElementSnapshot[] | null {
  switch (element.kind) {
    case "group":
      return element.children;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function alignOffset(edge: AlignEdge, bounds: Box, reference: Box): Readonly<{ x: number; y: number }> {
  switch (edge) {
    case "left":
      return { x: reference.x - bounds.x, y: 0 };
    case "horizontalCentre":
      return { x: reference.x + reference.width / 2 - (bounds.x + bounds.width / 2), y: 0 };
    case "right":
      return { x: reference.x + reference.width - (bounds.x + bounds.width), y: 0 };
    case "top":
      return { x: 0, y: reference.y - bounds.y };
    case "verticalCentre":
      return { x: 0, y: reference.y + reference.height / 2 - (bounds.y + bounds.height / 2) };
    case "bottom":
      return { x: 0, y: reference.y + reference.height - (bounds.y + bounds.height) };
    default:
      return assertNever(edge);
  }
}

const AXIS_CENTRE: Readonly<Record<"horizontal" | "vertical", (centre: Readonly<{ x: number; y: number }>) => number>> = {
  horizontal: (centre) => centre.x,
  vertical: (centre) => centre.y,
};

const AXIS_OFFSET: Readonly<Record<"horizontal" | "vertical", (delta: number) => Readonly<{ x: number; y: number }>>> = {
  horizontal: (delta) => ({ x: delta, y: 0 }),
  vertical: (delta) => ({ x: 0, y: delta }),
};

const AXIS_ACCESS: Readonly<Record<"horizontal" | "vertical", Readonly<{ start: (box: Box) => number; size: (box: Box) => number }>>> = {
  horizontal: { start: (box) => box.x, size: (box) => box.width },
  vertical: { start: (box) => box.y, size: (box) => box.height },
};
