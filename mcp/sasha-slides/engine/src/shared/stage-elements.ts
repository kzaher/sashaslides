// THE LEAVES OF A SLIDE AS A TRANSITION SEES THEM (contracts/render.ts `StageElementRecord`). The
// sandbox's `renderSlideMarkup` (view/render/slide-markup.tsx) sends these records with the markup,
// and the in-page presenter host derives the same records from the snapshot it already holds instead
// of rendering every slide to a markup string just to read its element list back. Groups are
// wrappers and never animated themselves, so only leaves are listed, in z-order back to front, each
// with its unrotated frame (what a morph interpolates), its rotated bounds and its enclosing groups,
// outermost first.

import { assertNever } from "../contracts/assert-never.ts";
import type { ElementSnapshot, SlideSnapshot } from "../contracts/document.ts";
import { rotatedBounds } from "../contracts/geometry.ts";
import type { ElementId } from "../contracts/ids.ts";
import type { StageElementRecord } from "../contracts/render.ts";

/** Every leaf of the slide, back to front, with its unrotated frame, rotated bounds and enclosing groups. */
export function stageElementRecordsOf(slide: SlideSnapshot): readonly StageElementRecord[] {
  const records: StageElementRecord[] = [];
  const visit = (element: ElementSnapshot, groupPath: readonly ElementId[]): void => {
    switch (element.kind) {
      case "group":
        for (const child of element.children) visit(child, [...groupPath, element.id]);
        return;
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        records.push({ elementId: element.id, morphKey: element.morphKey, kind: element.kind, frame: element.frame, bounds: rotatedBounds(element.frame), groupPath });
        return;
      default:
        assertNever(element);
    }
  };
  for (const element of slide.elements) visit(element, []);
  return records;
}
