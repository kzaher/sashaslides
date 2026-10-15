// SLIDES AND WHOLE-SELECTION INTENTS: the filmstrip (activate, select, reorder by drag), new slides
// from layouts, duplicate, delete, select all, slide properties, Page Up / Page Down, Tab through
// elements, and presenting. New slides COPY their layout's elements with fresh ids (milestone 1 has
// no live master link, contracts/document.ts `LayoutSnapshot`); duplicates keep morph keys so a
// duplicated slide morphs from its original.

import {
  assertNever,
  EMPTY_TEXT_BODY,
  type DocumentCommand,
  type EditorState,
  type ElementSnapshot,
  type LayoutId,
  type SlideId,
  type SlidePropertiesPatch,
  type SlideSnapshot,
} from "../../contracts/index.ts";
import { findSlide, findSlideIndex, selectableElements } from "./document-lookup.ts";
import { optimisticText, queueEnvelope } from "./editor-queue.ts";
import { selectedElements, selectElements } from "./editor-selection.ts";
import { reidentifyElement, reidentifySlide, translateElement } from "./element-factory.ts";
import { createIdMinter } from "./id-minter.ts";

/** Duplicated elements land this far down and right of their originals, slide units. */
export const DUPLICATE_OFFSET_UNITS = 10;

export function activateSlide(state: EditorState, slideId: SlideId): EditorState {
  if (findSlide(state.document, slideId) === null) return state;
  return {
    ...state,
    currentSlideId: slideId,
    selection: { kind: "slides", slideIds: [slideId] },
    enteredGroupId: null,
    gesture: { kind: "idle" },
    textEditing: { ...state.textEditing, composition: null, typingStyle: {} },
  };
}

export function selectSlides(state: EditorState, slideIds: readonly SlideId[], mode: "replace" | "toggle" | "extend"): EditorState {
  const known = slideIds.filter((slideId) => findSlide(state.document, slideId) !== null);
  const last = known.at(-1);
  if (last === undefined) return state;
  const previous = selectedSlideIds(state);
  const next = slidesForMode({ state, previous, clicked: known, mode });
  return {
    ...state,
    currentSlideId: last,
    selection: next.length === 0 ? { kind: "none" } : { kind: "slides", slideIds: next },
    enteredGroupId: null,
    textEditing: { ...state.textEditing, composition: null, typingStyle: {} },
  };
}

export function newSlide(state: EditorState, layoutId: LayoutId | null): EditorState {
  const current = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
  const chosenLayoutId = layoutId ?? current?.layoutId ?? state.document.layouts[0]?.id ?? null;
  const layout = state.document.layouts.find((candidate) => candidate.id === chosenLayoutId) ?? null;
  const minter = createIdMinter(state.idSeed);
  const slideId = minter.next("slide");
  const elements = (layout?.elements ?? []).map((element) => emptiedPlaceholder(reidentifyElement(element, { minter, keepElementId: () => false, keepMorphKeys: false }, null)));
  const slide: SlideSnapshot = {
    id: slideId,
    layoutId: layout?.id ?? null,
    background: null,
    skipped: false,
    speakerNotes: EMPTY_TEXT_BODY,
    transition: null,
    elements,
  };
  const queued = queueEnvelope(
    { ...state, idSeed: minter.seed() },
    { commands: [{ kind: "insertSlides", slides: [slide], after: current?.id ?? state.document.slides.at(-1)?.id ?? null }], selectionAfter: { kind: "none" }, mergeWithPrevious: false },
  );
  return { ...queued, currentSlideId: slideId, enteredGroupId: null };
}

export function duplicateSelection(state: EditorState): EditorState {
  const selection = state.selection;
  switch (selection.kind) {
    case "slides":
      return duplicateSlides(state, selection.slideIds);
    case "elements":
    case "text":
    case "tableCells": {
      const selected = selectedElements(state);
      if (selected === null) return state;
      const minter = createIdMinter(state.idSeed);
      const copies = selected.elements.map((element) =>
        translateElement(reidentifyElement(element, { minter, keepElementId: () => false, keepMorphKeys: false }, null), DUPLICATE_OFFSET_UNITS, DUPLICATE_OFFSET_UNITS),
      );
      return queueEnvelope(
        { ...state, idSeed: minter.seed() },
        {
          commands: [{ kind: "insertElements", slideId: selected.slide.id, elements: copies, placement: { kind: "front" } }],
          selectionAfter: { kind: "elements", slideId: selected.slide.id, elementIds: copies.map((copy) => copy.id) },
          mergeWithPrevious: false,
        },
      );
    }
    case "none":
      return state.currentSlideId === null ? state : duplicateSlides(state, [state.currentSlideId]);
    default:
      return assertNever(selection);
  }
}

