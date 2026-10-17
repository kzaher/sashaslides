// GEOMETRY: the one coordinate system every layer agrees on, and the pure rules for moving,
// resizing, rotating and flipping frames. The rules live HERE, in the contracts, because three
// modules must produce identical results from them: the state module previews and commits
// gestures, the view draws handles and selection bounds, and the model derives group and line
// frames for snapshots. Any disagreement would show as a handle that does not sit on its element.
//
// SLIDE UNITS. Every position and size in the document is in "slide units": the slide is 1280
// units wide, and 720 tall for 16:9. That is the same 1280 x 720 box every candidate slide in the
// product is already authored at (addon/src/editor/slide-edit.ts, PROTOCOL.md), so a markup
// candidate, a Sasha engine slide and a rendered thumbnail share coordinates without conversion.
// The view scales the whole slide with one transform; nothing below the view ever sees a screen
// pixel. Pointer events are converted to slide units by the view BEFORE they are dispatched (the
// screen position travels alongside only for drag thresholds).
//
// GOOGLE SLIDES. A 16:9 Slides page is 9,144,000 x 5,143,500 English metric units, so one slide
// unit is exactly 7143.75 of them on both axes (9,144,000 / 1280 = 5,143,500 / 720). Import and
// export (milestone 3) convert with that one constant; a 4:3 deck is 1280 x 960 units.
//
// ROTATION is in degrees, clockwise on screen, about the frame's centre, normalised to [0, 360) --
// the stylesheet's `rotate()` and the Slides affine transform both decompose to that, and it is
// what a user types into a rotation field. Screen coordinates have y pointing down, so the
// ordinary rotation matrix turns clockwise.
//
// FLIPS compose BEFORE the rotation (as in Slides): the element is mirrored inside its own box,
// then rotated. Mirroring a rotated element in slide space therefore negates its rotation and
// toggles its flip (mirror . rotate(t) = rotate(-t) . mirror), which `flipFrame` implements.
//
// RESIZING PAST THE OPPOSITE EDGE FLIPS, as in Slides: the size stays positive and the flip on
// that axis toggles. Sizes never fall below `MINIMUM_FRAME_SIZE`.
//
// NON-UNIFORM SCALING OF ROTATED ELEMENTS IS APPROXIMATE. Stretching a group (or a multiple
// selection) whose children are rotated would, exactly, shear them -- which a `Frame` cannot hold.
// `scaleFrameBetweenBoxes` keeps each child a rectangle: its centre maps exactly, and its width and
// height scale by how much the stretch lengthens its own local axes. Slides does approximately the
// same; the tests pin the behaviour.

import { assertNever } from "./assert-never.ts";

export const SLIDE_WIDTH_UNITS = 1280;
export const DEFAULT_SLIDE_HEIGHT_UNITS = 720;
export const ENGLISH_METRIC_UNITS_PER_SLIDE_UNIT = 7143.75;
/** Slides measures text in points; 1 slide unit = 0.5625 point on the default page. */
export const POINTS_PER_SLIDE_UNIT = 0.5625;
/** No frame edge is ever shorter than this, in slide units (a line's frame excepted). */
export const MINIMUM_FRAME_SIZE = 1;

export type Point = Readonly<{ x: number; y: number }>;
export type Size = Readonly<{ width: number; height: number }>;
export type PageSize = Readonly<{ width: typeof SLIDE_WIDTH_UNITS; height: number }>;

/**
 * Where an element sits. `x`/`y` are the UNROTATED top-left corner; the element is rotated about
 * the centre of this box. Stored as ONE value in the shared document (yjs-schema.ts).
 */
export type Frame = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}>;

/** An axis-aligned box, e.g. the rotated bounds of a frame or a marquee. */
export type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * A box as fractions (0..1) of a reference box: the slide, or an element's frame (discussion.ts
 * says which). The candidate-review `Region` in addon/src/protocol.ts uses `w`/`h`; the milestone 2
 * bridge converts at that boundary, so the abbreviation never enters the engine.
 */
