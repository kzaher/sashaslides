// SMART GUIDES FOR A MOVE (SPEC.md section 7, "move"): the moving selection's left edge, centre and
// right edge snap to the slide's edges and centre and to other elements' edges and centres, and the
// same on the vertical axis, within 5 CLIENT pixels -- a distance on screen, so the reach in slide
// units shrinks as the user zooms in. Every target line the snapped selection then touches is
// reported as a guide for the view to draw. Bounds are rotated bounds, with measured table heights.

import { assertNever, type Box, type SnapGuide } from "../../contracts/index.ts";

export const SNAP_DISTANCE_CLIENT_PIXELS = 5;

export type SnapResult = Readonly<{ deltaX: number; deltaY: number; guides: readonly SnapGuide[] }>;

/** Which axes may move: Shift locks a move to its dominant axis (and that axis alone snaps). */
export type MoveAxes = Readonly<{ horizontal: boolean; vertical: boolean }>;

export function snapMove(
  options: Readonly<{ moving: Box; deltaX: number; deltaY: number; targets: readonly Box[]; slide: Box; scale: number; axes: MoveAxes }>,
): SnapResult {
  const reach = SNAP_DISTANCE_CLIENT_PIXELS / (options.scale > 0 ? options.scale : 1);
  const horizontalLines = [options.slide, ...options.targets].flatMap((box) => linesAlong(box, "vertical"));
  const verticalLines = [options.slide, ...options.targets].flatMap((box) => linesAlong(box, "horizontal"));
  const deltaX = options.axes.horizontal ? snapAxis({ positions: edgesAlong(options.moving, "vertical", options.deltaX), lines: horizontalLines, reach }) + options.deltaX : 0;
  const deltaY = options.axes.vertical ? snapAxis({ positions: edgesAlong(options.moving, "horizontal", options.deltaY), lines: verticalLines, reach }) + options.deltaY : 0;
  const moved: Box = { ...options.moving, x: options.moving.x + deltaX, y: options.moving.y + deltaY };
  const guides = [
    ...(options.axes.horizontal ? guidesFor({ moved, lines: horizontalLines, axis: "vertical" }) : []),
    ...(options.axes.vertical ? guidesFor({ moved, lines: verticalLines, axis: "horizontal" }) : []),
  ];
  return { deltaX, deltaY, guides };
}

/** A line a box offers: `position` on the guide's axis, spanning `from`..`to` along the other one. */
type SnapLine = Readonly<{ position: number; from: number; to: number }>;

const GUIDE_TOLERANCE = 0.01;

/** Vertical lines (x positions) for `"vertical"`, horizontal lines (y positions) for `"horizontal"`. */
function linesAlong(box: Box, axis: SnapGuide["axis"]): readonly SnapLine[] {
  switch (axis) {
    case "vertical":
      return [box.x, box.x + box.width / 2, box.x + box.width].map((position) => ({ position, from: box.y, to: box.y + box.height }));
    case "horizontal":
      return [box.y, box.y + box.height / 2, box.y + box.height].map((position) => ({ position, from: box.x, to: box.x + box.width }));
    default:
      return assertNever(axis);
  }
}

function edgesAlong(box: Box, axis: SnapGuide["axis"], delta: number): readonly number[] {
  return linesAlong(box, axis).map((line) => line.position + delta);
}

/** The correction that brings the nearest edge onto the nearest line within reach; 0 when none is. */
function snapAxis(options: Readonly<{ positions: readonly number[]; lines: readonly SnapLine[]; reach: number }>): number {
  let best: number | null = null;
  for (const position of options.positions) {
    for (const line of options.lines) {
      const correction = line.position - position;
      if (Math.abs(correction) > options.reach) continue;
      if (best === null || Math.abs(correction) < Math.abs(best)) best = correction;
    }
  }
  return best ?? 0;
}

function guidesFor(options: Readonly<{ moved: Box; lines: readonly SnapLine[]; axis: SnapGuide["axis"] }>): readonly SnapGuide[] {
  const movedLines = linesAlong(options.moved, options.axis);
  const guides = new Map<number, SnapGuide>();
  for (const movedLine of movedLines) {
    for (const line of options.lines) {
      if (Math.abs(line.position - movedLine.position) > GUIDE_TOLERANCE) continue;
      const key = Math.round(line.position * 100) / 100;
      const previous = guides.get(key);
      const from = Math.min(line.from, movedLine.from, previous?.from ?? Number.POSITIVE_INFINITY);
      const to = Math.max(line.to, movedLine.to, previous?.to ?? Number.NEGATIVE_INFINITY);
      guides.set(key, { axis: options.axis, position: line.position, from, to });
    }
  }
  return [...guides.values()];
}
