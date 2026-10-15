// GEOMETRY OF A SELECTION AS FRAME UPDATES. A gesture, a nudge, an alignment or a flip all end as one
// `setFrames` command: the final frame of every LEAF it moves plus each group's own rotation
// (contracts/commands.ts "geometry arrives expanded"). So the state module never edits a group's box;
// it turns the selection into `FrameUpdate`s once, transforms those with the pure rules in
// contracts/geometry.ts, and the preview the user sees during a drag IS the command it commits.
//
// Scaling works in the SELECTION FRAME's own axes: a rotated group scales along its rotated edges
// (children are rotated into the group's unrotated space, mapped between the two boxes with
// `scaleFrameBetweenBoxes` / `mapPointBetweenBoxes`, and rotated back), and a flip of the selection
// frame (resizing past the opposite edge) mirrors every member about the new box's centre with
// `flipFrame`, which negates rotations and toggles flips exactly as flipping does.

import {
  assertNever,
  boundsOfBoxes,
  boundsOfPoints,
  flipFrame,
  flipPoint,
  frameCentre,
  identityFrame,
  lineFrame,
  mapPointBetweenBoxes,
  normaliseRotation,
  rotatedBounds,
  rotateFrameAbout,
  rotatePoint,
  scaleFrameBetweenBoxes,
  type Box,
  type ElementId,
  type ElementMeasurement,
  type ElementSnapshot,
  type FlipAxis,
  type Frame,
  type FrameUpdate,
  type Point,
} from "../../contracts/index.ts";
import { groupsOf, leavesOf, withMeasuredHeight } from "./document-lookup.ts";

/** Box or line updates for every leaf under the elements (unsupported elements are never edited). */
export function leafUpdates(elements: readonly ElementSnapshot[]): readonly FrameUpdate[] {
  return elements.flatMap(leavesOf).flatMap((leaf): FrameUpdate[] => {
    switch (leaf.kind) {
      case "shape":
      case "image":
      case "table":
        return [{ kind: "box", elementId: leaf.id, frame: leaf.frame }];
      case "line":
        return [{ kind: "line", elementId: leaf.id, start: leaf.start, end: leaf.end }];
      case "group":
      case "unsupported":
        return [];
      default:
        return assertNever(leaf);
    }
  });
}

/** A group-rotation update for every group under the elements, outermost first. */
export function groupRotationUpdates(elements: readonly ElementSnapshot[]): readonly FrameUpdate[] {
  return elements.flatMap(groupsOf).map((group) => ({ kind: "groupRotation", elementId: group.id, rotation: group.frame.rotation }));
}

export function translateUpdates(updates: readonly FrameUpdate[], deltaX: number, deltaY: number): readonly FrameUpdate[] {
  return updates.map((update): FrameUpdate => {
    switch (update.kind) {
      case "box":
        return { ...update, frame: { ...update.frame, x: update.frame.x + deltaX, y: update.frame.y + deltaY } };
      case "line":
        return { ...update, start: translatePoint(update.start, deltaX, deltaY), end: translatePoint(update.end, deltaX, deltaY) };
      case "groupRotation":
        return update;
      default:
        return assertNever(update);
    }
  });
}

export function rotateUpdates(updates: readonly FrameUpdate[], pivot: Point, degrees: number): readonly FrameUpdate[] {
  return updates.map((update): FrameUpdate => {
    switch (update.kind) {
      case "box":
        return { ...update, frame: rotateFrameAbout({ frame: update.frame, pivot, degrees }) };
      case "line":
        return { ...update, start: rotatePoint({ point: update.start, centre: pivot, degrees }), end: rotatePoint({ point: update.end, centre: pivot, degrees }) };
      case "groupRotation":
        return { ...update, rotation: normaliseRotation(update.rotation + degrees) };
      default:
        return assertNever(update);
    }
  });
}