export function deleteSelection(state: EditorState): EditorState {
  const selection = state.selection;
  switch (selection.kind) {
    case "slides":
      return queueEnvelope(state, { commands: [{ kind: "deleteSlides", slideIds: selection.slideIds }], selectionAfter: { kind: "none" }, mergeWithPrevious: false });
    case "elements":
      return queueEnvelope(state, {
        commands: [{ kind: "deleteElements", slideId: selection.slideId, elementIds: selection.elementIds }],
        selectionAfter: { kind: "none" },
        mergeWithPrevious: false,
      });
    case "none":
    case "text":
    case "tableCells":
      return state;
    default:
      return assertNever(selection);
  }
}

/** Primary+A: the whole body in text, every slide in the filmstrip, else every element at this depth. */
export function selectAll(state: EditorState): EditorState {
  const selection = state.selection;
  switch (selection.kind) {
    case "text": {
      const items = optimisticText(state, selection.target);
      if (items === null) return state;
      return { ...state, selection: { ...selection, anchor: 0, focus: items.length - 1 } };
    }
    case "slides":
      return state.document.slides.length === 0 ? state : { ...state, selection: { kind: "slides", slideIds: state.document.slides.map((slide) => slide.id) } };
    case "none":
    case "elements":
    case "tableCells": {
      const slide = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
      if (slide === null) return state;
      return selectElements(state, selectableElements(slide, state.enteredGroupId).map((element) => element.id));
    }
    default:
      return assertNever(selection);
  }
}

export function startSlideDrag(state: EditorState, slideIds: readonly SlideId[]): EditorState {
  const known = slideIds.filter((slideId) => findSlide(state.document, slideId) !== null);
  if (known.length === 0) return state;
  return { ...state, gesture: { kind: "draggingSlides", slideIds: known, dropAfter: null } };
}

export function dragSlidesOver(state: EditorState, dropAfter: SlideId | null): EditorState {
  const gesture = state.gesture;
  switch (gesture.kind) {
    case "draggingSlides":
      return { ...state, gesture: { ...gesture, dropAfter } };
    case "idle":
    case "pressed":
    case "moving":
    case "resizing":
    case "rotating":
    case "movingLineEnd":
    case "marquee":
    case "creating":
    case "resizingTableLine":
    case "drawingMarking":
    case "panning":
      return state;
    default:
      return assertNever(gesture);
  }
}

export function endSlideDrag(state: EditorState, dropped: boolean): EditorState {
  const gesture = state.gesture;
  switch (gesture.kind) {
    case "draggingSlides": {
      const idle: EditorState = { ...state, gesture: { kind: "idle" } };
      if (!dropped || orderUnchanged(state, gesture.slideIds, gesture.dropAfter)) return idle;
      return queueEnvelope(idle, {
        commands: [{ kind: "moveSlides", slideIds: gesture.slideIds, after: gesture.dropAfter }],
        selectionAfter: { kind: "slides", slideIds: gesture.slideIds },
        mergeWithPrevious: false,
      });
    }
    case "idle":
    case "pressed":
    case "moving":
    case "resizing":
    case "rotating":
    case "movingLineEnd":
    case "marquee":
    case "creating":
    case "resizingTableLine":
    case "drawingMarking":
    case "panning":
      return state;
    default:
      return assertNever(gesture);
  }
}

/** Slide properties for the selected slides, or the current one. */
export function setSlideProperties(state: EditorState, patch: SlidePropertiesPatch): EditorState {
  const slideIds = selectedSlideIds(state);
  const targets = slideIds.length > 0 ? slideIds : state.currentSlideId === null ? [] : [state.currentSlideId];
  const commands: DocumentCommand[] = targets.map((slideId) => ({ kind: "setSlideProperties", slideId, patch }));
  return queueEnvelope(state, { commands, selectionAfter: state.selection, mergeWithPrevious: false });
}

/** Page Up / Page Down. */
export function goToSlide(state: EditorState, step: -1 | 1): EditorState {
  const index = state.currentSlideId === null ? -1 : findSlideIndex(state.document, state.currentSlideId);
  const target = state.document.slides[Math.max(0, Math.min(state.document.slides.length - 1, index + step))];
  if (target === undefined || target.id === state.currentSlideId) return state;
  return activateSlide(state, target.id);
}

/** Tab / Shift+Tab: the next or previous element in z-order at the selection's depth, wrapping. */
export function selectSibling(state: EditorState, direction: "next" | "previous"): EditorState {
  const slide = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
  if (slide === null) return state;
  const siblings: readonly ElementSnapshot[] = selectableElements(slide, state.enteredGroupId);
  if (siblings.length === 0) return state;
  const selected = selectedElements(state);
  const anchorId = selected?.elements.at(-1)?.id ?? null;
  const index = anchorId === null ? -1 : siblings.findIndex((element) => element.id === anchorId);
  const step = SIBLING_STEP[direction];
  const nextIndex = index < 0 ? (step > 0 ? 0 : siblings.length - 1) : (index + step + siblings.length) % siblings.length;
  const next = siblings[nextIndex];
  return next === undefined ? state : selectElements(state, [next.id]);
}

