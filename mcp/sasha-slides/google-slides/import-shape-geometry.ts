/**
 * THE CORNERS OF A ROUNDED SHAPE, which `presentations.get` does not report.
 *
 * Slides draws ROUND_RECTANGLE, ROUND_1_RECTANGLE, ROUND_2_SAME_RECTANGLE and
 * ROUND_2_DIAGONAL_RECTANGLE with an ADJUSTMENT (OOXML's `adj`, `adj1`, `adj2`) that sets the corner
 * radius as a share of the shorter side. The Slides programming interface returns the shape type but
 * never the adjustment, so an import that only reads `presentations.get` must assume the preset's
 * default. That default is rarely what the deck holds: of 416 rounded rectangles in the html2slides
 * complex fixtures only 19 use it, and a near-square card drawn with a 4 pixel corner becomes a pill
 * (67 pixels) when given the default. The adjustment IS in the presentation's pptx export
 * (`<a:prstGeom><a:avLst><a:gd name="adj" fmla="val 7000"/>`), so the importer accepts it per element
 * when the caller has it (`ShapeAdjustmentsByObjectId`) and falls back to the default otherwise.
 *
 * Key decisions:
 *
 *  * RAW GUIDE VALUES. An adjustment is kept as OOXML writes it (100000 = the whole shorter side) and
 *    clamped here exactly as presetShapeDefinitions.xml pins it (0 to 50000), so a caller only parses.
 *  * PER-CORNER RADII FOR THE ONE- AND TWO-CORNER PRESETS. The engine's rounded rectangle already
 *    draws per-corner radii (style.ts `CornerRadius`), and the Google Slides export turns unequal
 *    corners back into these same presets (export-composition.ts), so they need no new engine preset.
 *    Corners are named in the shape's own unflipped, unrotated box: the renderer applies the frame's
 *    flips and rotation to the whole box, corners included, exactly as Slides does.
 *  * A ROUNDED SHAPE WHOSE CORNERS ARE ALL ZERO IS A RECTANGLE. The engine draws a rounded rectangle
 *    with a zero radius at its default sixth (shape-geometry.ts), so a square-cornered ROUND_RECTANGLE
 *    is imported as the rectangle it looks like.
 *
 * AND THE OUTLINE OF A CUSTOM SHAPE, which `presentations.get` does not report either: Google answers
 * a pptx `<a:custGeom>` with no `shapeType` at all (the html2slides funnel's four trapezoids). The
 * export keeps every path, so `customOutlineOf` reads it into the engine's `CustomOutline`:
 *
 *  * POINTS BECOME FRACTIONS OF EACH PATH'S OWN `w` x `h` (the shape's extent when a path states
 *    none), which is how Office stretches a path to its box.
 *  * `arcTo` BECOMES CUBIC CURVES. Its angles are Office's visual angles on the ellipse (LibreOffice
 *    converts them to parametric angles the same way); each quarter turn or less is one cubic, which
 *    is within 0.03% of the radius.
 *  * ANYTHING NOT A PLAIN NUMBER (a point or arc given by a guide name) MAKES THE WHOLE OUTLINE
 *    UNREADABLE (null), so the caller reports the loss instead of drawing half a shape.
 */
import type { CustomOutline, OutlineCommand, OutlinePath, OutlinePoint, ShapePreset } from "../engine/src/contracts/document.ts";
import type { CornerRadius } from "../engine/src/contracts/style.ts";
import { roundUnits } from "./import-text.ts";
import { childNamed, childrenNamed, type XmlElement } from "./pptx-archive.ts";

/** One element's OOXML guide values by name (`adj`, `adj1`, ...), as written: 100000 = the shorter side. */
export type ShapeAdjustments = ReadonlyMap<string, number>;

/** Adjustments by the Slides object id of the element they belong to. */
export type ShapeAdjustmentsByObjectId = ReadonlyMap<string, ShapeAdjustments>;

/** What an OOXML `<p:spPr>` says about a preset outline: its `prst` name and its adjustments. */
export type PresetGeometry = Readonly<{ preset: string; adjustments: ShapeAdjustments }>;

