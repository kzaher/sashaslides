// SHAPE PRESETS AS DRAWINGS: which presets are boxes and which are vector paths, the path of each
// vector preset scaled to an element's box, and the inner rectangle its text sits in. Pure, so the
// static markup tests pin every preset, and adding a preset to the `ShapePreset` union is a compile
// error here until it has a drawing (SPEC.md section 19, "scope creep in presets").
//
// Key decisions:
//
//  * THE RECTANGLE FAMILY IS A BOX, drawn with stylesheet borders, per-corner radii and box
//    shadows, because those are what per-side borders and per-corner radii need. Everything else is
//    ONE path in the element's own coordinates (0..width, 0..height), with one outline.
//  * A ROUNDED RECTANGLE WITH A ZERO RADIUS still looks rounded: Slides' preset defaults its corner
//    to about a sixth of the short side, so an imported or freshly drawn one is never square.
//  * TEXT INSETS are fractions of the box, approximating Slides' own text rectangles per preset (an
//    ellipse's text box is its inscribed rectangle, a triangle's sits in its lower half, and so on).
//  * A FREEFORM OUTLINE (document.ts `CustomOutline`) REPLACES THE PRESET'S DRAWING. It is always a
//    vector path, whatever the preset, its text uses the whole box (Office's `<a:rect l="l" t="t"
//    r="r" b="b"/>`, the only text rectangle the Google export writes), and its fill and its stroke
//    are two separate paths because each Office path says whether it is filled and stroked.

import { assertNever } from "../../contracts/assert-never.ts";
import type { CustomOutline, OutlinePoint, ShapeElement, ShapePreset } from "../../contracts/document.ts";
import type { CornerRadius } from "../../contracts/style.ts";

/** The text rectangle inside a shape, as fractions of its box from each side. */
export type TextInset = Readonly<{ top: number; right: number; bottom: number; left: number }>;

export const NO_TEXT_INSET: TextInset = { top: 0, right: 0, bottom: 0, left: 0 };

/** Whether a shape is drawn as a box (stylesheet borders and radii) rather than a vector path. */
export function isDrawnAsBox(element: Pick<ShapeElement, "preset" | "customOutline">): boolean {
  return element.customOutline === null && isRectangleFamily(element.preset);
}

/** Total over ShapePreset: true for the presets drawn as a box. */
export function isRectangleFamily(preset: ShapePreset): boolean {
  switch (preset) {
    case "textBox":
    case "rectangle":
    case "roundedRectangle":
      return true;
    case "ellipse":
    case "triangle":
    case "rightTriangle":
    case "diamond":
    case "parallelogram":
    case "trapezoid":
    case "pentagon":
    case "hexagon":
    case "octagon":
    case "fivePointStar":
    case "plus":
    case "heart":
    case "cloud":
    case "speechBubble":
    case "chevron":
    case "rightArrow":
    case "leftArrow":
    case "upArrow":
    case "downArrow":
      return false;
    default:
      return assertNever(preset);
  }
}

/** The radius a box preset is drawn with (see the header on rounded rectangles). */
export function effectiveCornerRadius(options: Readonly<{ preset: ShapePreset; radius: CornerRadius; width: number; height: number }>): CornerRadius {
  const defaultFraction = DEFAULT_CORNER_FRACTION[options.preset];
  switch (options.radius.kind) {
    case "uniform":
      if (options.radius.radius > 0 || defaultFraction === 0) return options.radius;
      return { kind: "uniform", radius: Math.min(options.width, options.height) * defaultFraction };
    case "perCorner":
      return options.radius;
    default:
      return assertNever(options.radius);
  }
}