export type FractionalRegion = Readonly<{ x: number; y: number; width: number; height: number }>;

/** A point as fractions (0..1) of the same reference box as a `FractionalRegion`. */
export type FractionalPoint = Readonly<{ x: number; y: number }>;

/** The eight resize handles, as hit-testing reports them (the rotation handle is its own target). */
export type ResizeHandle =
  | "topLeft"
  | "top"
  | "topRight"
  | "right"
  | "bottomRight"
  | "bottom"
  | "bottomLeft"
  | "left";

export type FlipAxis = "horizontal" | "vertical";

export function identityFrame(box: Box): Frame {
  return { x: box.x, y: box.y, width: box.width, height: box.height, rotation: 0, flipHorizontal: false, flipVertical: false };
}

/** The centre of a frame, which rotation is about. */
export function frameCentre(frame: Box): Point {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** Degrees into [0, 360), with -0 as 0. */
export function normaliseRotation(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  // `-0 === 0`, so this also turns -0 into 0.
  return turned === 0 ? 0 : turned;
}

/** `degrees` rounded to the nearest multiple of `step` (Shift while rotating: 15). */
export function snapRotation(options: Readonly<{ degrees: number; step: number }>): number {
  return normaliseRotation(Math.round(options.degrees / options.step) * options.step);
}

export function rotatePoint(options: Readonly<{ point: Point; centre: Point; degrees: number }>): Point {
  const radians = (options.degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = options.point.x - options.centre.x;
  const offsetY = options.point.y - options.centre.y;
  return {
    x: options.centre.x + offsetX * cosine - offsetY * sine,
    y: options.centre.y + offsetX * sine + offsetY * cosine,
  };
}

/** The four corners of a frame in slide space, clockwise from the unrotated top-left. */
export function frameCorners(frame: Frame): readonly Point[] {
  const centre = frameCentre(frame);
  const corners: readonly Point[] = [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x, y: frame.y + frame.height },
  ];
  return corners.map((corner) => rotatePoint({ point: corner, centre, degrees: frame.rotation }));
}

/** The axis-aligned bounds of a (possibly rotated) frame: what marquee, snapping and alignment use. */
export function rotatedBounds(frame: Frame): Box {
  const bounds = boundsOfPoints(frameCorners(frame));
  // A frame always has four corners, so bounds exist.
  return bounds ?? { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

/** The smallest box holding every point; null for none. */
export function boundsOfPoints(points: readonly Point[]): Box | null {
  const first = points[0];
  if (first === undefined) return null;
  let left = first.x;
  let top = first.y;
  let right = first.x;
  let bottom = first.y;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The smallest box holding every box; null for none. */
export function boundsOfBoxes(boxes: readonly Box[]): Box | null {
  return boundsOfPoints(boxes.flatMap((box) => [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
  ]));
}

/** A line's frame: the bounding box of its end points, never rotated or flipped. */
export function lineFrame(options: Readonly<{ start: Point; end: Point }>): Frame {
  const bounds = boundsOfPoints([options.start, options.end]);
  return identityFrame(bounds ?? { x: options.start.x, y: options.start.y, width: 0, height: 0 });
}

/** Rotate a frame about a pivot (rotating a multiple selection or a group about its centre). */
export function rotateFrameAbout(options: Readonly<{ frame: Frame; pivot: Point; degrees: number }>): Frame {
  const centre = rotatePoint({ point: frameCentre(options.frame), centre: options.pivot, degrees: options.degrees });
  return {
    ...options.frame,
    x: centre.x - options.frame.width / 2,
    y: centre.y - options.frame.height / 2,
    rotation: normaliseRotation(options.frame.rotation + options.degrees),
  };
}

/**
 * Mirror a frame in slide space across the line `x = about` (horizontal) or `y = about`
 * (vertical): the centre is mirrored, the rotation negated and the flip on that axis toggled (see
 * the header). Flipping a selection or a group mirrors each member about the selection's centre.
 */
export function flipFrame(options: Readonly<{ frame: Frame; axis: FlipAxis; about: number }>): Frame {
  const centre = frameCentre(options.frame);
  const rotation = normaliseRotation(-options.frame.rotation);
  switch (options.axis) {
    case "horizontal": {
      const centreX = 2 * options.about - centre.x;
      return { ...options.frame, x: centreX - options.frame.width / 2, rotation, flipHorizontal: !options.frame.flipHorizontal };
    }
    case "vertical": {
      const centreY = 2 * options.about - centre.y;
      return { ...options.frame, y: centreY - options.frame.height / 2, rotation, flipVertical: !options.frame.flipVertical };
    }
    default:
      return assertNever(options.axis);
  }
}

/** Mirror a point across the same line `flipFrame` uses (a line's end points, a marking). */
export function flipPoint(options: Readonly<{ point: Point; axis: FlipAxis; about: number }>): Point {
  switch (options.axis) {
    case "horizontal":
      return { x: 2 * options.about - options.point.x, y: options.point.y };
    case "vertical":
      return { x: options.point.x, y: 2 * options.about - options.point.y };
    default:
      return assertNever(options.axis);
  }
}

export type ResizeOptions = Readonly<{
  frame: Frame;
  handle: ResizeHandle;
  /** Where the handle is being dragged to, slide units. */
  pointer: Point;
  /** Shift, or the aspect-ratio lock. */
  keepAspectRatio: boolean;
  /** Alt: resize symmetrically about the centre instead of from the opposite handle. */
  fromCentre: boolean;
}>;

/**
 * The frame a resize handle drag produces, worked in the frame's own (unrotated) axes so a rotated
 * element resizes along its edges. Dragging past the opposite edge flips (see the header).
 */
export function resizeFrame(options: ResizeOptions): Frame {
  const frame = options.frame;
  const centre = frameCentre(frame);
  const local = rotatePoint({ point: options.pointer, centre, degrees: -frame.rotation });
  const pointerX = local.x - centre.x;
  const pointerY = local.y - centre.y;
  const horizontal = HANDLE_AXES[options.handle].horizontal;
  const vertical = HANDLE_AXES[options.handle].vertical;

  let signedWidth = signedExtent({ direction: horizontal, pointer: pointerX, half: frame.width / 2, fromCentre: options.fromCentre, size: frame.width });
  let signedHeight = signedExtent({ direction: vertical, pointer: pointerY, half: frame.height / 2, fromCentre: options.fromCentre, size: frame.height });

  if (options.keepAspectRatio && frame.width > 0 && frame.height > 0) {
    const scaleX = Math.abs(signedWidth) / frame.width;
    const scaleY = Math.abs(signedHeight) / frame.height;
    const scale = horizontal === 0 ? scaleY : vertical === 0 ? scaleX : Math.max(scaleX, scaleY);
    signedWidth = Math.sign(signedWidth || 1) * frame.width * scale;
    signedHeight = Math.sign(signedHeight || 1) * frame.height * scale;
  }

  const width = Math.max(MINIMUM_FRAME_SIZE, Math.abs(signedWidth));
  const height = Math.max(MINIMUM_FRAME_SIZE, Math.abs(signedHeight));
  const localCentreX = newLocalCentre({ direction: horizontal, half: frame.width / 2, signedSize: signedWidth, size: width, fromCentre: options.fromCentre });
  const localCentreY = newLocalCentre({ direction: vertical, half: frame.height / 2, signedSize: signedHeight, size: height, fromCentre: options.fromCentre });
  const newCentre = rotatePoint({ point: { x: centre.x + localCentreX, y: centre.y + localCentreY }, centre, degrees: frame.rotation });
  return {
    x: newCentre.x - width / 2,
    y: newCentre.y - height / 2,
    width,
    height,
    rotation: frame.rotation,
    flipHorizontal: signedWidth < 0 ? !frame.flipHorizontal : frame.flipHorizontal,
    flipVertical: signedHeight < 0 ? !frame.flipVertical : frame.flipVertical,
  };
}

/**
 * Map a frame from one box to another (resizing a group or a multiple selection by its bounds).
 * Exact for unrotated frames; approximate for rotated ones (see the header). `from` and `to` must
 * have positive size on any axis that scales; a flip of the whole selection is `flipFrame`'s job.
 */
export function scaleFrameBetweenBoxes(options: Readonly<{ frame: Frame; from: Box; to: Box }>): Frame {
  const scaleX = options.from.width === 0 ? 1 : options.to.width / options.from.width;
  const scaleY = options.from.height === 0 ? 1 : options.to.height / options.from.height;
  const centre = mapPointBetweenBoxes({ point: frameCentre(options.frame), from: options.from, to: options.to });
  const radians = (options.frame.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const width = options.frame.width * Math.hypot(scaleX * cosine, scaleY * sine);
  const height = options.frame.height * Math.hypot(scaleX * sine, scaleY * cosine);
  const rotation = normaliseRotation((Math.atan2(scaleY * sine, scaleX * cosine) * 180) / Math.PI);
  return { ...options.frame, x: centre.x - width / 2, y: centre.y - height / 2, width, height, rotation };
}

/**
 * Map a point from one box to another, axis by axis. An axis of zero size (a horizontal or
 * vertical line selected alone) only translates, so it never divides by zero.
 */
export function mapPointBetweenBoxes(options: Readonly<{ point: Point; from: Box; to: Box }>): Point {
  return {
    x: mapCoordinate({ value: options.point.x, fromStart: options.from.x, fromSize: options.from.width, toStart: options.to.x, toSize: options.to.width }),
    y: mapCoordinate({ value: options.point.y, fromStart: options.from.y, fromSize: options.from.height, toStart: options.to.y, toSize: options.to.height }),
  };
}

export function pointsFromSlideUnits(units: number): number {
  return units * POINTS_PER_SLIDE_UNIT;
}

export function slideUnitsFromPoints(points: number): number {
  return points / POINTS_PER_SLIDE_UNIT;
}

/** -1: the handle moves the left (top) edge; 1: the right (bottom) edge; 0: that axis does not move. */
type AxisDirection = -1 | 0 | 1;

const HANDLE_AXES: Readonly<Record<ResizeHandle, Readonly<{ horizontal: AxisDirection; vertical: AxisDirection }>>> = {
  topLeft: { horizontal: -1, vertical: -1 },
  top: { horizontal: 0, vertical: -1 },
  topRight: { horizontal: 1, vertical: -1 },
  right: { horizontal: 1, vertical: 0 },
  bottomRight: { horizontal: 1, vertical: 1 },
  bottom: { horizontal: 0, vertical: 1 },
  bottomLeft: { horizontal: -1, vertical: 1 },
  left: { horizontal: -1, vertical: 0 },
};

/** The new size along one axis, negative when the moving edge crossed the fixed one. */
function signedExtent(options: Readonly<{ direction: AxisDirection; pointer: number; half: number; fromCentre: boolean; size: number }>): number {
  if (options.direction === 0) return options.size;
  if (options.fromCentre) return 2 * options.pointer * options.direction;
  // The fixed edge sits at -direction * half; the moving edge follows the pointer.
  return (options.pointer + options.direction * options.half) * options.direction;
}

/** Where the new box's centre lies on one axis, relative to the old centre. */
function newLocalCentre(options: Readonly<{ direction: AxisDirection; half: number; signedSize: number; size: number; fromCentre: boolean }>): number {
  if (options.direction === 0 || options.fromCentre) return 0;
  const fixedEdge = -options.direction * options.half;
  const growth = Math.sign(options.signedSize || 1) * options.direction;
  return fixedEdge + (growth * options.size) / 2;
}

function mapCoordinate(options: Readonly<{ value: number; fromStart: number; fromSize: number; toStart: number; toSize: number }>): number {
  if (options.fromSize === 0) return options.value + (options.toStart - options.fromStart);
  return options.toStart + ((options.value - options.fromStart) * options.toSize) / options.fromSize;
}
