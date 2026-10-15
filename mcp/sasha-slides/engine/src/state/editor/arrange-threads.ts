// WHERE EACH COMMENT THREAD SHOWS (contracts/discussion.ts, "anchors degrade, they do not
// disappear"). A pure selector the comment rail and the canvas pins both read:
//
//  * on its element, with the region (fractions of the element's frame) mapped into the frame as it
//    is NOW -- so moving or resizing the element carries the comment with it;
//  * at `elementFrameAtCreation`, marked "element removed", once the element is gone;
//  * on its slide, for a slide-level comment;
//  * under "on deleted slides" once the slide is gone.
//
// A null region pins to the reference box's top-right corner (a zero-size box there). Boxes are the
// element's unrotated frame: the view draws the pin in the element's rotated space. Threads come out
// in slide order, then creation time.

import {
  assertNever,
  type ArrangedThread,
  type ArrangeThreads,
  type Box,
  type CommentThread,
  type FractionalRegion,
  type TextRange,
  type ThreadPlacement,
} from "../../contracts/index.ts";
import { findElement, findSlide, findSlideIndex, slideBox } from "./document-lookup.ts";

export const arrangeThreads: ArrangeThreads = (input) => {
  const placed = input.discussion.threads.map((thread): ArrangedThread & Readonly<{ order: number }> => {
    const placement = placementOf(thread, input);
    const slideIndex = findSlideIndex(input.document, thread.anchor.slideId);
    return { thread, placement, order: slideIndex < 0 ? Number.POSITIVE_INFINITY : slideIndex };
  });
  return placed
    .sort((first, second) => first.order - second.order || first.thread.createdAt - second.thread.createdAt || compareText(first.thread.id, second.thread.id))
    .map(({ thread, placement }) => ({ thread, placement }));
};

function placementOf(thread: CommentThread, input: Parameters<ArrangeThreads>[0]): ThreadPlacement {
  const anchor = thread.anchor;
  const slide = findSlide(input.document, anchor.slideId);
  if (slide === null) return { kind: "slideRemoved" };
  const target = anchor.target;
  switch (target.kind) {
    case "slide":
      return { kind: "onSlide", slideId: slide.id, box: regionIn(slideBox(input.document), anchor.region) };
    case "element":
    case "text": {
      const element = findElement(slide, target.elementId);
      if (element === null) {
        const fallback = anchor.elementFrameAtCreation;
        if (fallback === null) return { kind: "onSlide", slideId: slide.id, box: regionIn(slideBox(input.document), null) };
        return { kind: "elementRemoved", slideId: slide.id, box: regionIn(fallback, anchor.region) };
      }
      const frame: Box = { x: element.frame.x, y: element.frame.y, width: element.frame.width, height: element.frame.height };
      return { kind: "onElement", slideId: slide.id, elementId: element.id, box: regionIn(frame, anchor.region), textRange: textRangeOf(thread, input) };
    }
    default:
      return assertNever(target);
  }
}

function textRangeOf(thread: CommentThread, input: Parameters<ArrangeThreads>[0]): TextRange | null {
  switch (thread.anchor.target.kind) {
    case "text":
      return input.resolvedTextAnchors.get(thread.id) ?? null;
    case "slide":
    case "element":
      return null;
    default:
      return assertNever(thread.anchor.target);
  }
}

/** A fractional region placed in a box; null pins to the box's top-right corner. */
function regionIn(reference: Box, region: FractionalRegion | null): Box {
  if (region === null) return { x: reference.x + reference.width, y: reference.y, width: 0, height: 0 };
  return {
    x: reference.x + region.x * reference.width,
    y: reference.y + region.y * reference.height,
    width: region.width * reference.width,
    height: region.height * reference.height,
  };
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
