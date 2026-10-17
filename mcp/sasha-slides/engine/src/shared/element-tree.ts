// THE ELEMENT TREE AS EVERY LAYER WALKS IT: a node's children and leaves, an element anywhere in a
// tree by id, an element narrowed to one kind, the element a text target names, the frame an element
// shows once the view measured its table, and a group's frame derived from its leaves. Pure
// functions of snapshot values, DOM-free and Node-free, so the model, the state module, the view
// and the presenter read one copy, and the connector's deck tools can import it too.
//
// Key decisions:
//
//  * ONE GROUP FRAME. The model projects every group with `derivedGroupFrame` (model/element-tree.ts):
//    the LEAVES' covered points (a line's two end points, nested groups flattened) measured in the
//    group's own rotated axes, rotation normalised. The canvas's drag preview (canvas-geometry.ts)
//    and the presenter's builds (build-states.ts) re-derive a moved group with the same function, so
//    a handle never jumps on release and a built slide's group matches the stored one.
//  * NARROWING IS ONE GENERIC FUNCTION. `elementOfKind(element, "table")` replaces a hand-written
//    exhaustive switch per kind; adding an element kind cannot make it wrong, since it compares the
//    kind the caller names rather than listing kinds.

import { assertNever } from "../contracts/assert-never.ts";
import type { ElementSnapshot, TableElement } from "../contracts/document.ts";
import type { ElementMeasurement } from "../contracts/editor-state.ts";
import { boundsOfPoints, frameCentre, frameCorners, normaliseRotation, rotatePoint, type Frame, type Point } from "../contracts/geometry.ts";
import type { ElementId } from "../contracts/ids.ts";
import type { TextTarget } from "../contracts/selection.ts";
import type { Border, Stroke } from "../contracts/style.ts";

/** A group's children; none for a leaf. */
export function childrenOf(element: ElementSnapshot): readonly ElementSnapshot[] {
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

/** Every non-group element in the subtree, in z-order (the element itself when it is a leaf). */
export function leavesOf(element: ElementSnapshot): readonly ElementSnapshot[] {
  switch (element.kind) {
    case "group":
      return element.children.flatMap(leavesOf);
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return [element];
    default:
      return assertNever(element);
  }
}

/**
 * The element with this id anywhere in the tree, groups included; null when absent. The id may be
 * attribute text read back from the page: a match proves it is one of the tree's ids.
 */
export function findInTree(elements: readonly ElementSnapshot[], elementId: string): ElementSnapshot | null {
  for (const element of elements) {
    if (element.id === elementId) return element;
    const inside = findInTree(childrenOf(element), elementId);
    if (inside !== null) return inside;
  }
  return null;
}

/** The element when it is of `kind`, else null (null in, null out). */
export function elementOfKind<TKind extends ElementSnapshot["kind"]>(element: ElementSnapshot | null, kind: TKind): Extract<ElementSnapshot, { kind: TKind }> | null {
  return element !== null && isOfKind(element, kind) ? element : null;
}

/** The element as a table, or null for every other kind. */
export function tableOf(element: ElementSnapshot): TableElement | null {
  return elementOfKind(element, "table");
}

/** The element whose text a target edits; null for the speaker notes. */
export function textTargetElementId(target: TextTarget): ElementId | null {
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

/** An element's frame as it shows: a table's height is its measured rows when they are taller. */
export function visibleFrame(options: Readonly<{ element: ElementSnapshot; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): Frame {
  return withMeasuredHeight(options.element.id, options.element.frame, options.measured);
}

/** `frame` with the measured table height of `elementId` when one is larger (rows grow with text). */
export function withMeasuredHeight(elementId: ElementId, frame: Frame, measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>): Frame {
  const measurement = measuredLayouts.get(elementId);
  if (measurement === undefined) return frame;
  switch (measurement.kind) {
    case "table": {
      const height = measurement.rowHeights.reduce((total, row) => total + row.height, 0);
      return height > frame.height ? { ...frame, height } : frame;
    }
    case "text":
      return frame;
    default:
      return assertNever(measurement);
  }
}

/** All the points a node covers, in slide space: a line's ends, a box's corners, a group's leaves'. */
export function coveredPoints(element: ElementSnapshot): readonly Point[] {
  switch (element.kind) {
    case "group":
      return element.children.flatMap(coveredPoints);
    case "line":
      return [element.start, element.end];
    case "shape":
    case "image":
    case "table":
    case "unsupported":
      return frameCorners(element.frame);
    default:
      return assertNever(element);
  }
}

/** A group's frame: its leaves' bounds measured in the group's own rotated axes (see the header). */
export function derivedGroupFrame(options: Readonly<{ rotation: number; children: readonly ElementSnapshot[] }>): Frame {
  const rotation = normaliseRotation(options.rotation);
  const local = options.children.flatMap(coveredPoints).map((point) => rotatePoint({ point, centre: ORIGIN, degrees: -rotation }));
  const box = boundsOfPoints(local) ?? { x: 0, y: 0, width: 0, height: 0 };
  const centre = rotatePoint({ point: frameCentre(box), centre: ORIGIN, degrees: rotation });
  return {
    x: centre.x - box.width / 2,
    y: centre.y - box.height / 2,
    width: box.width,
    height: box.height,
    rotation,
    flipHorizontal: false,
    flipVertical: false,
  };
}

/** The one stroke a border draws for a single-outline reader: a uniform border's, or the first drawn side's. */
export function firstDrawnStroke(border: Border): Stroke | null {
  switch (border.kind) {
    case "none":
      return null;
    case "uniform":
      return border.stroke;
    case "perSide":
      return border.top ?? border.right ?? border.bottom ?? border.left;
    default:
      return assertNever(border);
  }
}

const ORIGIN: Point = { x: 0, y: 0 };

function isOfKind<TKind extends ElementSnapshot["kind"]>(element: ElementSnapshot, kind: TKind): element is Extract<ElementSnapshot, { kind: TKind }> {
  return element.kind === kind;
}
