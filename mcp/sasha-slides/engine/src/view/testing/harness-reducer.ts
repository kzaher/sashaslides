// THE CHROME HARNESS'S STAND-IN REDUCER: just enough of the editor's behaviour to drive the view in a
// real browser before -- and independently of -- the state module: open and close menus, dialogs and
// panels, choose tabs and tools, select an element by clicking it, drag it (with a live preview and
// a commit on release), double click into its text, and keep measured layout. It exists for the
// end-to-end screenshots and the drag budget, which measure the VIEW's cost; it is not the editor's
// reducer and makes no claim to be (that is src/state/).

import type { FrameUpdate } from "../../contracts/commands.ts";
import type { ElementSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorState, Gesture } from "../../contracts/editor-state.ts";
import type { ElementId } from "../../contracts/ids.ts";
import { findInTree } from "../../shared/element-tree.ts";

/** Client pixels a press must travel before it is a drag (SPEC.md section 7). */
const DRAG_THRESHOLD = 3;

export function harnessReduce(state: EditorState, event: EditorEvent): EditorState {
  switch (event.kind) {
    case "menuOpened":
      return withChrome(state, { openMenu: event.menu, contextMenu: null });
    case "menuClosed":
      return withChrome(state, { openMenu: null });
    case "contextMenuOpened":
      return withChrome(state, { contextMenu: { at: event.at, scope: event.scope }, openMenu: null });
    case "contextMenuClosed":
      return withChrome(state, { contextMenu: null });
    case "dialogOpened":
      return withChrome(state, { dialog: event.dialog, openMenu: null, contextMenu: null });
    case "dialogClosed":
      return withChrome(state, { dialog: { kind: "none" } });
    case "propertiesTabChosen":
      return withChrome(state, { propertiesTab: event.tab, propertiesPanelOpen: true, commentsOpen: false });
    case "panelToggled":
      return togglePanel(state, event.panel);
    case "toolChosen":
      return { ...state, tool: event.tool };
    case "slideActivated":
      return { ...state, currentSlideId: event.slideId, selection: { kind: "none" } };
    case "threadFocused":
      return withChrome(state, { focusedThreadId: event.threadId });
    case "resolvedThreadsToggled":
      return withChrome(state, { showResolvedThreads: !state.chrome.showResolvedThreads });
    case "noticeDismissed":
      return { ...state, notices: state.notices.filter((notice) => notice.id !== event.noticeId) };
    case "viewportResized":
      return { ...state, viewport: { ...state.viewport, containerSize: event.size, scale: fitScale(state, event.size) } };
    case "zoomRequested":
      return { ...state, viewport: { ...state.viewport, zoom: event.zoom, scale: event.zoom.kind === "fit" ? fitScale(state, state.viewport.containerSize) : event.zoom.scale } };
    case "layoutMeasured": {
      const measured = new Map(state.measuredLayouts);
      measured.set(event.elementId, event.measurement);
      return { ...state, measuredLayouts: measured };
    }
    case "canvasPointerDown":
      return pointerDown(state, event);
    case "canvasPointerMove":
      return pointerMove(state, event);
    case "canvasPointerUp":
      return pointerUp(state);
    case "canvasPointerCancelled":
      return { ...state, gesture: { kind: "idle" } };
    case "textEditingEnded":
      return state.selection.kind === "text" && state.selection.target.kind === "element"
        ? { ...state, selection: { kind: "elements", slideId: state.selection.target.slideId, elementIds: [state.selection.target.elementId] } }
        : state;
    case "textSelectionChanged":
      return state.selection.kind === "text" ? { ...state, selection: { ...state.selection, anchor: event.anchor, focus: event.focus } } : state;
    case "presentRequested":
      return state.currentSlideId === null ? state : { ...state, presentation: { startSlideId: state.currentSlideId, withSpeakerView: event.withSpeakerView } };
    case "presentationEnded":
      return { ...state, presentation: null };
    default:
      return state;
  }
}

function withChrome(state: EditorState, patch: Partial<EditorState["chrome"]>): EditorState {
  return { ...state, chrome: { ...state.chrome, ...patch } };
}

function togglePanel(state: EditorState, panel: "properties" | "filmstrip" | "speakerNotes" | "comments"): EditorState {
  switch (panel) {
    case "properties":
      return withChrome(state, { propertiesPanelOpen: !state.chrome.propertiesPanelOpen, commentsOpen: false });
    case "filmstrip":
      return withChrome(state, { filmstripOpen: !state.chrome.filmstripOpen });
    case "speakerNotes":
      return withChrome(state, { speakerNotesOpen: !state.chrome.speakerNotesOpen });
    case "comments":
      return withChrome(state, { commentsOpen: !state.chrome.commentsOpen });
    default:
      return state;
  }
}

function fitScale(state: EditorState, size: Readonly<{ width: number; height: number }>): number {
  const margin = 80;
  return Math.max(0.1, Math.min((size.width - margin) / 1280, (size.height - margin) / state.document.pageSize.height));
}

