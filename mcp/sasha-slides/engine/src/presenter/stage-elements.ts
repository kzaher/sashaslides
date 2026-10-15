// THE LEAVES OF A SLIDE AS A TRANSITION SEES THEM, from the document snapshot. The runner receives
// these records from `renderSlideMarkup`; the in-page host derives the same records here, from the
// snapshot it already holds, instead of rendering every slide to a markup string just to read its
// element list back. Groups are wrappers (render.ts), so only leaves are listed, in z-order back to
// front, each with its enclosing groups.

import { assertNever } from "../contracts/assert-never.ts";
import type { ElementSnapshot, SlideSnapshot } from "../contracts/document.ts";
import { rotatedBounds } from "../contracts/geometry.ts";
import type { ElementId } from "../contracts/ids.ts";
import type { StageElementRecord } from "../contracts/render.ts";

export function stageElementRecordsOf(slide: SlideSnapshot): readonly StageElementRecord[] {
  const records: StageElementRecord[] = [];
  appendLeaves({ elements: slide.elements, groupPath: [], records });
  return records;
}

function appendLeaves(options: Readonly<{ elements: readonly ElementSnapshot[]; groupPath: readonly ElementId[]; records: StageElementRecord[] }>): void {
  for (const element of options.elements) {
    switch (element.kind) {
      case "group":
        appendLeaves({ elements: element.children, groupPath: [...options.groupPath, element.id], records: options.records });
        break;
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        options.records.push({
          elementId: element.id,
          morphKey: element.morphKey,
          kind: element.kind,
          frame: element.frame,
          bounds: rotatedBounds(element.frame),
          groupPath: options.groupPath,
        });
        break;
      default:
        assertNever(element);
    }
  }
}
