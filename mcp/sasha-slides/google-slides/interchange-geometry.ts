/**
 * Slides affine transforms to engine frames and back, and the unit scale between the two pages.
 *
 * UNITS (SPEC.md 21.12): a Slides page is `pageSize.width` English metric units wide and the
 * engine's page is 1280 units wide, so `units = englishMetricUnits * 1280 / pageWidth`. Text sizes
 * are points, and a page `pageWidth / 12700` points wide maps to 1280 units the same way.
 *
 * TRANSFORM TO FRAME. Slides places an element by an affine map of its own box (`size`):
 * `x' = scaleX x + shearX y + translateX`, `y' = shearY x + scaleY y + translateY`. The engine's
 * frame is an unrotated box rotated about its centre with flips applied first (geometry.ts), i.e.
 * the matrix `R(rotation) * diag(flipX, flipY)` times the size. So:
 *   width  = size.width  * hypot(scaleX, shearY)       height = size.height * hypot(shearX, scaleY)
 *   a negative determinant is a mirror; it is read as a HORIZONTAL flip, rotation =
 *   atan2(-shearY, -scaleX), because that is what Slides' own "Flip horizontally" writes (a
 *   negative scaleX), so a flipped picture reads back as flipped rather than as "rotated 180 and
 *   flipped vertically", which draws the same but surprises the person reading the panel;
 *   centre = the transform of the box centre, and `x = centreX - width / 2`.
 * The inverse (`transformForFrame`) is exact, so an export of an imported element lands where it
 * was to floating-point precision.
 */
import type { Frame, Point } from "../engine/src/contracts/geometry.ts";
import type { SlidesTransform } from "./slides-presentation.ts";

export type PageScale = Readonly<{
  /** Engine units per English metric unit. */
  unitsPerEnglishMetricUnit: number;
  /** Engine units per point. */
  unitsPerPoint: number;
  pageWidthEnglishMetricUnits: number;
  pageHeightEnglishMetricUnits: number;
  /** The page height in engine units (720 for 16:9). */
  pageHeight: number;
}>;

export const SLIDE_WIDTH_UNITS = 1280;
const ENGLISH_METRIC_UNITS_PER_POINT = 12_700;

export function pageScaleFor(options: Readonly<{ widthEnglishMetricUnits: number; heightEnglishMetricUnits: number }>): PageScale {
  const unitsPerEnglishMetricUnit = SLIDE_WIDTH_UNITS / options.widthEnglishMetricUnits;
  return {
    unitsPerEnglishMetricUnit,
    unitsPerPoint: unitsPerEnglishMetricUnit * ENGLISH_METRIC_UNITS_PER_POINT,
    pageWidthEnglishMetricUnits: options.widthEnglishMetricUnits,
    pageHeightEnglishMetricUnits: options.heightEnglishMetricUnits,
    pageHeight: options.heightEnglishMetricUnits * unitsPerEnglishMetricUnit,
  };
}

/** `parent * child`: a grouped element's absolute transform (Slides stores it relative to its group). */
export function composeTransforms(options: Readonly<{ parent: SlidesTransform; child: SlidesTransform }>): SlidesTransform {
  const { parent, child } = options;
  return {
    scaleX: parent.scaleX * child.scaleX + parent.shearX * child.shearY,
    shearX: parent.scaleX * child.shearX + parent.shearX * child.scaleY,
    shearY: parent.shearY * child.scaleX + parent.scaleY * child.shearY,
    scaleY: parent.shearY * child.shearX + parent.scaleY * child.scaleY,
    translateX: parent.scaleX * child.translateX + parent.shearX * child.translateY + parent.translateX,
    translateY: parent.shearY * child.translateX + parent.scaleY * child.translateY + parent.translateY,
  };
}

