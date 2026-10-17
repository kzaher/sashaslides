// WHAT THE SELECTION NAMES, read from state. The selection is a closed union (contracts/selection.ts)
// and almost every intent forks on it -- Delete removes slides, elements or characters; a style
// applies to a text range or to whole bodies -- so the forks that only need "which elements" or
// "which text" are answered here once, exhaustively, and the reducers stay flat.

import {
  assertNever,
  type EditorState,
  type ElementId,
  type ElementSnapshot,
  type Selection,
  type SlideId,
  type SlideSnapshot,
} from "../../contracts/index.ts";
import { textTargetElementId } from "../../shared/element-tree.ts";
import { elementsById, findSlide, textBodyOf } from "./document-lookup.ts";

export type TextSelection = Extract<Selection, { kind: "text" }>;

export type SelectedElements = Readonly<{ slide: SlideSnapshot; elements: readonly ElementSnapshot[] }>;

export function textSelectionOf(selection: Selection): TextSelection | null {
  switch (selection.kind) {
    case "text":
      return selection;
    case "none":
    case "slides":
    case "elements":
    case "tableCells":
      return null;
    default:
      return assertNever(selection);
  }
}

/** The elements an element-level intent acts on: the selection, or the element being typed in. */
export function selectedElements(state: EditorState): SelectedElements | null {
  const reference = selectedElementReference(state.selection);
  if (reference === null) return null;
  const slide = findSlide(state.document, reference.slideId);
  if (slide === null) return null;
  const elements = elementsById(slide, reference.elementIds);
  return elements.length === 0 ? null : { slide, elements };
}

export function selectedElementReference(selection: Selection): Readonly<{ slideId: SlideId; elementIds: readonly ElementId[] }> | null {
  switch (selection.kind) {
    case "elements":
      return { slideId: selection.slideId, elementIds: selection.elementIds };
    case "text": {
      const elementId = textTargetElementId(selection.target);
      return elementId === null ? null : { slideId: selection.target.slideId, elementIds: [elementId] };
    }
    case "tableCells":
      return { slideId: selection.slideId, elementIds: [selection.elementId] };
    case "none":
    case "slides":
      return null;
    default:
      return assertNever(selection);
  }
}

/** The slide the selection is on, if it is on exactly one. */
export function selectionSlideId(selection: Selection): SlideId | null {
  switch (selection.kind) {
    case "elements":
    case "tableCells":
      return selection.slideId;
    case "text":
      return selection.target.slideId;
    case "slides":
      return selection.slideIds.length === 1 ? (selection.slideIds[0] ?? null) : null;
    case "none":
      return null;
    default:
      return assertNever(selection);
  }
}

export function isElementSelected(selection: Selection, elementId: ElementId): boolean {
  switch (selection.kind) {
    case "elements":
      return selection.elementIds.includes(elementId);
    case "none":
    case "slides":
    case "text":
    case "tableCells":
      return false;
    default:
      return assertNever(selection);
  }
}

/** The selection with everything that no longer exists dropped (SPEC.md "Selection survival"). */
export function surviveDocument(state: EditorState): Selection {
  const selection = state.selection;
  switch (selection.kind) {
    case "none":
      return selection;
    case "slides": {
      const slideIds = selection.slideIds.filter((slideId) => findSlide(state.document, slideId) !== null);
      if (slideIds.length === selection.slideIds.length) return selection;
      return slideIds.length === 0 ? { kind: "none" } : { kind: "slides", slideIds };
    }
    case "elements": {
      const slide = findSlide(state.document, selection.slideId);
      if (slide === null) return { kind: "none" };
      const elementIds = elementsById(slide, selection.elementIds).map((element) => element.id);
      if (elementIds.length === selection.elementIds.length) return selection;
      return elementIds.length === 0 ? { kind: "none" } : { kind: "elements", slideId: selection.slideId, elementIds };
    }
    case "text": {
      if (textBodyOf(state.document, selection.target) !== null) return selection;
      const elementId = textTargetElementId(selection.target);
      const slide = findSlide(state.document, selection.target.slideId);
      if (elementId === null || slide === null || elementsById(slide, [elementId]).length === 0) return { kind: "none" };
      return { kind: "elements", slideId: selection.target.slideId, elementIds: [elementId] };
    }
    case "tableCells": {
      const slide = findSlide(state.document, selection.slideId);
      if (slide === null || elementsById(slide, [selection.elementId]).length === 0) return { kind: "none" };
      return selection;
    }
    default:
      return assertNever(selection);
  }
}

/** Select these elements on the current slide (none for an empty list), leaving text mode. */
export function selectElements(state: EditorState, elementIds: readonly ElementId[]): EditorState {
  const slideId = state.currentSlideId;
  const selection: Selection = slideId === null || elementIds.length === 0 ? { kind: "none" } : { kind: "elements", slideId, elementIds };
  return { ...state, selection, textEditing: { ...state.textEditing, composition: null, typingStyle: {} } };
}