/** The rounded presets this file sizes, by Slides shape type. */
export const ROUNDED_SHAPE_TYPES: readonly string[] = ["ROUND_RECTANGLE", "ROUND_1_RECTANGLE", "ROUND_2_SAME_RECTANGLE", "ROUND_2_DIAGONAL_RECTANGLE"];

/** OOXML's whole: an adjustment of this much is the full shorter side. */
const GUIDE_WHOLE = 100_000;
/** presetShapeDefinitions.xml pins every rounded-corner adjustment to 0..50000. */
const CORNER_GUIDE_MAXIMUM = 50_000;
/** The preset defaults (presetShapeDefinitions.xml `avLst`): a sixth of the shorter side, or square. */
const DEFAULT_CORNER_GUIDE = 16_667;
const SQUARE_CORNER_GUIDE = 0;

/**
 * The preset and adjustments of one `<p:spPr>` (or any XML holding one `<a:prstGeom>`); null for a
 * custom outline (`<a:custGeom>`) or no geometry at all. Guides that are not a plain `val <number>`
 * formula are left out, so the preset's default applies to them.
 */
export function presetGeometryOf(shapePropertiesXml: string): PresetGeometry | null {
  const geometry = /<a:prstGeom\b[^>]*\bprst="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/a:prstGeom>)/.exec(shapePropertiesXml);
  if (geometry === null) return null;
  const adjustments = new Map<string, number>();
  for (const guide of (geometry[2] ?? "").matchAll(/<a:gd\b([^>]*)\/?>/g)) {
    const attributes = guide[1] ?? "";
    const name = /\bname="([^"]+)"/.exec(attributes)?.[1];
    const value = /\bfmla="val\s+(-?\d+(?:\.\d+)?)"/.exec(attributes)?.[1];
    if (name !== undefined && value !== undefined) adjustments.set(name, Number(value));
  }
  return { preset: geometry[1] ?? "", adjustments };
}

/**
 * The engine preset and corner radii of a rounded Slides shape type, sized from its adjustments
 * (or the preset defaults when `adjustments` is null); null for every other shape type.
 */
export function roundedShapeOf(
  options: Readonly<{ shapeType: string; width: number; height: number; adjustments: ShapeAdjustments | null }>,
): Readonly<{ preset: ShapePreset; cornerRadius: CornerRadius }> | null {
  const shorterSide = Math.max(0, Math.min(options.width, options.height));
  const radiusOf = (name: string, fallback: number): number => {
    const guide = options.adjustments?.get(name);
    const pinned = Math.min(CORNER_GUIDE_MAXIMUM, Math.max(0, guide !== undefined && Number.isFinite(guide) ? guide : fallback));
    return roundUnits((shorterSide * pinned) / GUIDE_WHOLE);
  };
  let cornerRadius: CornerRadius;
  switch (options.shapeType) {
    case "ROUND_RECTANGLE":
      cornerRadius = { kind: "uniform", radius: radiusOf("adj", DEFAULT_CORNER_GUIDE) };
      break;
    case "ROUND_1_RECTANGLE": {
      // round1Rect rounds the top-right corner only.
      const radius = radiusOf("adj", DEFAULT_CORNER_GUIDE);
      cornerRadius = { kind: "perCorner", topLeft: 0, topRight: radius, bottomRight: 0, bottomLeft: 0 };
      break;
    }
    case "ROUND_2_SAME_RECTANGLE": {
      // round2SameRect: adj1 rounds the top pair, adj2 the bottom pair.
      const top = radiusOf("adj1", DEFAULT_CORNER_GUIDE);
      const bottom = radiusOf("adj2", SQUARE_CORNER_GUIDE);
      cornerRadius = { kind: "perCorner", topLeft: top, topRight: top, bottomRight: bottom, bottomLeft: bottom };
      break;
    }
    case "ROUND_2_DIAGONAL_RECTANGLE": {
      // round2DiagRect: adj1 rounds top-left and bottom-right, adj2 top-right and bottom-left.
      const leading = radiusOf("adj1", DEFAULT_CORNER_GUIDE);
      const trailing = radiusOf("adj2", SQUARE_CORNER_GUIDE);
      cornerRadius = { kind: "perCorner", topLeft: leading, topRight: trailing, bottomRight: leading, bottomLeft: trailing };
      break;
    }
    default:
      return null;
  }
  const square = cornerRadius.kind === "uniform" ? cornerRadius.radius === 0 : [cornerRadius.topLeft, cornerRadius.topRight, cornerRadius.bottomRight, cornerRadius.bottomLeft].every((radius) => radius === 0);
  return square ? { preset: "rectangle", cornerRadius: { kind: "uniform", radius: 0 } } : { preset: "roundedRectangle", cornerRadius };
}

