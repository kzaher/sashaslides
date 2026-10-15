// PAINT FORMAT (SPEC.md section 3, "Paint format"): the toolbar brush captures the selection's look --
// the element style that applies to its kind, the run style at the caret or first character, and the
// paragraph style there -- and the next click paints it onto another element as one envelope:
// `updateElements` (fields that do not apply to the target's kind are skipped by the model) plus
// whole-body text formatting. A double click on the brush keeps the tool (`sticky`).

import {
  assertNever,
  type CapturedFormat,
  type DocumentCommand,
  type EditorState,
  type ElementId,
  type ElementPatch,
  type ElementSnapshot,
  type TextTarget,
} from "../../contracts/index.ts";
import { findElement, findSlide, leavesOf } from "./document-lookup.ts";
import { optimisticText, queueEnvelope } from "./editor-queue.ts";
import { selectedElements, textSelectionOf } from "./editor-selection.ts";
import { flattenBody, paragraphStylesOverlapping, runStyleAt } from "./text-model.ts";

export function captureFormat(state: EditorState): CapturedFormat | null {
  const selected = selectedElements(state);
  const first = selected?.elements[0];
  if (selected === null || first === undefined) return null;
  const leaf = leavesOf(first)[0] ?? first;
  const textSelection = textSelectionOf(state.selection);
  if (textSelection !== null) {
    const items = optimisticText(state, textSelection.target);
    const index = Math.min(textSelection.anchor, textSelection.focus);
    return {
      element: elementPatchOf(leaf),
      run: items === null ? {} : runStyleAt(items, index + 1),
      paragraph: items === null ? {} : (paragraphStylesOverlapping({ items, index, length: 0 })[0] ?? {}),
    };
  }
  const items = textItemsOf(leaf);
  return {
    element: elementPatchOf(leaf),
    run: items === null ? {} : runStyleAt(items, 1),
    paragraph: items === null ? {} : (paragraphStylesOverlapping({ items, index: 0, length: 0 })[0] ?? {}),
  };
}

export function applyCapturedFormat(state: EditorState, elementId: ElementId, captured: CapturedFormat): EditorState {
  const slideId = state.currentSlideId;
  const slide = slideId === null ? null : findSlide(state.document, slideId);
  const element = slide === null ? null : findElement(slide, elementId);
  if (slideId === null || element === null) return state;
  const commands: DocumentCommand[] = [];
  if (Object.keys(captured.element).length > 0) {
    commands.push({ kind: "updateElements", slideId, elementIds: leavesOf(element).map((leaf) => leaf.id), patch: captured.element });
  }
  for (const leaf of leavesOf(element)) {
    if (textItemsOf(leaf) === null) continue;
    const target: TextTarget = { kind: "element", slideId, elementId: leaf.id };
    const items = optimisticText(state, target);
    if (items === null) continue;
    const operations = [
      ...(Object.keys(captured.run).length > 0 ? [{ kind: "formatRuns" as const, index: 0, length: items.length, patch: captured.run, clear: [] }] : []),
      ...(Object.keys(captured.paragraph).length > 0 ? [{ kind: "formatParagraphs" as const, index: 0, length: items.length, patch: captured.paragraph, clear: [] }] : []),
    ];
    if (operations.length > 0) commands.push({ kind: "editText", target, basedOnRevision: state.document.revision, operations });
  }
  return queueEnvelope(state, { commands, selectionAfter: { kind: "elements", slideId, elementIds: [elementId] }, mergeWithPrevious: false });
}

function elementPatchOf(element: ElementSnapshot): ElementPatch {
  switch (element.kind) {
    case "shape":
      return { fill: element.box.fill, border: element.box.border, cornerRadius: element.box.cornerRadius, shadow: element.box.shadow, opacity: element.box.opacity, textBox: element.textBox };
    case "image":
      return { border: element.box.border, cornerRadius: element.box.cornerRadius, shadow: element.box.shadow, opacity: element.box.opacity };
    case "line":
      return { stroke: element.stroke, startArrow: element.startArrow, endArrow: element.endArrow, opacity: element.opacity };
    case "table":
      return { opacity: element.opacity };
    case "group":
    case "unsupported":
      return {};
    default:
      return assertNever(element);
  }
}

function textItemsOf(element: ElementSnapshot): ReturnType<typeof flattenBody> | null {
  switch (element.kind) {
    case "shape":
      return flattenBody(element.text);
    case "image":
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}
