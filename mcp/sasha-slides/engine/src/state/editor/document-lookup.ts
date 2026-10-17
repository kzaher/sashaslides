// READING THE DOCUMENT SNAPSHOT the way the editor needs it: slides and elements by id (groups are a
// tree in the snapshot), the elements a selection names, text bodies by target, and element BOUNDS
// that use the view's measured table heights. Every gesture, alignment and hit decision goes through
// these, so "where is this element" has one answer in the state module -- the same one the view's
// handles show, because both read `measuredLayouts` (SPEC.md "Measured layout").

import {
  assertNever,
  boundsOfBoxes,
  rotatedBounds,
  type Box,
  type DocumentSnapshot,
  type ElementId,
  type ElementMeasurement,
  type ElementSnapshot,
  type Frame,
  type PlaceholderRole,
  type ShapeElement,
  type SlideId,
  type SlideSnapshot,
  type TextBody,
  type TextTarget,
} from "../../contracts/index.ts";
import { childrenOf, findInTree, withMeasuredHeight } from "../../shared/element-tree.ts";

export { childrenOf, leavesOf, tableOf, withMeasuredHeight } from "../../shared/element-tree.ts";

export function findSlide(document: DocumentSnapshot, slideId: SlideId): SlideSnapshot | null {
  return document.slides.find((slide) => slide.id === slideId) ?? null;
}

export function findSlideIndex(document: DocumentSnapshot, slideId: SlideId): number {
  return document.slides.findIndex((slide) => slide.id === slideId);
}

/** The element with `elementId` anywhere in the slide's tree. */
export function findElement(slide: SlideSnapshot, elementId: ElementId): ElementSnapshot | null {
  return findInTree(slide.elements, elementId);
}

/** The ancestors of `elementId`, outermost first, ending with the element itself; null when absent. */
export function findElementPath(slide: SlideSnapshot, elementId: ElementId): readonly ElementSnapshot[] | null {
  return pathInList(slide.elements, elementId);
}

/** The elements clicks select at this depth: the top level, or the children of the entered group. */
export function selectableElements(slide: SlideSnapshot, enteredGroupId: ElementId | null): readonly ElementSnapshot[] {
  if (enteredGroupId === null) return slide.elements;
  const group = findElement(slide, enteredGroupId);
  if (group === null) return slide.elements;
  return childrenOf(group);
}

/** Every group in the subtree, outermost first (the element itself when it is a group). */
export function groupsOf(element: ElementSnapshot): readonly Extract<ElementSnapshot, { kind: "group" }>[] {
  switch (element.kind) {
    case "group":
      return [element, ...element.children.flatMap(groupsOf)];
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

/** Every element in the subtree including groups, outermost first. */
export function subtreeOf(element: ElementSnapshot): readonly ElementSnapshot[] {
  return [element, ...childrenOf(element).flatMap(subtreeOf)];
}

/** The shape whose text a double click or Enter edits; null for elements without a text body. */
export function textShapeOf(element: ElementSnapshot): ShapeElement | null {
  switch (element.kind) {
    case "shape":
      return element;
    case "group":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

/** The text body a target names, or null when it no longer exists. */
export function textBodyOf(document: DocumentSnapshot, target: TextTarget): TextBody | null {
  const slide = findSlide(document, target.slideId);
  if (slide === null) return null;
  switch (target.kind) {
    case "speakerNotes":
      return slide.speakerNotes;
    case "element": {
      const element = findElement(slide, target.elementId);
      return element === null ? null : (textShapeOf(element)?.text ?? null);
    }
    case "tableCell": {
      const element = findElement(slide, target.elementId);
      if (element === null) return null;
      switch (element.kind) {
        case "table":
          return element.cells.find((cell) => cell.rowId === target.cell.rowId && cell.columnId === target.cell.columnId)?.text ?? null;
        case "shape":
        case "group":
        case "image":
        case "line":
        case "unsupported":
          return null;
        default:
          return assertNever(element);
      }
    }
    default:
      return assertNever(target);
  }
}

/** The placeholder role a text target's element plays, for style resolution; null for none. */
export function findPlaceholderRole(document: DocumentSnapshot, target: TextTarget): PlaceholderRole | null {
  switch (target.kind) {
    case "element": {
      const slide = findSlide(document, target.slideId);
      const element = slide === null ? null : findElement(slide, target.elementId);
      return element?.placeholder?.role ?? null;
    }
    case "tableCell":
    case "speakerNotes":
      return null;
    default:
      return assertNever(target);
  }
}

/**
 * The frame geometry should use: the stored frame, with a table's height replaced by the sum of its
 * measured row heights when the view reported one (rows grow with text past their stored height).
 */
export function measuredFrame(element: ElementSnapshot, measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>): Frame {
  return withMeasuredHeight(element.id, element.frame, measuredLayouts);
}

/** The axis-aligned box an element covers on the slide (rotation and measured heights included). */
export function elementBounds(element: ElementSnapshot, measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>): Box {
  switch (element.kind) {
    case "group": {
      const bounds = boundsOfBoxes(element.children.map((child) => elementBounds(child, measuredLayouts)));
      return bounds ?? rotatedBounds(element.frame);
    }
    case "line":
      return { x: element.frame.x, y: element.frame.y, width: element.frame.width, height: element.frame.height };
    case "shape":
    case "image":
    case "table":
    case "unsupported":
      return rotatedBounds(measuredFrame(element, measuredLayouts));
    default:
      return assertNever(element);
  }
}

export function boundsOfElements(elements: readonly ElementSnapshot[], measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>): Box | null {
  return boundsOfBoxes(elements.map((element) => elementBounds(element, measuredLayouts)));
}

export function boxesIntersect(first: Box, second: Box): boolean {
  return first.x <= second.x + second.width && second.x <= first.x + first.width && first.y <= second.y + second.height && second.y <= first.y + first.height;
}

export function slideBox(document: DocumentSnapshot): Box {
  return { x: 0, y: 0, width: document.pageSize.width, height: document.pageSize.height };
}

/** The slide's elements by id, looked up once per call site that needs many. */
export function elementsById(slide: SlideSnapshot, elementIds: readonly ElementId[]): readonly ElementSnapshot[] {
  const found: ElementSnapshot[] = [];
  for (const elementId of elementIds) {
    const element = findElement(slide, elementId);
    if (element !== null) found.push(element);
  }
  return found;
}

function pathInList(elements: readonly ElementSnapshot[], elementId: ElementId): readonly ElementSnapshot[] | null {
  for (const element of elements) {
    if (element.id === elementId) return [element];
    const inside = pathInList(childrenOf(element), elementId);
    if (inside !== null) return [element, ...inside];
  }
  return null;
}
