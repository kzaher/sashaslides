/**
 * THE COMPOSITION PATH: an engine box Slides cannot express natively (per-side borders, per-corner
 * radii, a shadow) is adapted into the converter's extraction type and emitted by the converter's
 * pure `emitSlideRequests` (SPEC.md 21.12), which already draws per-side borders as edge lines,
 * picks the ROUND_1 / ROUND_2 presets per corner, and reports what it approximated as
 * `UnsupportedFeature`s, which become losses here.
 *
 * WHY THE ADAPTATION IS EXACT: the converter's extraction is stylesheet pixels in a 1280-wide viewport,
 * and engine units are exactly that (geometry.ts: the slide is 1280 units wide), so a frame crosses
 * without scaling. A rotated frame passes its axis-aligned bounds plus its own size and angle, the
 * pair `placeRotatedBox` solves from.
 *
 * The box's TEXT does not go through the converter (its text model is stylesheet runs); it goes on a
 * borderless native text box on top, with the same frame, built by the native path.
 */
import { emitSlideRequests } from "../converter/emit-requests.ts";
import type { Border as ConverterBorder, BorderSide, BoxDecoration, Paint, RectElement } from "../converter/extraction.ts";
import { describeUnsupportedFeature } from "../converter/unsupported-feature.ts";
import type { ThemeSnapshot } from "../engine/src/contracts/document.ts";
import { rotatedBounds, type Frame } from "../engine/src/contracts/geometry.ts";
import type { BoxStyle, CornerRadius, DashStyle, Fill, Stroke } from "../engine/src/contracts/style.ts";
import { hexadecimalOfColour } from "./export-colours.ts";
import type { PageScale } from "./interchange-geometry.ts";
import type { InterchangeLossSink } from "./interchange-losses.ts";
import type { ExportRequest } from "./slides-requests.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

/** True when a box needs the composition path rather than one native shape. */
export function needsComposition(box: BoxStyle): boolean {
  return borderIsPerSide(box.border) || cornerRadiiOf(box.cornerRadius).some((radius, _, radii) => radius !== radii[0]) || box.shadow !== null;
}

/** The four radii clockwise from the top-left, whichever form the box stores. */
export function cornerRadiiOf(radius: CornerRadius): readonly [number, number, number, number] {
  switch (radius.kind) {
    case "uniform":
      return [radius.radius, radius.radius, radius.radius, radius.radius];
    case "perCorner":
      return [radius.topLeft, radius.topRight, radius.bottomRight, radius.bottomLeft];
    default:
      return assertNever(radius);
  }
}


export function composedBoxRequests(
  options: Readonly<{
    box: BoxStyle;
    frame: Frame;
    pageObjectId: string;
    /** A per-element prefix, unique in the presentation: every object the converter creates starts with it. */
    objectIdPrefix: string;
    theme: ThemeSnapshot;
    scale: PageScale;
    losses: InterchangeLossSink;
  }>,
): Readonly<{ requests: readonly ExportRequest[]; createdObjectIds: readonly string[] }> {
  const { box, frame, theme, losses } = options;
  const bounds = rotatedBounds(frame);
  const element: RectElement = {
    kind: "rect",
    bounds: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
    domIndex: null,
    rotateDeg: frame.rotation,
    naturalSizePx: { w: frame.width, h: frame.height },
    opacity: box.opacity,
    paintIndex: 0,
    stackZ: null,
    decoration: decorationOf({ box, theme, losses }),
  };
  const emitted = emitSlideRequests({
    extraction: { viewportPx: { w: 1280, h: options.scale.pageHeight }, elements: [element], malformedCount: 0 },
    pageObjectId: options.pageObjectId,
    objectIdPrefix: options.objectIdPrefix,
    pageSizeEmu: { widthEmu: options.scale.pageWidthEnglishMetricUnits, heightEmu: options.scale.pageHeightEnglishMetricUnits },
  });
  for (const feature of emitted.unsupported) losses.add({ feature: feature.kind, detail: describeUnsupportedFeature(feature) });
  if (frame.flipHorizontal || frame.flipVertical) losses.add({ feature: "flip", detail: "A composed box was exported without its mirror image." });
  return { requests: emitted.requests, createdObjectIds: createdIdsOf(emitted.requests) };
}