/**
 * The engine outline of one `<a:custGeom>`; null when it has no path or any value is not a plain
 * number (see the header). `extent` is the shape's `<a:ext cx cy>`, used by a path with no size.
 */
export function customOutlineOf(options: Readonly<{ geometry: XmlElement; extent: Readonly<{ width: number; height: number }> }>): CustomOutline | null {
  const paths: OutlinePath[] = [];
  for (const path of childrenNamed(childNamed(options.geometry, "a:pathLst"), "a:path")) {
    const read = outlinePathOf({ path, extent: options.extent });
    if (read === null) return null;
    paths.push(read);
  }
  return paths.length === 0 ? null : { paths };
}

/** ECMA-376 20.1.9.15: `fill` defaults to "norm" (filled), `stroke` to true. */
function outlinePathOf(options: Readonly<{ path: XmlElement; extent: Readonly<{ width: number; height: number }> }>): OutlinePath | null {
  const { path } = options;
  const width = numberAttribute(path, "w") ?? 0;
  const height = numberAttribute(path, "h") ?? 0;
  const spanX = width > 0 ? width : options.extent.width;
  const spanY = height > 0 ? height : options.extent.height;
  if (!(spanX > 0) || !(spanY > 0)) return null;
  const fraction = (point: Readonly<{ x: number; y: number }>): OutlinePoint => ({ x: roundFraction(point.x / spanX), y: roundFraction(point.y / spanY) });
  const commands: OutlineCommand[] = [];
  let current = { x: 0, y: 0 };
  let start = current;
  for (const command of path.children) {
    const points = childrenNamed(command, "a:pt").map(pointOf);
    if (points.some((point) => point === null)) return null;
    const [first, second, third] = points.filter((point): point is Readonly<{ x: number; y: number }> => point !== null);
    switch (command.name) {
      case "a:moveTo":
        if (first === undefined) return null;
        commands.push({ kind: "move", to: fraction(first) });
        current = first;
        start = first;
        break;
      case "a:lnTo":
        if (first === undefined) return null;
        commands.push({ kind: "line", to: fraction(first) });
        current = first;
        break;
      case "a:quadBezTo":
        if (first === undefined || second === undefined) return null;
        commands.push({ kind: "quadratic", control: fraction(first), to: fraction(second) });
        current = second;
        break;
      case "a:cubicBezTo":
        if (first === undefined || second === undefined || third === undefined) return null;
        commands.push({ kind: "cubic", firstControl: fraction(first), secondControl: fraction(second), to: fraction(third) });
        current = third;
        break;
      case "a:arcTo": {
        const arc = arcCurvesOf({ from: current, command });
        if (arc === null) return null;
        for (const curve of arc.curves) commands.push({ kind: "cubic", firstControl: fraction(curve.firstControl), secondControl: fraction(curve.secondControl), to: fraction(curve.to) });
        current = arc.end;
        break;
      }
      case "a:close":
        commands.push({ kind: "close" });
        current = start;
        break;
      default:
        // An element Office does not define inside a path; nothing to draw.
        break;
    }
  }
  if (commands.length === 0) return null;
  const fill = path.attributes.get("fill");
  const stroke = path.attributes.get("stroke");
  return { commands, filled: fill !== "none", stroked: stroke !== "0" && stroke !== "false" };
}

