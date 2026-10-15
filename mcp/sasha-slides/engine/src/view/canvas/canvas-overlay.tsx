// THE CANVAS OVERLAY: everything drawn over the slide that is not slide content -- selection outlines
// and handles, snapping guides, the marquee and the box of an element being created, collaborators'
// cursors and selections, comment pins and the markings of the comment being written. It lives in
// CLIENT PIXELS above the scaled slide, so a handle is 9 pixels at every zoom, and it reads only the
// Tidepool custom properties (`--sasha-selection`, `--sasha-handle-fill`, the peer colours), so the
// selection stays visible on any slide colour (SPEC.md section 2).
//
// Only handles, pins and boundary strips take pointer events; every outline lets the pointer
// through to the element under it.

import { memo, type CSSProperties, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ArrangedThread } from "../../contracts/editor-system.ts";
import type { CommentComposer, Gesture } from "../../contracts/editor-state.ts";
import { marqueeBox } from "../../contracts/editor-state.ts";
import type { Marking } from "../../contracts/discussion.ts";
import type { ElementSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { Box, Frame, FractionalPoint, Point } from "../../contracts/geometry.ts";
import type { ElementId } from "../../contracts/ids.ts";
import type { ElementMeasurement } from "../../contracts/editor-state.ts";
import type { PeerPresence } from "../../contracts/presence.ts";
import type { Selection } from "../../contracts/selection.ts";
import { TIDEPOOL_TOKENS } from "../../theme/tidepool-theme.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import {
  COMMENT_PIN_ATTRIBUTE,
  HANDLE_ATTRIBUTE,
  HANDLE_ELEMENT_ATTRIBUTE,
  LINE_END_ATTRIBUTE,
  RESIZE_HANDLES,
  ROTATION_HANDLE_ATTRIBUTE,
  TABLE_COLUMN_BOUNDARY_ATTRIBUTE,
  TABLE_ROW_BOUNDARY_ATTRIBUTE,
  findElement,
  handleFraction,
  selectionOutline,
  tableBoundaries,
} from "./canvas-geometry.ts";

export type CanvasOverlayProperties = Readonly<{
  slide: SlideSnapshot;
  scale: number;
  selection: Selection;
  gesture: Gesture;
  measured: ReadonlyMap<ElementId, ElementMeasurement>;
  peers: readonly PeerPresence[];
  pins: readonly ArrangedThread[];
  composer: CommentComposer;
  focusedThread: ArrangedThread | null;
}>;

export const CanvasOverlay = memo(function CanvasOverlay(properties: CanvasOverlayProperties): ReactElement {
  const outline = selectionOutline({ slide: properties.slide, selection: properties.selection, measured: properties.measured });
  return (
    <div className={VIEW_CLASS.overlay}>
      <PeerSelections slide={properties.slide} scale={properties.scale} peers={properties.peers} />
      <SelectionLayer outline={outline} scale={properties.scale} measured={properties.measured} />
      <GestureLayer gesture={properties.gesture} scale={properties.scale} slide={properties.slide} />
      <MarkingsLayer slide={properties.slide} scale={properties.scale} composer={properties.composer} focusedThread={properties.focusedThread} gesture={properties.gesture} />
      <CommentPins pins={properties.pins} scale={properties.scale} />
      <PeerCursors slideId={properties.slide.id} scale={properties.scale} peers={properties.peers} />
    </div>
  );
});

/** The CSS colour of a person's presence: one of the scheme's peer colours, as a custom property. */
export function peerColour(colourIndex: number): string {
  const count = TIDEPOOL_TOKENS.light.peerColours.length;
  return `var(--sasha-peer-colours-${(((colourIndex % count) + count) % count) + 1})`;
}