export function requestPresentation(state: EditorState, from: "beginning" | "currentSlide", withSpeakerView: boolean): EditorState {
  switch (state.embedding.kind) {
    case "addonDialog":
      // The view's handler opened the deck in a top-level tab instead (SPEC.md section 14).
      return state;
    case "webApplication":
      break;
    default:
      return assertNever(state.embedding);
  }
  const startSlideId = startingSlide(state, from);
  if (startSlideId === null) return state;
  return { ...state, presentation: { startSlideId, withSpeakerView }, gesture: { kind: "idle" }, ui: { ...state.ui, openMenu: null, contextMenu: null } };
}

export function endPresentation(state: EditorState, lastSlideId: SlideId | null): EditorState {
  const shown = lastSlideId !== null && findSlide(state.document, lastSlideId) !== null ? lastSlideId : state.currentSlideId;
  return { ...state, presentation: null, currentSlideId: shown };
}

const SIBLING_STEP: Readonly<Record<"next" | "previous", 1 | -1>> = { next: 1, previous: -1 };

function startingSlide(state: EditorState, from: "beginning" | "currentSlide"): SlideId | null {
  switch (from) {
    case "beginning":
      return (state.document.slides.find((slide) => !slide.skipped) ?? state.document.slides[0])?.id ?? null;
    case "currentSlide":
      return state.currentSlideId ?? state.document.slides[0]?.id ?? null;
    default:
      return assertNever(from);
  }
}

function duplicateSlides(state: EditorState, slideIds: readonly SlideId[]): EditorState {
  const originals = state.document.slides.filter((slide) => slideIds.includes(slide.id));
  const last = originals.at(-1);
  if (last === undefined) return state;
  const minter = createIdMinter(state.idSeed);
  // Duplicating a slide keeps its morph keys (contracts/document.ts `morphKey`).
  const copies = originals.map((slide) => reidentifySlide(slide, { minter, keepSlideId: () => false, keepElementId: () => false, keepMorphKeys: true }));
  const queued = queueEnvelope(
    { ...state, idSeed: minter.seed() },
    { commands: [{ kind: "insertSlides", slides: copies, after: last.id }], selectionAfter: { kind: "slides", slideIds: copies.map((copy) => copy.id) }, mergeWithPrevious: false },
  );
  return { ...queued, currentSlideId: copies[0]?.id ?? queued.currentSlideId };
}

function selectedSlideIds(state: EditorState): readonly SlideId[] {
  const selection = state.selection;
  switch (selection.kind) {
    case "slides":
      return selection.slideIds;
    case "none":
    case "elements":
    case "text":
    case "tableCells":
      return [];
    default:
      return assertNever(selection);
  }
}

function slidesForMode(
  options: Readonly<{ state: EditorState; previous: readonly SlideId[]; clicked: readonly SlideId[]; mode: "replace" | "toggle" | "extend" }>,
): readonly SlideId[] {
  switch (options.mode) {
    case "replace":
      return options.clicked;
    case "toggle": {
      const toggled = options.previous.filter((slideId) => !options.clicked.includes(slideId));
      const added = options.clicked.filter((slideId) => !options.previous.includes(slideId));
      return [...toggled, ...added];
    }
    case "extend": {
      const anchor = options.previous.at(-1) ?? options.state.currentSlideId;
      const target = options.clicked.at(-1);
      if (anchor === null || target === undefined) return options.clicked;
      const from = findSlideIndex(options.state.document, anchor);
      const to = findSlideIndex(options.state.document, target);
      if (from < 0 || to < 0) return options.clicked;
      const range = options.state.document.slides.slice(Math.min(from, to), Math.max(from, to) + 1).map((slide) => slide.id);
      return [...options.previous.filter((slideId) => !range.includes(slideId)), ...range];
    }
    default:
      return assertNever(options.mode);
  }
}

function orderUnchanged(state: EditorState, slideIds: readonly SlideId[], dropAfter: SlideId | null): boolean {
  const order = state.document.slides.map((slide) => slide.id);
  const remaining = order.filter((slideId) => !slideIds.includes(slideId));
  const insertAt = dropAfter === null ? 0 : remaining.indexOf(dropAfter) + 1;
  const moved = [...remaining.slice(0, insertAt), ...order.filter((slideId) => slideIds.includes(slideId)), ...remaining.slice(insertAt)];
  return moved.every((slideId, index) => order[index] === slideId);
}

function emptiedPlaceholder(element: ElementSnapshot): ElementSnapshot {
  switch (element.kind) {
    case "shape":
      return element.placeholder === null ? element : { ...element, text: EMPTY_TEXT_BODY };
    case "image":
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return element;
    default:
      return assertNever(element);
  }
}