type PathPoint = Readonly<{ x: number; y: number }>;
type CubicCurve = Readonly<{ firstControl: PathPoint; secondControl: PathPoint; to: PathPoint }>;

/** Office angles are sixty-thousandths of a degree. */
const OFFICE_DEGREE_UNITS = 60_000;
/** The largest turn one cubic curve approximates. */
const QUARTER_TURN = Math.PI / 2;

/**
 * `<a:arcTo wR hR stAng swAng>` from the current point as cubic curves. The current point lies on
 * the ellipse at the start angle; both angles are visual (measured to the point as drawn), so each
 * becomes the ellipse's parametric angle `atan2(wR sin a, hR cos a)` before the curves are made.
 */
function arcCurvesOf(options: Readonly<{ from: PathPoint; command: XmlElement }>): Readonly<{ curves: readonly CubicCurve[]; end: PathPoint }> | null {
  const radiusX = numberAttribute(options.command, "wR");
  const radiusY = numberAttribute(options.command, "hR");
  const startAngle = numberAttribute(options.command, "stAng");
  const swingAngle = numberAttribute(options.command, "swAng");
  if (radiusX === null || radiusY === null || startAngle === null || swingAngle === null) return null;
  if (radiusX <= 0 || radiusY <= 0 || swingAngle === 0) return { curves: [], end: options.from };
  const visualStart = (startAngle / OFFICE_DEGREE_UNITS) * (Math.PI / 180);
  const visualSwing = (swingAngle / OFFICE_DEGREE_UNITS) * (Math.PI / 180);
  const parametric = (visual: number): number => Math.atan2(radiusX * Math.sin(visual), radiusY * Math.cos(visual));
  const parametricStart = parametric(visualStart);
  let parametricSwing = parametric(visualStart + visualSwing) - parametricStart;
  if (Math.abs(visualSwing) >= 2 * Math.PI) parametricSwing = Math.sign(visualSwing) * 2 * Math.PI;
  else if (visualSwing > 0 && parametricSwing <= 0) parametricSwing += 2 * Math.PI;
  else if (visualSwing < 0 && parametricSwing >= 0) parametricSwing -= 2 * Math.PI;
  const centre = { x: options.from.x - radiusX * Math.cos(parametricStart), y: options.from.y - radiusY * Math.sin(parametricStart) };
  const on = (angle: number): PathPoint => ({ x: centre.x + radiusX * Math.cos(angle), y: centre.y + radiusY * Math.sin(angle) });
  const tangent = (angle: number, length: number): PathPoint => ({ x: -radiusX * Math.sin(angle) * length, y: radiusY * Math.cos(angle) * length });
  const pieces = Math.max(1, Math.ceil(Math.abs(parametricSwing) / QUARTER_TURN - 1e-9));
  const step = parametricSwing / pieces;
  const handle = (4 / 3) * Math.tan(step / 4);
  const curves: CubicCurve[] = [];
  for (let piece = 0; piece < pieces; piece++) {
    const from = parametricStart + piece * step;
    const to = from + step;
    const startPoint = on(from);
    const endPoint = on(to);
    const startHandle = tangent(from, handle);
    const endHandle = tangent(to, handle);
    curves.push({
      firstControl: { x: startPoint.x + startHandle.x, y: startPoint.y + startHandle.y },
      secondControl: { x: endPoint.x - endHandle.x, y: endPoint.y - endHandle.y },
      to: endPoint,
    });
  }
  return { curves, end: on(parametricStart + parametricSwing) };
}

function pointOf(point: XmlElement): PathPoint | null {
  const x = numberAttribute(point, "x");
  const y = numberAttribute(point, "y");
  return x === null || y === null ? null : { x, y };
}

/** A plain integer or decimal attribute; null when absent or a guide name. */
function numberAttribute(element: XmlElement, name: string): number | null {
  const value = element.attributes.get(name);
  if (value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  return Number(value);
}

/** A millionth of the box: far below a pixel on any slide. Adding 0 turns the -0 a cosine leaves into 0. */
function roundFraction(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000 + 0;
}