function SelectionLayer(properties: Readonly<{ outline: ReturnType<typeof selectionOutline>; scale: number; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): ReactElement | null {
  const outline = properties.outline;
  switch (outline.kind) {
    case "none":
      return null;
    case "single":
      return lineOf(outline.element) === null ? (
        <FrameBox frame={outline.frame} scale={properties.scale} handles={outline.showHandles} element={outline.element} measured={properties.measured} />
      ) : (
        <LineHandles element={outline.element} scale={properties.scale} showHandles={outline.showHandles} />
      );
    case "multiple":
      return (
        <>
          {outline.frames.map((frame, index) => (
            <div key={index} className={VIEW_CLASS.selectionBox} data-subtle="true" style={frameBoxCss(frame, properties.scale)} />
          ))}
          <FrameBox frame={{ ...outline.bounds, rotation: 0, flipHorizontal: false, flipVertical: false }} scale={properties.scale} handles element={null} measured={properties.measured} />
        </>
      );
    default:
      return assertNever(outline);
  }
}

function FrameBox(properties: Readonly<{ frame: Frame; scale: number; handles: boolean; element: ElementSnapshot | null; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): ReactElement {
  const table = properties.element === null ? null : tableOf(properties.element);
  return (
    <div className={VIEW_CLASS.selectionBox} style={frameBoxCss(properties.frame, properties.scale)}>
      {properties.handles ? (
        <>
          <div className={VIEW_CLASS.rotationStem} />
          <div className={VIEW_CLASS.rotationHandle} {...{ [ROTATION_HANDLE_ATTRIBUTE]: "" }} title="Rotate (Shift snaps to 15 degrees)" />
          {RESIZE_HANDLES.map((handle) => {
            const fraction = handleFraction(handle);
            return <div key={handle} className={VIEW_CLASS.handle} data-handle-name={handle} style={{ left: `${fraction.x * 100}%`, top: `${fraction.y * 100}%` }} {...{ [HANDLE_ATTRIBUTE]: handle }} />;
          })}
        </>
      ) : null}
      {table === null ? null : <TableBoundaryStrips table={table} scale={properties.scale} measured={properties.measured} />}
    </div>
  );
}

function TableBoundaryStrips(properties: Readonly<{ table: Extract<ElementSnapshot, { kind: "table" }>; scale: number; measured: ReadonlyMap<ElementId, ElementMeasurement> }>): ReactElement {
  const boundaries = tableBoundaries({ table: properties.table, measured: properties.measured });
  return (
    <>
      {boundaries.columns.slice(0, -1).map((column) => (
        <div key={column.columnId} className={VIEW_CLASS.tableBoundary} data-axis="column" style={{ left: column.offset * properties.scale }} {...{ [TABLE_COLUMN_BOUNDARY_ATTRIBUTE]: column.columnId, [HANDLE_ELEMENT_ATTRIBUTE]: properties.table.id }} />
      ))}
      {boundaries.rows.map((row) => (
        <div key={row.rowId} className={VIEW_CLASS.tableBoundary} data-axis="row" style={{ top: row.offset * properties.scale }} {...{ [TABLE_ROW_BOUNDARY_ATTRIBUTE]: row.rowId, [HANDLE_ELEMENT_ATTRIBUTE]: properties.table.id }} />
      ))}
    </>
  );
}

function LineHandles(properties: Readonly<{ element: ElementSnapshot; scale: number; showHandles: boolean }>): ReactElement | null {
  const line = lineOf(properties.element);
  if (line === null) return null;
  const scale = properties.scale;
  const ends: readonly Readonly<{ end: "start" | "end"; point: Point }>[] = [
    { end: "start", point: line.start },
    { end: "end", point: line.end },
  ];
  return (
    <>
      <svg className={VIEW_CLASS.overlaySvg} aria-hidden="true">
        <line x1={line.start.x * scale} y1={line.start.y * scale} x2={line.end.x * scale} y2={line.end.y * scale} className={VIEW_CLASS.selectionLine} />
      </svg>
      {properties.showHandles
        ? ends.map((end) => <div key={end.end} className={VIEW_CLASS.handle} data-handle-name={end.end} style={{ left: end.point.x * scale, top: end.point.y * scale }} {...{ [LINE_END_ATTRIBUTE]: end.end, [HANDLE_ELEMENT_ATTRIBUTE]: line.id }} />)
        : null}
    </>
  );
}

function GestureLayer(properties: Readonly<{ gesture: Gesture; scale: number; slide: SlideSnapshot }>): ReactElement | null {
  const gesture = properties.gesture;
  const scale = properties.scale;
  switch (gesture.kind) {
    case "moving":
    case "resizing":
      return <Guides guides={gesture.guides} scale={scale} />;
    case "movingLineEnd": {
      const line = lineOf(findElement(properties.slide.elements, gesture.elementId));
      const fixed = line === null ? null : gesture.end === "start" ? line.end : line.start;
      return (
        <>
          <Guides guides={gesture.guides} scale={scale} />
          {fixed === null ? null : (
            <svg className={VIEW_CLASS.overlaySvg} aria-hidden="true">
              <line x1={fixed.x * scale} y1={fixed.y * scale} x2={gesture.point.x * scale} y2={gesture.point.y * scale} className={VIEW_CLASS.selectionLine} />
            </svg>
          )}
        </>
      );
    }
    case "marquee":
      return <div className={VIEW_CLASS.marquee} style={boxCss(marqueeBox(gesture), scale)} />;
    case "creating":
      return <div className={VIEW_CLASS.creationBox} style={boxCss(marqueeBox(gesture), scale)} />;
    case "resizingTableLine":
      return null;
    case "idle":
    case "pressed":
    case "rotating":
    case "draggingSlides":
    case "drawingMarking":
    case "panning":
      return null;
    default:
      return assertNever(gesture);
  }
}

function Guides(properties: Readonly<{ guides: readonly Readonly<{ axis: "vertical" | "horizontal"; position: number; from: number; to: number }>[]; scale: number }>): ReactElement {
  const scale = properties.scale;
  return (
    <>
      {properties.guides.map((guide, index) => (
        <div
          key={index}
          className={VIEW_CLASS.guide}
          data-axis={guide.axis}
          style={
            guide.axis === "vertical"
              ? { left: guide.position * scale, top: guide.from * scale, height: Math.max(1, (guide.to - guide.from) * scale) }
              : { top: guide.position * scale, left: guide.from * scale, width: Math.max(1, (guide.to - guide.from) * scale) }
          }
        />
      ))}
    </>
  );
}

function PeerSelections(properties: Readonly<{ slide: SlideSnapshot; scale: number; peers: readonly PeerPresence[] }>): ReactElement {
  return (
    <>
      {properties.peers.flatMap((peer) => {
        const selection = peer.selection;
        const elementIds = peerElementIds(selection, properties.slide.id);
        return elementIds.flatMap((elementId) => {
          const element = findElement(properties.slide.elements, elementId);
          if (element === null) return [];
          return [<div key={`${peer.clientId}:${elementId}`} className={VIEW_CLASS.peerSelection} style={{ ...frameBoxCss(element.frame, properties.scale), color: peerColour(peer.person.colourIndex) }} title={`${peer.person.displayName} has this selected`} />];
        });
      })}
    </>
  );
}

function PeerCursors(properties: Readonly<{ slideId: SlideSnapshot["id"]; scale: number; peers: readonly PeerPresence[] }>): ReactElement {
  return (
    <>
      {properties.peers.map((peer) => {
        if (peer.slideId !== properties.slideId || peer.pointer === null) return null;
        return (
          <div key={peer.clientId} className={VIEW_CLASS.peerCursor} style={{ left: peer.pointer.x * properties.scale, top: peer.pointer.y * properties.scale, color: peerColour(peer.person.colourIndex) }} data-activity={peer.activity}>
            <svg viewBox="0 0 16 20" aria-hidden="true">
              <path d="M1 1 15 10l-6.5 1.5L5 19z" fill="currentColor" stroke="var(--sasha-peer-label-text)" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className={VIEW_CLASS.peerLabel} style={{ backgroundColor: peerColour(peer.person.colourIndex) }}>
              {peer.person.displayName}
            </span>
          </div>
        );
      })}
    </>
  );
}

function CommentPins(properties: Readonly<{ pins: readonly ArrangedThread[]; scale: number }>): ReactElement {
  return (
    <>
      {properties.pins.map((pin, index) => {
        const box = placementBox(pin);
        if (box === null) return null;
        return (
          <button
            key={pin.thread.id}
            type="button"
            className={VIEW_CLASS.commentPin}
            data-resolved={pin.thread.status.kind === "resolved" ? "true" : "false"}
            style={{ left: (box.x + box.width) * properties.scale, top: box.y * properties.scale }}
            aria-label={`Comment ${index + 1} by ${pin.thread.createdBy.displayName}`}
            {...{ [COMMENT_PIN_ATTRIBUTE]: pin.thread.id }}
          >
            {index + 1}
          </button>
        );
      })}
    </>
  );
}

/** The markings of the comment being written, of the focused thread, and of the one being drawn. */
function MarkingsLayer(properties: Readonly<{ slide: SlideSnapshot; scale: number; composer: CommentComposer; focusedThread: ArrangedThread | null; gesture: Gesture }>): ReactElement | null {
  const slideBox: Box = { x: 0, y: 0, width: 1280, height: 720 };
  const drawn: { marking: Marking; reference: Box }[] = [];
  if (properties.composer.kind === "composing" && properties.composer.slideId === properties.slide.id) {
    const reference = referenceBox({ slide: properties.slide, elementId: draftElementId(properties.composer.target), fallback: slideBox });
    for (const marking of properties.composer.markings) drawn.push({ marking, reference });
    if (properties.gesture.kind === "drawingMarking") drawn.push({ marking: properties.gesture.marking, reference });
  }
  const focused = properties.focusedThread;
  if (focused !== null) {
    const box = placementBox(focused);
    if (box !== null) for (const marking of focused.thread.markings) drawn.push({ marking, reference: box });
  }
  if (drawn.length === 0) return null;
  const scale = properties.scale;
  const point = (reference: Box, fraction: FractionalPoint): Point => ({ x: (reference.x + fraction.x * reference.width) * scale, y: (reference.y + fraction.y * reference.height) * scale });
  return (
    <svg className={VIEW_CLASS.overlaySvg} aria-hidden="true">
      {drawn.map((entry, index) => markingShape({ key: index, marking: entry.marking, reference: entry.reference, scale, point }))}
    </svg>
  );
}

function markingShape(options: Readonly<{ key: number; marking: Marking; reference: Box; scale: number; point: (reference: Box, fraction: FractionalPoint) => Point }>): ReactElement {
  const marking = options.marking;
  const reference = options.reference;
  switch (marking.kind) {
    case "pen":
      return <polyline key={options.key} points={marking.points.map((fraction) => options.point(reference, fraction)).map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={marking.colour} strokeWidth={marking.width} strokeLinecap="round" strokeLinejoin="round" />;
    case "rectangle":
    case "highlight": {
      const start = options.point(reference, { x: marking.region.x, y: marking.region.y });
      const end = options.point(reference, { x: marking.region.x + marking.region.width, y: marking.region.y + marking.region.height });
      return marking.kind === "highlight" ? (
        <rect key={options.key} x={start.x} y={start.y} width={end.x - start.x} height={end.y - start.y} fill={marking.colour} fillOpacity={0.3} />
      ) : (
        <rect key={options.key} x={start.x} y={start.y} width={end.x - start.x} height={end.y - start.y} fill="none" stroke={marking.colour} strokeWidth={3} />
      );
    }
    case "arrow": {
      const from = options.point(reference, marking.from);
      const to = options.point(reference, marking.to);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const wing = (offset: number): string => `${to.x - 14 * Math.cos(angle + offset)},${to.y - 14 * Math.sin(angle + offset)}`;
      return (
        <g key={options.key} stroke={marking.colour} strokeWidth={3} strokeLinecap="round" fill="none">
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
          <polyline points={`${wing(0.45)} ${to.x},${to.y} ${wing(-0.45)}`} />
        </g>
      );
    }
    default:
      return assertNever(marking);
  }
}

/** Where a thread's pin sits, in slide units; null for a thread on a deleted slide. */
export function placementBox(arranged: ArrangedThread): Box | null {
  const placement = arranged.placement;
  switch (placement.kind) {
    case "onElement":
    case "elementRemoved":
    case "onSlide":
      return placement.box;
    case "slideRemoved":
      return null;
    default:
      return assertNever(placement);
  }
}

function frameBoxCss(frame: Frame, scale: number): CSSProperties {
  return {
    left: frame.x * scale,
    top: frame.y * scale,
    width: Math.max(1, frame.width * scale),
    height: Math.max(1, frame.height * scale),
    ...(frame.rotation === 0 ? {} : { transform: `rotate(${frame.rotation}deg)` }),
  };
}

function boxCss(box: Box, scale: number): CSSProperties {
  return { left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale };
}

function lineOf(element: ElementSnapshot | null): Extract<ElementSnapshot, { kind: "line" }> | null {
  if (element === null) return null;
  switch (element.kind) {
    case "line":
      return element;
    case "shape":
    case "image":
    case "table":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function tableOf(element: ElementSnapshot): Extract<ElementSnapshot, { kind: "table" }> | null {
  switch (element.kind) {
    case "table":
      return element;
    case "shape":
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function peerElementIds(selection: Selection, slideId: SlideSnapshot["id"]): readonly ElementId[] {
  switch (selection.kind) {
    case "elements":
      return selection.slideId === slideId ? selection.elementIds : [];
    case "text":
      switch (selection.target.kind) {
        case "element":
        case "tableCell":
          return selection.target.slideId === slideId ? [selection.target.elementId] : [];
        case "speakerNotes":
          return [];
        default:
          return assertNever(selection.target);
      }
    case "tableCells":
      return selection.slideId === slideId ? [selection.elementId] : [];
    case "none":
    case "slides":
      return [];
    default:
      return assertNever(selection);
  }
}

function draftElementId(target: Extract<CommentComposer, { kind: "composing" }>["target"]): ElementId | null {
  switch (target.kind) {
    case "slide":
      return null;
    case "element":
    case "text":
      return target.elementId;
    default:
      return assertNever(target);
  }
}

function referenceBox(options: Readonly<{ slide: SlideSnapshot; elementId: ElementId | null; fallback: Box }>): Box {
  if (options.elementId === null) return options.fallback;
  return findElement(options.slide.elements, options.elementId)?.frame ?? options.fallback;
}
