// DRAG A BOX OVER THE PART THAT IS WRONG -- the one interaction both modes of the sidebar share.
//
// It started life inside Picker.tsx as `AnomalyOverlay`, over a candidate slide. Review mode marks
// up a picture of the user's OWN deck and needs exactly the same gesture and exactly the same
// output, so the surface lives here and both call it. There is one coordinate convention in the
// product and this file is where it is produced: the box is captured as a FRACTION of the pane, so
// it means the same thing at any zoom and at any sidebar width, and it lands in `PICK.anomalies`
// and in a feedback comment as the same 0-1 box PROTOCOL.md specifies.

import { useCallback, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import type { Region } from "./protocol.ts";

/** One box already on the surface. `tone` only picks a colour; it carries no behaviour. */
export type RegionMark = Readonly<{
  markId: string;
  region: Region;
  tone: MarkTone;
}>;

/** `user` is something a human drew; `converter` is a region the converter flagged itself. */
export type MarkTone = "user" | "converter";

export function RegionOverlay({
  marks,
  disabled,
  label,
  onRegion,
}: {
  marks: readonly RegionMark[];
  disabled: boolean;
  label: string;
  onRegion: (spec: Readonly<{ region: Region }>) => void;
}): JSX.Element {
  const surface = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const fractionOf = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const element = surface.current;
    if (element === null) return { x: 0, y: 0 };
    const box = element.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - box.left) / Math.max(1, box.width)),
      y: clamp01((event.clientY - box.top) / Math.max(1, box.height)),
    };
  }, []);

  return (
    <div
      ref={surface}
      role="presentation"
      aria-label={label}
      className={disabled ? "sasha-overlay sasha-overlay-off" : "sasha-overlay"}
      onPointerDown={(event) => {
        if (disabled) return;
        const at = fractionOf(event);
        capture({ element: event.currentTarget, pointerId: event.pointerId });
        setDrag({ fromX: at.x, fromY: at.y, toX: at.x, toY: at.y });
      }}
      onPointerMove={(event) => {
        if (drag === null) return;
        const at = fractionOf(event);
        setDrag({ ...drag, toX: at.x, toY: at.y });
      }}
      onPointerUp={() => {
        if (drag === null) return;
        const region = regionOfDrag(drag);
        setDrag(null);
        if (region !== null) onRegion({ region });
      }}
    >
      {marks.map((mark) => (
        <div key={mark.markId} className={`sasha-mark sasha-mark-${mark.tone}`} style={percentBox(mark.region)} />
      ))}
      {drag === null ? null : <div className="sasha-mark sasha-mark-drag" style={percentBox(regionOfDragLoose(drag))} />}
    </div>
  );
}

/**
 * The marks WITHOUT the gesture, for a surface that is not draggable: a grid cell, where the whole
 * cell is a button that opens the annotation view, so an overlay on top of it would swallow the
 * click. Same boxes, same coordinate convention, no pointer handlers at all.
 */
export function RegionMarks({ marks }: { marks: readonly RegionMark[] }): JSX.Element {
  return (
    <div className="sasha-marks" aria-hidden="true">
      {marks.map((mark) => (
        <div key={mark.markId} className={`sasha-mark sasha-mark-${mark.tone}`} style={percentBox(mark.region)} />
      ))}
    </div>
  );
}

/** A region as CSS percentages, which is how every box in this UI is positioned. */
export function percentBox(region: Region): Readonly<{ left: string; top: string; width: string; height: string }> {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.w * 100}%`,
    height: `${region.h * 100}%`,
  };
}

/** "10%,20% 30%x20%" -- short enough for a 300 px sidebar row, exact enough to recognise the box. */
export function describeRegion(region: Region): string {
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  return `${percent(region.x)},${percent(region.y)} ${percent(region.w)}x${percent(region.h)}`;
}

/**
 * Pointer capture keeps the drag alive while the cursor is outside the pane. It is a NICETY, not a
 * requirement -- a SYNTHETIC pointer event (a test harness, an assistive tool) has no active
 * pointer and the call throws `NotFoundError`, which would take the whole gesture down with it:
 * `setDrag` never runs, so the box is never drawn. Guarded, and the gesture degrades to
 * "do not leave the pane mid-drag".
 */
function capture({ element, pointerId }: { element: Element; pointerId: number }): void {
  try {
    element.setPointerCapture(pointerId);
  } catch (cause) {
    console.warn(`[sasha-slides] no pointer capture: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

type Drag = Readonly<{ fromX: number; fromY: number; toX: number; toY: number }>;

/** Smaller than this is a click, not a drag, and would make an unusable 0-area region. */
const MIN_DRAG_FRACTION = 0.01;

function regionOfDrag(drag: Drag): Region | null {
  const region = regionOfDragLoose(drag);
  return region.w < MIN_DRAG_FRACTION || region.h < MIN_DRAG_FRACTION ? null : region;
}

function regionOfDragLoose(drag: Drag): Region {
  return {
    x: Math.min(drag.fromX, drag.toX),
    y: Math.min(drag.fromY, drag.toY),
    w: Math.abs(drag.toX - drag.fromX),
    h: Math.abs(drag.toY - drag.fromY),
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
