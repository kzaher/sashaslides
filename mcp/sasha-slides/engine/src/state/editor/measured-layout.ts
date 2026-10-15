// MEASURED LAYOUT (SPEC.md section 7): what the document cannot know without rendering.
//
//  * Table rows grow with their text, so the visible height is not the stored one. The view reports
//    row heights; geometry uses them (document-lookup.ts `measuredFrame`) and nothing is written.
//  * A text box that grows with its text (`autofit: "resizeShape"`) reports the height its text
//    needs. Only the editor TYPING in it writes the new height -- as `setFrames` with
//    `mergeWithPrevious`, so the growth joins the typing undo step -- and only when it differs from
//    the frame by more than half a unit. Two collaborators therefore never fight over a box's height.
//    The box grows downward in its own axes: its top edge stays where it is even when rotated.

import {
  assertNever,
  frameCentre,
  rotatePoint,
  type EditorState,
  type ElementId,
  type ElementMeasurement,
  type Frame,
  type SlideId,
} from "../../contracts/index.ts";
import { commandOfKind } from "./command-kinds.ts";
import { findElement, findSlide } from "./document-lookup.ts";
import { queueEnvelope } from "./editor-queue.ts";
import { textSelectionOf } from "./editor-selection.ts";
import { sameValue } from "./text-model.ts";

/** A measured height closer than this to the frame's leaves the frame alone, slide units. */
export const TEXT_GROWTH_TOLERANCE_UNITS = 0.5;

export function reduceLayoutMeasured(state: EditorState, slideId: SlideId, elementId: ElementId, measurement: ElementMeasurement): EditorState {
  const previous = state.measuredLayouts.get(elementId);
  const recorded: EditorState =
    previous !== undefined && sameValue(previous, measurement) ? state : { ...state, measuredLayouts: new Map([...state.measuredLayouts, [elementId, measurement]]) };
  switch (measurement.kind) {
    case "table":
      return recorded;
    case "text":
      return growTextBox(recorded, slideId, elementId, measurement.contentHeight);
    default:
      return assertNever(measurement);
  }
}

function growTextBox(state: EditorState, slideId: SlideId, elementId: ElementId, contentHeight: number): EditorState {
  if (!typingIn(state, slideId, elementId)) return state;
  const slide = findSlide(state.document, slideId);
  const element = slide === null ? null : findElement(slide, elementId);
  if (element === null) return state;
  switch (element.kind) {
    case "shape": {
      if (!growsWithText(element.textBox.autofit)) return state;
      const frame = latestQueuedFrame(state, elementId) ?? element.frame;
      const height = Math.max(1, contentHeight);
      if (Math.abs(height - frame.height) <= TEXT_GROWTH_TOLERANCE_UNITS) return state;
      return queueEnvelope(state, {
        commands: [{ kind: "setFrames", slideId, frames: [{ kind: "box", elementId, frame: withHeightKeepingTop(frame, height) }] }],
        selectionAfter: state.selection,
        mergeWithPrevious: true,
      });
    }
    case "image":
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return state;
    default:
      return assertNever(element);
  }
}

/** True when THIS editor is typing in the element (see the header). */
function typingIn(state: EditorState, slideId: SlideId, elementId: ElementId): boolean {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return false;
  switch (selection.target.kind) {
    case "element":
      return selection.target.slideId === slideId && selection.target.elementId === elementId;
    case "tableCell":
    case "speakerNotes":
      return false;
    default:
      return assertNever(selection.target);
  }
}

function growsWithText(autofit: "none" | "shrinkText" | "resizeShape"): boolean {
  switch (autofit) {
    case "resizeShape":
      return true;
    case "none":
    case "shrinkText":
      return false;
    default:
      return assertNever(autofit);
  }
}

/** The frame a still-queued growth already asked for, so one measurement is not queued twice. */
function latestQueuedFrame(state: EditorState, elementId: ElementId): Frame | null {
  let latest: Frame | null = null;
  for (const edit of state.pendingEdits) {
    switch (edit.kind) {
      case "undo":
      case "redo":
        continue;
      case "apply":
        for (const command of edit.envelope.commands) {
          const setFrames = commandOfKind(command, "setFrames");
          if (setFrames === null) continue;
          for (const update of setFrames.frames) {
            switch (update.kind) {
              case "box":
                if (update.elementId === elementId) latest = update.frame;
                break;
              case "line":
              case "groupRotation":
                break;
              default:
                assertNever(update);
            }
          }
        }
        continue;
      default:
        assertNever(edit);
    }
  }
  return latest;
}

function withHeightKeepingTop(frame: Frame, height: number): Frame {
  const centre = frameCentre(frame);
  const newCentre = rotatePoint({ point: { x: centre.x, y: centre.y + (height - frame.height) / 2 }, centre, degrees: frame.rotation });
  return { ...frame, x: newCentre.x - frame.width / 2, y: newCentre.y - height / 2, height };
}