function pointerDown(state: EditorState, event: Extract<EditorEvent, { kind: "canvasPointerDown" }>): EditorState {
  const slide = currentSlide(state);
  if (slide === null) return state;
  const pressed: Gesture = { kind: "pressed", origin: event.sample, target: event.target, modifiers: event.modifiers };
  switch (event.target.kind) {
    case "element": {
      const elementId = event.target.elementPath[0];
      if (elementId === undefined) return state;
      const element = findInTree(slide.elements, elementId);
      if (event.clickCount >= 2 && element !== null && element.kind === "shape") {
        return { ...state, gesture: { kind: "idle" }, selection: { kind: "text", target: { kind: "element", slideId: slide.id, elementId }, anchor: 0, focus: 0 } };
      }
      if (state.selection.kind === "text" && state.selection.target.kind === "element" && state.selection.target.elementId === elementId) return state;
      return { ...state, gesture: pressed, selection: { kind: "elements", slideId: slide.id, elementIds: [elementId] }, chrome: { ...state.chrome, contextMenu: null, openMenu: null } };
    }
    case "resizeHandle":
    case "rotationHandle":
    case "lineEnd":
    case "tableColumnBoundary":
    case "tableRowBoundary":
      return { ...state, gesture: pressed };
    case "commentPin":
      return withChrome({ ...state, gesture: { kind: "idle" } }, { focusedThreadId: event.target.threadId, commentsOpen: true });
    case "slideBackground":
    case "outside":
      return { ...state, gesture: pressed, selection: { kind: "none" }, chrome: { ...state.chrome, contextMenu: null, openMenu: null } };
    default:
      return state;
  }
}

function pointerMove(state: EditorState, event: Extract<EditorEvent, { kind: "canvasPointerMove" }>): EditorState {
  const gesture = state.gesture;
  const slide = currentSlide(state);
  if (slide === null) return state;
  switch (gesture.kind) {
    case "pressed": {
      const travelled = Math.hypot(event.sample.clientPoint.x - gesture.origin.clientPoint.x, event.sample.clientPoint.y - gesture.origin.clientPoint.y);
      if (travelled < DRAG_THRESHOLD || gesture.target.kind !== "element" || state.selection.kind !== "elements") return state;
      const startFrames = state.selection.elementIds.flatMap((id) => boxUpdates(findInTree(slide.elements, id)));
      return { ...state, gesture: { kind: "moving", origin: gesture.origin, current: event.sample, startFrames, preview: translated(startFrames, gesture.origin, event.sample), guides: [] } };
    }
    case "moving":
      return { ...state, gesture: { ...gesture, current: event.sample, preview: translated(gesture.startFrames, gesture.origin, event.sample) } };
    default:
      return state;
  }
}

function pointerUp(state: EditorState): EditorState {
  const gesture = state.gesture;
  if (gesture.kind !== "moving") return { ...state, gesture: { kind: "idle" } };
  const slide = currentSlide(state);
  if (slide === null) return { ...state, gesture: { kind: "idle" } };
  const updates = new Map<ElementId, FrameUpdate>(gesture.preview.map((update) => [update.elementId, update]));
  const moved: SlideSnapshot = { ...slide, elements: slide.elements.map((element) => committed(element, updates)) };
  return {
    ...state,
    gesture: { kind: "idle" },
    document: { ...state.document, revision: state.document.revision + 1, slides: state.document.slides.map((candidate) => (candidate.id === slide.id ? moved : candidate)) },
  };
}

function committed(element: ElementSnapshot, updates: ReadonlyMap<ElementId, FrameUpdate>): ElementSnapshot {
  const update = updates.get(element.id);
  if (update === undefined || update.kind !== "box") return element;
  switch (element.kind) {
    case "shape":
    case "image":
    case "table":
      return { ...element, frame: update.frame };
    default:
      return element;
  }
}

function boxUpdates(element: ElementSnapshot | null): readonly FrameUpdate[] {
  if (element === null) return [];
  switch (element.kind) {
    case "shape":
    case "image":
    case "table":
      return [{ kind: "box", elementId: element.id, frame: element.frame }];
    default:
      return [];
  }
}

function translated(frames: readonly FrameUpdate[], origin: Readonly<{ slidePoint: Readonly<{ x: number; y: number }> }>, current: Readonly<{ slidePoint: Readonly<{ x: number; y: number }> }>): readonly FrameUpdate[] {
  const deltaX = current.slidePoint.x - origin.slidePoint.x;
  const deltaY = current.slidePoint.y - origin.slidePoint.y;
  return frames.map((update) => (update.kind === "box" ? { ...update, frame: { ...update.frame, x: update.frame.x + deltaX, y: update.frame.y + deltaY } } : update));
}

function currentSlide(state: EditorState): SlideSnapshot | null {
  return state.document.slides.find((slide) => slide.id === state.currentSlideId) ?? null;
}