/** Where `point` (element-local English metric units) lands on the page, in engine units. */
export function transformPoint(options: Readonly<{ transform: SlidesTransform; point: Point; scale: PageScale }>): Point {
  const { transform, point, scale } = options;
  return {
    x: (transform.scaleX * point.x + transform.shearX * point.y + transform.translateX) * scale.unitsPerEnglishMetricUnit,
    y: (transform.shearY * point.x + transform.scaleY * point.y + transform.translateY) * scale.unitsPerEnglishMetricUnit,
  };
}

/** The rotation and mirror a transform carries (see the header for the flip convention). */
export function rotationOf(transform: SlidesTransform): Readonly<{ rotation: number; flipHorizontal: boolean }> {
  const determinant = transform.scaleX * transform.scaleY - transform.shearX * transform.shearY;
  if (determinant >= 0) return { rotation: normaliseDegrees((Math.atan2(transform.shearY, transform.scaleX) * 180) / Math.PI), flipHorizontal: false };
  return { rotation: normaliseDegrees((Math.atan2(-transform.shearY, -transform.scaleX) * 180) / Math.PI), flipHorizontal: true };
}

export function frameForTransform(
  options: Readonly<{ transform: SlidesTransform; widthEnglishMetricUnits: number; heightEnglishMetricUnits: number; scale: PageScale; minimumSize: number }>,
): Frame {
  const { transform, scale } = options;
  const width = Math.max(options.minimumSize, options.widthEnglishMetricUnits * Math.hypot(transform.scaleX, transform.shearY) * scale.unitsPerEnglishMetricUnit);
  const height = Math.max(options.minimumSize, options.heightEnglishMetricUnits * Math.hypot(transform.shearX, transform.scaleY) * scale.unitsPerEnglishMetricUnit);
  const centre = transformPoint({ transform, point: { x: options.widthEnglishMetricUnits / 2, y: options.heightEnglishMetricUnits / 2 }, scale });
  const { rotation, flipHorizontal } = rotationOf(transform);
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height, rotation, flipHorizontal, flipVertical: false };
}

/**
 * The Slides `size` and `transform` (English metric units) that place a box of `frame`. The size is
 * the frame's own and the transform is a pure rotation and mirror, so a person who opens the
 * exported element in Slides sees its real width and height in the format panel.
 */
export function transformForFrame(
  options: Readonly<{ frame: Frame; scale: PageScale }>,
): Readonly<{ widthEnglishMetricUnits: number; heightEnglishMetricUnits: number; transform: SlidesTransform }> {
  const { frame, scale } = options;
  const toEnglishMetricUnits = 1 / scale.unitsPerEnglishMetricUnit;
  const width = frame.width * toEnglishMetricUnits;
  const height = frame.height * toEnglishMetricUnits;
  const radians = (frame.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const flipX = frame.flipHorizontal ? -1 : 1;
  const flipY = frame.flipVertical ? -1 : 1;
  const scaleX = cosine * flipX;
  const shearY = sine * flipX;
  const shearX = -sine * flipY;
  const scaleY = cosine * flipY;
  const centreX = (frame.x + frame.width / 2) * toEnglishMetricUnits;
  const centreY = (frame.y + frame.height / 2) * toEnglishMetricUnits;
  return {
    widthEnglishMetricUnits: width,
    heightEnglishMetricUnits: height,
    transform: {
      scaleX: clean(scaleX),
      scaleY: clean(scaleY),
      shearX: clean(shearX),
      shearY: clean(shearY),
      translateX: centreX - (scaleX * width) / 2 - (shearX * height) / 2,
      translateY: centreY - (shearY * width) / 2 - (scaleY * height) / 2,
    },
  };
}

export function normaliseDegrees(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(turned * 1e9) / 1e9;
  return rounded === 360 || rounded === 0 ? 0 : rounded;
}

/** cos(90) is 6e-17, not 0; a matrix entry that small is written as exactly 0. */
function clean(value: number): number {
  return Math.abs(value) < 1e-12 ? 0 : value;
}
