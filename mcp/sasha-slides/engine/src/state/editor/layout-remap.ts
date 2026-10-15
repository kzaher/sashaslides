// CHANGING A SLIDE'S LAYOUT (contracts/document.ts `LayoutSnapshot`): milestone 1 copies layouts into
// slides, so a layout change is computed here, as ONE envelope from the pure `remapSlideToLayout`:
//
//  * a slide placeholder matched by (role, index) keeps its text and takes the layout's frame;
//  * an unmatched slide placeholder stays as it is (its text is the user's);
//  * a layout placeholder with no match is added, empty, with fresh ids.
//
// Matching by role AND index is what Slides does: a two-column layout's second body (index 1) never
// swallows the first body's text.

import {
  assertNever,
  EMPTY_TEXT_BODY,
  type DocumentCommand,
  type EditorState,
  type ElementSnapshot,
  type FrameUpdate,
  type LayoutId,
  type LayoutSnapshot,
  type PlaceholderReference,
  type SlideSnapshot,
} from "../../contracts/index.ts";
import { findSlide } from "./document-lookup.ts";
import { queueEnvelope } from "./editor-queue.ts";
import { reidentifyElement } from "./element-factory.ts";
import { createIdMinter, type IdMinter } from "./id-minter.ts";

export function reduceSlideLayoutChosen(state: EditorState, layoutId: LayoutId): EditorState {
  const slideId = state.currentSlideId;
  const slide = slideId === null ? null : findSlide(state.document, slideId);
  const layout = state.document.layouts.find((candidate) => candidate.id === layoutId);
  if (slide === null || layout === undefined) return state;
  const minter = createIdMinter(state.idSeed);
  const commands = remapSlideToLayout({ slide, layout, minter });
  return queueEnvelope({ ...state, idSeed: minter.seed() }, { commands, selectionAfter: state.selection, mergeWithPrevious: false });
}

/** The commands that move `slide` onto `layout` (see the header). Pure; ids come from `minter`. */
export function remapSlideToLayout(options: Readonly<{ slide: SlideSnapshot; layout: LayoutSnapshot; minter: IdMinter }>): readonly DocumentCommand[] {
  const slideId = options.slide.id;
  const slidePlaceholders = options.slide.elements.filter((element) => element.placeholder !== null);
  const frames: FrameUpdate[] = [];
  const added: ElementSnapshot[] = [];
  for (const layoutElement of options.layout.elements) {
    const reference = layoutElement.placeholder;
    if (reference === null) continue;
    const match = slidePlaceholders.find((element) => element.placeholder !== null && samePlaceholder(element.placeholder, reference));
    if (match === undefined) {
      added.push(emptied(reidentifyElement(layoutElement, { minter: options.minter, keepElementId: () => false, keepMorphKeys: false }, null)));
      continue;
    }
    const update = frameUpdateTaking(match, layoutElement);
    if (update !== null) frames.push(update);
  }
  const commands: DocumentCommand[] = [{ kind: "setSlideProperties", slideId, patch: { layoutId: options.layout.id } }];
  if (frames.length > 0) commands.push({ kind: "setFrames", slideId, frames });
  if (added.length > 0) commands.push({ kind: "insertElements", slideId, elements: added, placement: { kind: "back" } });
  return commands;
}

function samePlaceholder(first: PlaceholderReference, second: PlaceholderReference): boolean {
  return first.role === second.role && first.index === second.index;
}

/** The matched placeholder at the layout's frame; text and style untouched. */
function frameUpdateTaking(element: ElementSnapshot, layoutElement: ElementSnapshot): FrameUpdate | null {
  switch (element.kind) {
    case "shape":
    case "image":
    case "table":
      return { kind: "box", elementId: element.id, frame: layoutElement.frame };
    case "line":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

/** A layout placeholder copied into a slide starts without text. */
function emptied(element: ElementSnapshot): ElementSnapshot {
  switch (element.kind) {
    case "shape":
      return { ...element, text: EMPTY_TEXT_BODY };
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