/** Mirror every member across `x = about` or `y = about` (geometry.ts `flipFrame`). */
export function flipUpdates(updates: readonly FrameUpdate[], axis: FlipAxis, about: number): readonly FrameUpdate[] {
  return updates.map((update): FrameUpdate => {
    switch (update.kind) {
      case "box":
        return { ...update, frame: flipFrame({ frame: update.frame, axis, about }) };
      case "line":
        return { ...update, start: flipPoint({ point: update.start, axis, about }), end: flipPoint({ point: update.end, axis, about }) };
      case "groupRotation":
        return { ...update, rotation: normaliseRotation(-update.rotation) };
      default:
        return assertNever(update);
    }
  });
}

/**
 * Map every member from the selection frame `from` to `to` (both may be rotated by the same angle;
 * `to` may carry toggled flips from resizing past an edge).
 */
export function scaleUpdates(updates: readonly FrameUpdate[], from: Frame, to: Frame): readonly FrameUpdate[] {
  const fromCentre = frameCentre(from);
  const toCentre = frameCentre(to);
  const fromBox: Box = { x: from.x, y: from.y, width: from.width, height: from.height };
  const toBox: Box = { x: to.x, y: to.y, width: to.width, height: to.height };
  const flipHorizontal = from.flipHorizontal !== to.flipHorizontal;
  const flipVertical = from.flipVertical !== to.flipVertical;
  const local = rotateUpdates(updates, fromCentre, -from.rotation);
  const scaled = local.map((update): FrameUpdate => {
    switch (update.kind) {
      case "box":
        return { ...update, frame: scaleFrameBetweenBoxes({ frame: update.frame, from: fromBox, to: toBox }) };
      case "line":
        return { ...update, start: mapPointBetweenBoxes({ point: update.start, from: fromBox, to: toBox }), end: mapPointBetweenBoxes({ point: update.end, from: fromBox, to: toBox }) };
      case "groupRotation":
        return update;
      default:
        return assertNever(update);
    }
  });
  const mirroredHorizontally = flipHorizontal ? flipUpdates(scaled, "horizontal", toCentre.x) : scaled;
  const mirrored = flipVertical ? flipUpdates(mirroredHorizontally, "vertical", toCentre.y) : mirroredHorizontally;
  return rotateUpdates(mirrored, toCentre, to.rotation);
}

/** The axis-aligned bounds the updates cover, with measured table heights where reported. */
export function boundsOfUpdates(updates: readonly FrameUpdate[], measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>): Box | null {
  return boundsOfBoxes(updates.flatMap((update): Box[] => {
    switch (update.kind) {
      case "box":
        return [rotatedBounds(withMeasuredHeight(update.elementId, update.frame, measuredLayouts))];
      case "line":
        return [boundsOfPoints([update.start, update.end]) ?? { x: update.start.x, y: update.start.y, width: 0, height: 0 }];
      case "groupRotation":
        return [];
      default:
        return assertNever(update);
    }
  }));
}

/** The frame the selection's handles sit on: a lone element's own frame, or the bounds of several. */
export function selectionFrame(elements: readonly ElementSnapshot[], measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>): Frame | null {
  const only = elements.length === 1 ? elements[0] : undefined;
  if (only !== undefined) {
    switch (only.kind) {
      case "line":
        return lineFrame({ start: only.start, end: only.end });
      case "shape":
      case "image":
      case "table":
      case "group":
      case "unsupported":
        return withMeasuredHeight(only.id, only.frame, measuredLayouts);
      default:
        return assertNever(only);
    }
  }
  const bounds = boundsOfUpdates(leafUpdates(elements), measuredLayouts);
  return bounds === null ? null : identityFrame(bounds);
}

export function sameUpdates(first: readonly FrameUpdate[], second: readonly FrameUpdate[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((update, index) => {
    const other = second[index];
    return other !== undefined && JSON.stringify(update) === JSON.stringify(other);
  });
}

function translatePoint(point: Point, deltaX: number, deltaY: number): Point {
  return { x: point.x + deltaX, y: point.y + deltaY };
}
