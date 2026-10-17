// THE EDITABLE CANVAS: the current slide on the calm ground, drawn by the shared renderer with the
// gesture preview applied and the inline text editor plugged in, under the selection overlay. It
// reports, the reducer decides (editor-events.ts header): every pointer event becomes a
// `canvasPointer*` event in slide units with what was hit, and nothing here decides whether a
// press is a click, a move or a marquee.
//
// Key decisions:
//
//  * POINTER POSITIONS ARE CONVERTED HERE, once: client pixels minus the slide frame's origin,
//    divided by the scale. The frame's origin is read at pointer down and kept for the gesture, so
//    a drag never forces a layout read per move.
//  * THE DRAG BUDGET IS MEASURABLE. With `measurePointerMoves`, each move is marked before its
//    dispatch and measured in the layout effect of the render it caused (event to reduce to render,
//    SPEC.md section 17); the end-to-end driver reads those measures.
//  * MEASURED LAYOUT IS DEDUPLICATED before it is dispatched, so a table that measures the same
//    rows on every render reports them once.
//  * THE ANIMATE TAB DRAWS HERE TOO: numbered badges on animated elements while the tab shows, and
//    its Preview over the slide frame (build-overlays.tsx).
//  * TEXT INSIDE THE EDITOR IS THE BROWSER'S. A press inside the inline editor is left to the
//    browser (caret placement, word selection), never reported as a canvas gesture.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type RefObject } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { ElementMeasurement, Modifiers, PointerButton, PointerSample, Tool } from "../../contracts/editor-state.ts";
import { gesturePreviewFrames } from "../../contracts/editor-state.ts";
import type { ArrangedThread } from "../../contracts/editor-system.ts";
import type { ElementId, SlideId } from "../../contracts/ids.ts";
import type { Selection, TextTarget } from "../../contracts/selection.ts";
import { textTargetKey } from "../../contracts/text-delta.ts";
import { useEditorSelector, useEditorServices, useViewPreferences, shallowEqual } from "../application/editor-services.tsx";
import { threadIsResolved } from "../chrome/comment-rail.tsx";
import { PEER_IS_AWAY, shownPeers, usePresenceNow } from "../chrome/presence.ts";
import type { EditableTextSlot, MeasurementReporter } from "../render/render-context.ts";
import { SlideRoot, useSlideRenderContext } from "../render/static-slide.tsx";
import { InlineTextEditor, TEXT_EDITOR_ATTRIBUTE } from "../text/inline-text-editor.tsx";
import { modifiersOf } from "../text/text-editor-handlers.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { applyFramePreview, hitTargetOf, tableCellTargetOf, type AttributeReader } from "./canvas-geometry.ts";
import { AnimationBadgeLayer, BuildPreviewLayer, animateTabShowing } from "./build-overlays.tsx";
import { CanvasOverlay, placementBox } from "./canvas-overlay.tsx";

/** Client pixels of calm ground kept around the slide. */
export const CANVAS_MARGIN = 40;
export const POINTER_MOVE_MARK = "sasha-pointer-move-start";
export const POINTER_MOVE_MEASURE = "sasha-pointer-move";