function borderIsPerSide(border: BoxStyle["border"]): boolean {
  switch (border.kind) {
    case "perSide":
      return true;
    case "none":
    case "uniform":
      return false;
    default:
      return assertNever(border);
  }
}

function decorationOf(options: Readonly<{ box: BoxStyle; theme: ThemeSnapshot; losses: InterchangeLossSink }>): BoxDecoration {
  const { box, theme, losses } = options;
  const paintOf = (stroke: Stroke | null): BorderSide => ({
    widthPx: stroke === null ? 0 : stroke.width,
    hex: stroke === null ? null : hexadecimalOfColour({ colour: stroke.colour, theme, losses }),
    style: stroke === null ? "none" : STYLESHEET_BORDER_STYLE[stroke.dash],
  });
  let border: ConverterBorder | null = null;
  switch (box.border.kind) {
    case "none":
      break;
    case "uniform": {
      const side = paintOf(box.border.stroke);
      border = { widthPx: side.widthPx, hex: side.hex, style: side.style, uniform: true, sides: { top: side, right: side, bottom: side, left: side } };
      break;
    }
    case "perSide": {
      const sides = { top: paintOf(box.border.top), right: paintOf(box.border.right), bottom: paintOf(box.border.bottom), left: paintOf(box.border.left) };
      const widest = Math.max(sides.top.widthPx, sides.right.widthPx, sides.bottom.widthPx, sides.left.widthPx);
      border = { widthPx: widest, hex: sides.top.hex, style: sides.top.style, uniform: false, sides };
      break;
    }
    default:
      assertNever(box.border);
  }
  const cornerRadiiPx = cornerRadiiOf(box.cornerRadius);
  return {
    fill: fillPaint({ fill: box.fill, theme, losses }),
    gradient: null,
    border,
    cornerRadiiPx,
    shadow: box.shadow === null ? null : { offsetXPx: box.shadow.offsetX, offsetYPx: box.shadow.offsetY, blurPx: box.shadow.blur, spreadPx: box.shadow.spread, ringCount: 0 },
    backgroundImage: null,
    clipPath: null,
  };
}

/** A fill as the converter's one solid paint; gradients and pictures are reduced by the native path's rules. */
function fillPaint(options: Readonly<{ fill: Fill; theme: ThemeSnapshot; losses: InterchangeLossSink }>): Paint | null {
  const { fill, theme, losses } = options;
  switch (fill.kind) {
    case "none":
      return null;
    case "solid":
      return { hex: hexadecimalOfColour({ colour: fill.colour, theme, losses }), alpha: fill.colour.alpha };
    case "linearGradient":
    case "radialGradient": {
      const first = fill.stops[0];
      losses.add({ feature: fill.kind, detail: "Google Slides cannot fill a shape with a gradient; it shows the gradient's first colour." });
      return first === undefined ? null : { hex: hexadecimalOfColour({ colour: first.colour, theme, losses }), alpha: first.colour.alpha };
    }
    case "image":
      losses.add({ feature: "pictureFill", detail: "The programming interface cannot fill a shape with a picture; the shape was exported without its fill." });
      return null;
    default:
      return assertNever(fill);
  }
}

/** stylesheet border styles the converter maps to Slides dashes (slides-paint.ts dashStyleFromCss). */
const STYLESHEET_BORDER_STYLE: Readonly<Record<DashStyle, string>> = {
  solid: "solid",
  dot: "dotted",
  dash: "dashed",
  dashDot: "dashed",
  longDash: "dashed",
  longDashDot: "dashed",
};

function createdIdsOf(requests: readonly ExportRequest[]): readonly string[] {
  const ids: string[] = [];
  for (const request of requests) {
    if ("createShape" in request) ids.push(request.createShape.objectId);
    else if ("createLine" in request) ids.push(request.createLine.objectId);
    else if ("createImage" in request) ids.push(request.createImage.objectId);
    else if ("createTable" in request) ids.push(request.createTable.objectId);
  }
  return ids;
}