/** The outline of a vector preset in its box; null for the rectangle family (drawn as a box). */
export function shapeOutlinePath(options: Readonly<{ preset: ShapePreset; width: number; height: number }>): string | null {
  const width = options.width;
  const height = options.height;
  const at = (fractionX: number, fractionY: number): string => `${round(fractionX * width)} ${round(fractionY * height)}`;
  const polygon = (points: readonly (readonly [number, number])[]): string => `M ${points.map(([fractionX, fractionY]) => at(fractionX, fractionY)).join(" L ")} Z`;
  switch (options.preset) {
    case "textBox":
    case "rectangle":
    case "roundedRectangle":
      return null;
    case "ellipse":
      return `M ${at(0, 0.5)} A ${round(width / 2)} ${round(height / 2)} 0 1 1 ${at(1, 0.5)} A ${round(width / 2)} ${round(height / 2)} 0 1 1 ${at(0, 0.5)} Z`;
    case "triangle":
      return polygon([[0.5, 0], [1, 1], [0, 1]]);
    case "rightTriangle":
      return polygon([[0, 0], [1, 1], [0, 1]]);
    case "diamond":
      return polygon([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case "parallelogram":
      return polygon([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]);
    case "trapezoid":
      return polygon([[0.2, 0], [0.8, 0], [1, 1], [0, 1]]);
    case "pentagon":
      return polygon(regularPolygon(5));
    case "hexagon":
      return polygon([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case "octagon":
      return polygon([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]);
    case "fivePointStar":
      return polygon(starPoints());
    case "plus":
      return polygon([[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]]);
    case "heart":
      return [
        `M ${at(0.5, 0.25)}`,
        `C ${at(0.5, 0.05)} ${at(0.15, -0.05)} ${at(0.05, 0.2)}`,
        `C ${at(-0.05, 0.45)} ${at(0.25, 0.7)} ${at(0.5, 1)}`,
        `C ${at(0.75, 0.7)} ${at(1.05, 0.45)} ${at(0.95, 0.2)}`,
        `C ${at(0.85, -0.05)} ${at(0.5, 0.05)} ${at(0.5, 0.25)} Z`,
      ].join(" ");
    case "cloud":
      return [
        `M ${at(0.2, 0.85)}`,
        `C ${at(0.02, 0.85)} ${at(0.0, 0.58)} ${at(0.16, 0.52)}`,
        `C ${at(0.1, 0.3)} ${at(0.32, 0.18)} ${at(0.45, 0.28)}`,
        `C ${at(0.52, 0.06)} ${at(0.82, 0.08)} ${at(0.8, 0.34)}`,
        `C ${at(1.0, 0.36)} ${at(1.02, 0.66)} ${at(0.86, 0.72)}`,
        `C ${at(0.88, 0.9)} ${at(0.66, 0.96)} ${at(0.58, 0.86)}`,
        `C ${at(0.48, 0.98)} ${at(0.28, 0.98)} ${at(0.2, 0.85)} Z`,
      ].join(" ");
    case "speechBubble":
      return polygon([[0, 0], [1, 0], [1, 0.75], [0.42, 0.75], [0.2, 1], [0.25, 0.75], [0, 0.75]]);
    case "chevron":
      return polygon([[0, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0, 1], [0.25, 0.5]]);
    case "rightArrow":
      return polygon([[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]]);
    case "leftArrow":
      return polygon([[1, 0.25], [0.4, 0.25], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.75], [1, 0.75]]);
    case "upArrow":
      return polygon([[0.25, 1], [0.25, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.75, 0.4], [0.75, 1]]);
    case "downArrow":
      return polygon([[0.25, 0], [0.25, 0.6], [0, 0.6], [0.5, 1], [1, 0.6], [0.75, 0.6], [0.75, 0]]);
    default:
      return assertNever(options.preset);
  }
}

/**
 * A freeform outline as one SVG path scaled to an element's box: its filled paths for `part:
 * "fill"`, its stroked ones for `"stroke"`; empty when no path takes that part.
 */
export function customOutlinePath(options: Readonly<{ outline: CustomOutline; width: number; height: number; part: "fill" | "stroke" }>): string {
  const at = (point: OutlinePoint): string => `${round(point.x * options.width)} ${round(point.y * options.height)}`;
  return options.outline.paths
    .filter((path) => (options.part === "fill" ? path.filled : path.stroked))
    .flatMap((path) =>
      path.commands.map((command): string => {
        switch (command.kind) {
          case "move":
            return `M ${at(command.to)}`;
          case "line":
            return `L ${at(command.to)}`;
          case "quadratic":
            return `Q ${at(command.control)} ${at(command.to)}`;
          case "cubic":
            return `C ${at(command.firstControl)} ${at(command.secondControl)} ${at(command.to)}`;
          case "close":
            return "Z";
          default:
            return assertNever(command);
        }
      }),
    )
    .join(" ");
}

/** Where a preset's text sits inside its box (see the header). */
export function presetTextInset(preset: ShapePreset): TextInset {
  switch (preset) {
    case "textBox":
    case "rectangle":
    case "roundedRectangle":
    case "plus":
      return NO_TEXT_INSET;
    case "ellipse":
    case "octagon":
    case "cloud":
      return { top: 0.146, right: 0.146, bottom: 0.146, left: 0.146 };
    case "triangle":
      return { top: 0.5, right: 0.25, bottom: 0, left: 0.25 };
    case "rightTriangle":
      return { top: 0.5, right: 0.5, bottom: 0, left: 0 };
    case "diamond":
      return { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 };
    case "parallelogram":
    case "trapezoid":
    case "hexagon":
      return { top: 0, right: 0.2, bottom: 0, left: 0.2 };
    case "pentagon":
      return { top: 0.2, right: 0.18, bottom: 0, left: 0.18 };
    case "fivePointStar":
      return { top: 0.38, right: 0.31, bottom: 0.25, left: 0.31 };
    case "heart":
      return { top: 0.2, right: 0.2, bottom: 0.3, left: 0.2 };
    case "speechBubble":
      return { top: 0, right: 0, bottom: 0.25, left: 0 };
    case "chevron":
      return { top: 0, right: 0.25, bottom: 0, left: 0.25 };
    case "rightArrow":
    case "leftArrow":
      return { top: 0.25, right: 0.2, bottom: 0.25, left: 0.2 };
    case "upArrow":
    case "downArrow":
      return { top: 0.2, right: 0.25, bottom: 0.2, left: 0.25 };
    default:
      return assertNever(preset);
  }
}

/** Total over ShapePreset: the corner a preset shows while its stored radius is zero. */
const DEFAULT_CORNER_FRACTION: Readonly<Record<ShapePreset, number>> = {
  textBox: 0,
  rectangle: 0,
  roundedRectangle: 1 / 6,
  ellipse: 0,
  triangle: 0,
  rightTriangle: 0,
  diamond: 0,
  parallelogram: 0,
  trapezoid: 0,
  pentagon: 0,
  hexagon: 0,
  octagon: 0,
  fivePointStar: 0,
  plus: 0,
  heart: 0,
  cloud: 0,
  speechBubble: 0,
  chevron: 0,
  rightArrow: 0,
  leftArrow: 0,
  upArrow: 0,
  downArrow: 0,
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function regularPolygon(sides: number): readonly (readonly [number, number])[] {
  const points: (readonly [number, number])[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / sides;
    points.push([0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle) * 1.05 + 0.025]);
  }
  return points;
}

function starPoints(): readonly (readonly [number, number])[] {
  const points: (readonly [number, number])[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? 0.5 : 0.2;
    points.push([0.5 + radius * Math.cos(angle), 0.53 + radius * Math.sin(angle) * 1.06]);
  }
  return points;
}