export const EditableCanvas = memo(function EditableCanvas(): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector(
    (state) => ({
      document: state.document,
      currentSlideId: state.currentSlideId,
      gesture: state.gesture,
      selection: state.selection,
      viewport: state.viewport,
      peers: state.peers,
      discussion: state.discussion,
      resolvedTextAnchors: state.resolvedTextAnchors,
      composer: state.chrome.composer,
      focusedThreadId: state.chrome.focusedThreadId,
      showResolvedThreads: state.chrome.showResolvedThreads,
      measured: state.measuredLayouts,
      tool: state.tool,
      animateTabShowing: animateTabShowing(state.chrome),
      buildPreview: state.chrome.buildPreview,
    }),
    shallowEqual,
  );
  const area = useRef<HTMLDivElement>(null);
  const slideFrame = useRef<HTMLDivElement>(null);
  const gestureOrigin = useRef<Readonly<{ left: number; top: number }> | null>(null);
  const pendingMoveMark = useRef(false);

  const slideIndex = view.document.slides.findIndex((slide) => slide.id === view.currentSlideId);
  const slide = view.document.slides[slideIndex] ?? null;
  const preview = gesturePreviewFrames(view.gesture);
  const previewSlide = useMemo(() => (slide === null ? null : applyFramePreview(slide, preview)), [slide, preview]);
  const scale = view.viewport.scale;
  const pageHeight = view.document.pageSize.height;
  const placement = slidePlacement({ containerWidth: view.viewport.containerSize.width, containerHeight: view.viewport.containerSize.height, scale, pageHeight });

  const measurement = useMeasurementReporter({ slideId: slide?.id ?? null, dispatch });
  const editableText = useEditableTextSlot(view.selection, slide?.id ?? null);
  const preferences = useViewPreferences();
  const presenceNow = usePresenceNow({ now: services.now, watching: view.peers.length > 0 });
  const peers = useMemo(() => shownPeers({ peers: view.peers, now: presenceNow }), [view.peers, presenceNow]);
  const shownPeerPresences = useMemo(() => peers.map((entry) => entry.peer), [peers]);
  const awayClientIds = useMemo(() => new Set(peers.flatMap((entry) => (PEER_IS_AWAY[entry.status] ? [entry.peer.clientId] : []))), [peers]);
  const pins = useMemo(() => pinsOnSlide({ arranged: services.arrangeThreads({ discussion: view.discussion, document: view.document, resolvedTextAnchors: view.resolvedTextAnchors }), slideId: slide?.id ?? null, showResolved: view.showResolvedThreads }), [services, view.discussion, view.document, view.resolvedTextAnchors, slide, view.showResolvedThreads]);
  const focusedThread = pins.find((pin) => pin.thread.id === view.focusedThreadId) ?? null;

  useLayoutEffect(() => {
    if (!pendingMoveMark.current) return;
    pendingMoveMark.current = false;
    performance.measure(POINTER_MOVE_MEASURE, POINTER_MOVE_MARK);
  });

  useViewportReporting({ area, dispatch });

  const sampleOf = useCallback(
    (event: Readonly<{ clientX: number; clientY: number }>, origin: Readonly<{ left: number; top: number }> | null): PointerSample | null => {
      const frameOrigin = origin ?? frameOriginOf(slideFrame.current);
      if (frameOrigin === null || scale <= 0) return null;
      return { slidePoint: { x: (event.clientX - frameOrigin.left) / scale, y: (event.clientY - frameOrigin.top) / scale }, clientPoint: { x: event.clientX, y: event.clientY } };
    },
    [scale],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (insideTextEditor(event.target)) return;
    const origin = frameOriginOf(slideFrame.current);
    const sample = sampleOf(event, origin);
    if (sample === null) return;
    gestureOrigin.current = origin;
    const button = pointerButtonOf(event.button);
    if (button === "primary") {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      area.current?.focus({ preventScroll: true });
    }
    const path = attributePath(event.target, event.currentTarget);
    const target = hitTargetOf({ path, slide: previewSlide, discussion: view.discussion });
    dispatch({ kind: "canvasPointerDown", sample, target, modifiers: modifiersOfPointer(event, services.primaryModifier), button, clickCount: Math.max(1, event.detail) });
    // A double click on a table cell types into that cell; the pointer down above has selected the table.
    const cell = event.button === 0 && event.detail >= 2 ? tableCellTargetOf({ path, slide: previewSlide }) : null;
    if (cell !== null) dispatch({ kind: "textEditingRequested", target: cell, at: "end" });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const captured = event.currentTarget.hasPointerCapture(event.pointerId);
    const sample = sampleOf(event, captured ? gestureOrigin.current : null);
    if (sample === null) return;
    if (services.measurePointerMoves) {
      performance.mark(POINTER_MOVE_MARK);
      pendingMoveMark.current = true;
    }
    dispatch({ kind: "canvasPointerMove", sample, modifiers: modifiersOfPointer(event, services.primaryModifier) });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (insideTextEditor(event.target) && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const sample = sampleOf(event, gestureOrigin.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gestureOrigin.current = null;
    if (sample === null) return;
    dispatch({ kind: "canvasPointerUp", sample, modifiers: modifiersOfPointer(event, services.primaryModifier) });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    const sample = sampleOf(event, null);
    void Promise.all(files.map((file) => services.readImageFile(file))).then((read) => {
      const chosen = read.filter((file): file is NonNullable<typeof file> => file !== null);
      if (chosen.length > 0) dispatch({ kind: "imageFilesChosen", files: chosen, at: sample?.slidePoint ?? null, destination: "newImage" });
    });
  };

  return (
    <div
      ref={area}
      className={VIEW_CLASS.canvasArea}
      tabIndex={0}
      aria-label="Slide canvas"
      data-tool={toolCursor(view.tool)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gestureOrigin.current = null;
        dispatch({ kind: "canvasPointerCancelled" });
      }}
      onPointerLeave={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) dispatch({ kind: "canvasPointerLeft" });
      }}
      onContextMenu={(event) => {
        if (insideTextEditor(event.target)) return;
        event.preventDefault();
        const target = hitTargetOf({ path: attributePath(event.target, event.currentTarget), slide: previewSlide, discussion: view.discussion });
        dispatch({ kind: "contextMenuOpened", at: { x: event.clientX, y: event.clientY }, scope: target.kind === "element" ? "element" : "canvas" });
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
      onScroll={(event) => dispatch({ kind: "scrolled", scroll: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop } })}
    >
      <div className={VIEW_CLASS.canvasStage} style={{ width: placement.contentWidth, height: placement.contentHeight }}>
        {previewSlide === null ? (
          <EmptyDeck />
        ) : (
          <div ref={slideFrame} className={VIEW_CLASS.slideFrame} style={{ left: placement.left, top: placement.top, width: 1280 * scale, height: pageHeight * scale }}>
            <CanvasSlide document={view.document} slide={previewSlide} slideNumber={slideIndex + 1} scale={scale} pageHeight={pageHeight} measurement={measurement} editableText={editableText} />
            <CanvasOverlay
              slide={previewSlide}
              scale={scale}
              selection={view.selection}
              gesture={view.gesture}
              measured={view.measured}
              peers={shownPeerPresences}
              pins={pins}
              composer={view.composer}
              focusedThread={focusedThread}
              showAnnotations={preferences.showAnnotations}
              pageSize={view.document.pageSize}
              awayClientIds={awayClientIds}
            />
            {view.animateTabShowing ? <AnimationBadgeLayer slide={previewSlide} scale={scale} /> : null}
            {view.buildPreview === null || view.buildPreview.slideId !== previewSlide.id ? null : (
              <BuildPreviewLayer document={view.document} slideId={view.buildPreview.slideId} generation={view.buildPreview.generation} width={1280 * scale} dispatch={dispatch} />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** Where the slide sits in the canvas: centred when it fits, scrollable with a margin when it does not. */
export function slidePlacement(options: Readonly<{ containerWidth: number; containerHeight: number; scale: number; pageHeight: number }>): Readonly<{ left: number; top: number; contentWidth: number; contentHeight: number }> {
  const width = 1280 * options.scale;
  const height = options.pageHeight * options.scale;
  const contentWidth = Math.max(options.containerWidth, width + CANVAS_MARGIN * 2);
  const contentHeight = Math.max(options.containerHeight, height + CANVAS_MARGIN * 2);
  return { left: (contentWidth - width) / 2, top: (contentHeight - height) / 2, contentWidth, contentHeight };
}

/** The slide itself, scaled by one transform; memoised so the overlay can change without it. */
const CanvasSlide = memo(function CanvasSlide(properties: Readonly<{
  document: DocumentSnapshot;
  slide: NonNullable<ReturnType<typeof applyFramePreview>>;
  slideNumber: number;
  scale: number;
  pageHeight: number;
  measurement: MeasurementReporter;
  editableText: EditableTextSlot | null;
}>): ReactElement {
  const services = useEditorServices();
  const context = useSlideRenderContext({
    document: properties.document,
    slide: properties.slide,
    slideNumber: properties.slideNumber,
    assetAddress: services.assetAddress,
    measurement: properties.measurement,
    editableText: properties.editableText,
  });
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 1280, height: properties.pageHeight, transform: `scale(${properties.scale})`, transformOrigin: "0 0" }}>
      <SlideRoot slide={properties.slide} document={properties.document} context={context} />
    </div>
  );
});

function EmptyDeck(): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  return (
    <div className={VIEW_CLASS.emptyState}>
      <div className="sasha-card" style={{ textAlign: "center" }}>
        <p>This deck has no slides yet.</p>
        <button type="button" className="sasha-pill-primary" onClick={() => dispatch({ kind: "newSlideRequested", layoutId: null })}>
          New slide
        </button>
      </div>
    </div>
  );
}

/** Reports measured layout once per change (see the header). */
function useMeasurementReporter(options: Readonly<{ slideId: SlideId | null; dispatch: (event: EditorEvent) => void }>): MeasurementReporter {
  const reported = useRef(new Map<ElementId, string>());
  const { slideId, dispatch } = options;
  return useMemo<MeasurementReporter>(() => {
    reported.current = new Map();
    return (report) => {
      if (slideId === null) return;
      const signature = measurementSignature(report.measurement);
      if (reported.current.get(report.elementId) === signature) return;
      reported.current.set(report.elementId, signature);
      dispatch({ kind: "layoutMeasured", slideId, elementId: report.elementId, measurement: report.measurement });
    };
  }, [slideId, dispatch]);
}

function measurementSignature(measurement: ElementMeasurement): string {
  switch (measurement.kind) {
    case "table":
      return `table:${measurement.rowHeights.map((row) => `${row.rowId}=${Math.round(row.height * 2) / 2}`).join(",")}`;
    case "text":
      return `text:${Math.round(measurement.contentHeight * 2) / 2}`;
    default:
      return assertNever(measurement);
  }
}

/** The inline editor slot for the body being edited on this slide; stable per body (render-context.ts). */
function useEditableTextSlot(selection: Selection, slideId: SlideId | null): EditableTextSlot | null {
  const target = canvasTextTarget(selection, slideId);
  const key = target === null ? null : textTargetKey(target);
  const targetRef = useRef<TextTarget | null>(target);
  targetRef.current = target;
  return useMemo(() => {
    const current = targetRef.current;
    if (key === null || current === null) return null;
    return { target: current, render: (properties) => <InlineTextEditor {...properties} target={current} /> };
  }, [key]);
}

function canvasTextTarget(selection: Selection, slideId: SlideId | null): TextTarget | null {
  switch (selection.kind) {
    case "text":
      switch (selection.target.kind) {
        case "element":
        case "tableCell":
          return selection.target.slideId === slideId ? selection.target : null;
        case "speakerNotes":
          return null;
        default:
          return assertNever(selection.target);
      }
    case "none":
    case "slides":
    case "elements":
    case "tableCells":
      return null;
    default:
      return assertNever(selection);
  }
}

function pinsOnSlide(options: Readonly<{ arranged: readonly ArrangedThread[]; slideId: SlideId | null; showResolved: boolean }>): readonly ArrangedThread[] {
  return options.arranged.filter((arranged) => {
    if (!options.showResolved && threadIsResolved(arranged.thread)) return false;
    const placement = arranged.placement;
    switch (placement.kind) {
      case "onElement":
      case "elementRemoved":
      case "onSlide":
        return placement.slideId === options.slideId && placementBox(arranged) !== null;
      case "slideRemoved":
        return false;
      default:
        return assertNever(placement);
    }
  });
}

/** Reports the canvas area's size whenever it changes (the reducer derives the fit scale from it). */
function useViewportReporting(options: Readonly<{ area: RefObject<HTMLDivElement | null>; dispatch: (event: EditorEvent) => void }>): void {
  const { area, dispatch } = options;
  useEffect(() => {
    const element = area.current;
    if (element === null || typeof ResizeObserver === "undefined") return undefined;
    let last = "";
    const report = (): void => {
      const size = { width: Math.round(element.clientWidth), height: Math.round(element.clientHeight) };
      const signature = `${size.width}x${size.height}`;
      if (signature === last) return;
      last = signature;
      dispatch({ kind: "viewportResized", size });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, [area, dispatch]);
}

function frameOriginOf(element: HTMLElement | null): Readonly<{ left: number; top: number }> | null {
  if (element === null) return null;
  const rectangle = element.getBoundingClientRect();
  return { left: rectangle.left, top: rectangle.top };
}

/** The event target's ancestors up to the canvas area, as attribute readers for the hit test. */
function attributePath(target: EventTarget, boundary: Element): readonly AttributeReader[] {
  const path: AttributeReader[] = [];
  let node: Element | null = target instanceof Element ? target : null;
  while (node !== null && node !== boundary) {
    const current = node;
    path.push((name) => current.getAttribute(name));
    node = node.parentElement;
  }
  return path;
}

function insideTextEditor(target: EventTarget): boolean {
  return target instanceof Element && target.closest(`[${TEXT_EDITOR_ATTRIBUTE}]`) !== null;
}

function pointerButtonOf(button: number): PointerButton {
  if (button === 2) return "secondary";
  if (button === 1) return "middle";
  return "primary";
}

export function modifiersOfPointer(event: Readonly<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }>, primaryModifier: "control" | "meta"): Modifiers {
  return modifiersOf({ event, primaryModifier });
}

function toolCursor(tool: Tool): "select" | "insert" | "comment" {
  switch (tool.kind) {
    case "select":
    case "pan":
    case "formatPainter":
      return "select";
    case "shape":
    case "line":
    case "table":
    case "annotate":
      return "insert";
    case "comment":
      return "comment";
    default:
      return assertNever(tool);
  }
}
