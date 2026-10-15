// SLIDE STYLES AS STYLESHEET VALUES: the one place a document style (a `Fill`, a `Border`, a
// `Shadow`, a `RunStyle` ...) becomes the inline declarations the renderer writes. Pure functions
// over values, so the static markup tests can assert exactly what each style feature produces, and
// the three renderer outputs (StaticSlide, the editing canvas, renderSlideMarkup) cannot disagree.
//
// Key decisions:
//
//  * EVERY SLIDE STYLE IS INLINE. The slide root resets inheritance (`all: initial`) and nothing of
//    the chrome stylesheet reaches below it, so the slide looks the same in the editor, the
//    presenter and the transition sandbox, which has no stylesheet of ours at all.
//  * THEME COLOURS RESOLVE HERE, at render time, against the deck theme: an element stores the slot,
//    so changing the theme recolours it without a document write.
//  * DASHES MAP TO THE THREE BORDER STYLES A BOX HAS: dot to dotted; dash, long dash and the
//    dash-dot variants to dashed. Vector shapes and lines get exact patterns through
//    `strokeDashArray`; exact patterns on boxes are a later vector overlay (SPEC.md section 8).
//  * FLIPS COMPOSE BEFORE THE ROTATION in ONE transform (geometry.ts header): `rotate() scale()`
//    applies the scale first, which is the mirror inside the element's own box.

import type { CSSProperties } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ThemeSnapshot } from "../../contracts/document.ts";
import type { Frame } from "../../contracts/geometry.ts";
import type { AssetAddressResolver } from "../../contracts/render.ts";
import type {
  Border,
  Colour,
  CornerRadius,
  DashStyle,
  Fill,
  GradientStop,
  ImageFit,
  NoColour,
  ParagraphStyle,
  RunStyle,
  Shadow,
  Stroke,
  TextAlignment,
  VerticalAlignment,
} from "../../contracts/style.ts";

/** The stylesheet border style each Slides dash becomes on a box (see the header). */
export const BORDER_STYLE_FOR_DASH: Readonly<Record<DashStyle, "solid" | "dotted" | "dashed">> = {
  solid: "solid",
  dot: "dotted",
  dash: "dashed",
  longDash: "dashed",
  dashDot: "dashed",
  longDashDot: "dashed",
};

/** A line height of `lineSpacing` is this multiple of the font size (SPEC.md section 8). */
export const LINE_HEIGHT_PER_LINE_SPACING = 1.2;

/** A drawable colour for a document colour, resolved against the deck theme. */
export function colourValue(colour: Colour, theme: ThemeSnapshot): string {
  switch (colour.kind) {
    case "literal":
      return hexadecimalWithAlpha(colour.hexadecimal, colour.alpha);
    case "theme":
      return hexadecimalWithAlpha(theme.colours[colour.slot], colour.alpha);
    default:
      return assertNever(colour);
  }
}

/** A colour or explicit "no colour" as a drawable value; "none" is transparent. */
export function optionalColourValue(colour: Colour | NoColour, theme: ThemeSnapshot): string {
  switch (colour.kind) {
    case "none":
      return "transparent";
    case "literal":
    case "theme":
      return colourValue(colour, theme);
    default:
      return assertNever(colour);
  }
}

/**
 * How a fill is drawn. A fill that is a plain background lands in `background`; an image fill with
 * its own opacity cannot be a background (a background has no opacity), so it becomes a separate
 * layer. `assetId` names the image a fill refers to, so callers can list what markup references.
 */
export type FillRendering = Readonly<{
  background: CSSProperties;
  imageLayer: CSSProperties | null;
}>;

export function fillRendering(options: Readonly<{ fill: Fill; theme: ThemeSnapshot; assetAddress: AssetAddressResolver }>): FillRendering {
  const fill = options.fill;
  switch (fill.kind) {
    case "none":
      return { background: {}, imageLayer: null };
    case "solid":
      return { background: { backgroundColor: colourValue(fill.colour, options.theme) }, imageLayer: null };
    case "linearGradient":
      return { background: { backgroundImage: linearGradientValue({ angle: fill.angle, stops: fill.stops, theme: options.theme }) }, imageLayer: null };
    case "radialGradient":
      return {
        background: { backgroundImage: radialGradientValue({ centreX: fill.centreX, centreY: fill.centreY, stops: fill.stops, theme: options.theme }) },
        imageLayer: null,
      };
    case "image": {
      const address = options.assetAddress(fill.assetId);
      const image: CSSProperties = address === null ? MISSING_IMAGE_BACKGROUND : { backgroundImage: `url("${address}")`, ...imageFitDeclarations(fill.fit) };
      if (fill.opacity >= 1) return { background: image, imageLayer: null };
      return { background: {}, imageLayer: { position: "absolute", inset: 0, borderRadius: "inherit", opacity: fill.opacity, ...image } };
    }
    default:
      return assertNever(fill);
  }
}

export function linearGradientValue(options: Readonly<{ angle: number; stops: readonly GradientStop[]; theme: ThemeSnapshot }>): string {
  return `linear-gradient(${roundNumber(options.angle)}deg, ${gradientStopsValue(options.stops, options.theme)})`;
}

export function radialGradientValue(options: Readonly<{ centreX: number; centreY: number; stops: readonly GradientStop[]; theme: ThemeSnapshot }>): string {
  return `radial-gradient(ellipse farthest-corner at ${percent(options.centreX)} ${percent(options.centreY)}, ${gradientStopsValue(options.stops, options.theme)})`;
}

/** How an image fill sits in its box. */
export function imageFitDeclarations(fit: ImageFit): CSSProperties {
  switch (fit) {
    case "cover":
      return { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
    case "contain":
      return { backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
    case "stretch":
      return { backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" };
    case "tile":
      return { backgroundSize: "auto", backgroundRepeat: "repeat" };
    default:
      return assertNever(fit);
  }
}

/** Per-side border declarations for a box (the rectangle family, images, table cells). */
export function borderDeclarations(border: Border, theme: ThemeSnapshot): CSSProperties {
  switch (border.kind) {
    case "none":
      return { borderStyle: "none", borderWidth: 0 };
    case "uniform": {
      const side = strokeBorderValue(border.stroke, theme);
      return { borderTop: side, borderRight: side, borderBottom: side, borderLeft: side };
    }
    case "perSide":
      return {
        borderTop: optionalStrokeBorderValue(border.top, theme),
        borderRight: optionalStrokeBorderValue(border.right, theme),
        borderBottom: optionalStrokeBorderValue(border.bottom, theme),
        borderLeft: optionalStrokeBorderValue(border.left, theme),
      };
    default:
      return assertNever(border);
  }
}

/** One side's `border` shorthand; a missing side draws nothing. */
export function optionalStrokeBorderValue(stroke: Stroke | null, theme: ThemeSnapshot): string {
  return stroke === null ? "0 none" : strokeBorderValue(stroke, theme);
}

export function strokeBorderValue(stroke: Stroke, theme: ThemeSnapshot): string {
  return `${roundNumber(stroke.width)}px ${BORDER_STYLE_FOR_DASH[stroke.dash]} ${colourValue(stroke.colour, theme)}`;
}

/** The SVG `stroke-dasharray` of a dash, scaled by the stroke width; undefined for solid. */
export function strokeDashArray(dash: DashStyle, width: number): string | undefined {
  const unit = Math.max(1, width);
  switch (dash) {
    case "solid":
      return undefined;
    case "dot":
      return dashPattern([1, 1.5], unit);
    case "dash":
      return dashPattern([4, 3], unit);
    case "longDash":
      return dashPattern([8, 3], unit);
    case "dashDot":
      return dashPattern([4, 3, 1, 3], unit);
    case "longDashDot":
      return dashPattern([8, 3, 1, 3], unit);
    default:
      return assertNever(dash);
  }
}

/** `border-radius` for a uniform or per-corner radius (top-left, top-right, bottom-right, bottom-left). */
export function cornerRadiusValue(radius: CornerRadius): string {
  switch (radius.kind) {
    case "uniform":
      return `${roundNumber(radius.radius)}px`;
    case "perCorner":
      return [radius.topLeft, radius.topRight, radius.bottomRight, radius.bottomLeft].map((value) => `${roundNumber(value)}px`).join(" ");
    default:
      return assertNever(radius);
  }
}

/** A box's drop shadow (spread included). */
export function boxShadowValue(shadow: Shadow, theme: ThemeSnapshot): string {
  return `${roundNumber(shadow.offsetX)}px ${roundNumber(shadow.offsetY)}px ${roundNumber(shadow.blur)}px ${roundNumber(shadow.spread)}px ${colourValue(shadow.colour, theme)}`;
}

/** A vector shape's drop shadow: a filter has no spread, so it is dropped (as on export). */
export function dropShadowFilterValue(shadow: Shadow, theme: ThemeSnapshot): string {
  return `drop-shadow(${roundNumber(shadow.offsetX)}px ${roundNumber(shadow.offsetY)}px ${roundNumber(shadow.blur / 2)}px ${colourValue(shadow.colour, theme)})`;
}

/** Rotation and flips as ONE transform about the frame's centre; undefined when neither applies. */
export function frameTransformValue(frame: Frame): string | undefined {
  const rotation = frame.rotation === 0 ? null : `rotate(${roundNumber(frame.rotation)}deg)`;
  const flip = frame.flipHorizontal || frame.flipVertical ? `scale(${frame.flipHorizontal ? -1 : 1}, ${frame.flipVertical ? -1 : 1})` : null;
  if (rotation === null && flip === null) return undefined;
  return [rotation, flip].filter((part): part is string => part !== null).join(" ");
}

/** Where a leaf element sits: absolutely, at its unrotated frame, rotated and flipped about its centre. */
export function leafFrameDeclarations(frame: Frame): CSSProperties {
  const transform = frameTransformValue(frame);
  const position: CSSProperties = {
    position: "absolute",
    left: roundNumber(frame.x),
    top: roundNumber(frame.y),
    width: roundNumber(frame.width),
    height: roundNumber(frame.height),
    boxSizing: "border-box",
  };
  return transform === undefined ? position : { ...position, transform };
}

/**
 * The counter-transform of a text layer inside a flipped element: Slides mirrors a shape, never the
 * letters in it, so the text is flipped back inside the mirrored box.
 */
export function textCounterFlipValue(frame: Frame): string | undefined {
  if (!frame.flipHorizontal && !frame.flipVertical) return undefined;
  return `scale(${frame.flipHorizontal ? -1 : 1}, ${frame.flipVertical ? -1 : 1})`;
}

/** A run's inline style; `fontScale` is the shrink-on-overflow factor (1 when the text fits). */
export function runDeclarations(options: Readonly<{ style: RunStyle; theme: ThemeSnapshot; fontScale: number }>): CSSProperties {
  const style = options.style;
  const fontSize = style.fontSize * options.fontScale * BASELINE_SIZE_FACTOR[style.baselineOffset];
  const decorations = [style.underline ? "underline" : null, style.strikethrough ? "line-through" : null].filter((part): part is string => part !== null);
  const declarations: CSSProperties = {
    fontFamily: fontFamilyValue(style.fontFamily),
    fontSize: `${roundNumber(fontSize)}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    color: colourValue(style.colour, options.theme),
    textDecoration: decorations.length === 0 ? "none" : decorations.join(" "),
  };
  const highlight = optionalColourValue(style.highlight, options.theme);
  return {
    ...declarations,
    ...(highlight === "transparent" ? {} : { backgroundColor: highlight }),
    ...(style.baselineOffset === "none" ? {} : { verticalAlign: BASELINE_VERTICAL_ALIGN[style.baselineOffset] }),
    ...(style.letterSpacing === 0 ? {} : { letterSpacing: `${roundNumber(style.letterSpacing * options.fontScale)}px` }),
    ...textCaseDeclarations(style.textCase),
  };
}

/** A paragraph's inline style. `base` is the paragraph's own run style, so an empty line keeps its height. */
export function paragraphDeclarations(options: Readonly<{ style: ParagraphStyle; base: RunStyle; theme: ThemeSnapshot; fontScale: number; listIndent: number }>): CSSProperties {
  const style = options.style;
  const scale = options.fontScale;
  const declarations: CSSProperties = {
    position: "relative",
    margin: 0,
    marginTop: `${roundNumber(style.spaceAbove * scale)}px`,
    marginBottom: `${roundNumber(style.spaceBelow * scale)}px`,
    paddingInlineStart: `${roundNumber((style.indentStart + options.listIndent) * scale)}px`,
    textIndent: `${roundNumber(style.indentFirstLine * scale)}px`,
    textAlign: TEXT_ALIGN[style.alignment],
    direction: style.direction === "rightToLeft" ? "rtl" : "ltr",
    lineHeight: roundNumber(style.lineSpacing * LINE_HEIGHT_PER_LINE_SPACING),
    fontFamily: fontFamilyValue(options.base.fontFamily),
    fontSize: `${roundNumber(options.base.fontSize * scale)}px`,
    color: colourValue(options.base.colour, options.theme),
  };
  return declarations;
}

/** How a text layer stacks its paragraphs for vertical alignment. */
export function verticalJustification(alignment: VerticalAlignment): "flex-start" | "center" | "flex-end" {
  switch (alignment) {
    case "top":
      return "flex-start";
    case "middle":
      return "center";
    case "bottom":
      return "flex-end";
    default:
      return assertNever(alignment);
  }
}

/** A family name as a stylesheet value, quoted, with a generic fallback so missing fonts stay sans. */
export function fontFamilyValue(family: string): string {
  return `"${family.replace(/["\\]/g, "")}", sans-serif`;
}

/** Numbers in styles keep at most three decimals, so markup stays stable and readable. */
export function roundNumber(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  // `-0` would print as "0" anyway, but keep values canonical for equality in tests.
  return rounded === 0 ? 0 : rounded;
}

/** The hatched look of a missing image or a value from a newer version (SPEC.md section 8). */
export const PLACEHOLDER_HATCHING: CSSProperties = {
  backgroundColor: "rgba(120, 128, 150, 0.12)",
  backgroundImage: "repeating-linear-gradient(45deg, rgba(120, 128, 150, 0.35) 0, rgba(120, 128, 150, 0.35) 2px, transparent 2px, transparent 12px)",
  outline: "1px dashed rgba(120, 128, 150, 0.7)",
  outlineOffset: "-1px",
};

const MISSING_IMAGE_BACKGROUND: CSSProperties = PLACEHOLDER_HATCHING;

function hexadecimalWithAlpha(hexadecimal: string, alpha: number): string {
  const normalised = hexadecimal.toLowerCase();
  if (alpha >= 1) return normalised;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(normalised);
  if (match === null) return normalised;
  const red = parseInt(match[1] ?? "0", 16);
  const green = parseInt(match[2] ?? "0", 16);
  const blue = parseInt(match[3] ?? "0", 16);
  return `rgba(${red}, ${green}, ${blue}, ${roundNumber(Math.max(0, alpha))})`;
}

function gradientStopsValue(stops: readonly GradientStop[], theme: ThemeSnapshot): string {
  return stops.map((stop) => `${colourValue(stop.colour, theme)} ${percent(stop.offset)}`).join(", ");
}

function percent(fraction: number): string {
  return `${roundNumber(fraction * 100)}%`;
}

function dashPattern(multiples: readonly number[], unit: number): string {
  return multiples.map((multiple) => roundNumber(multiple * unit)).join(" ");
}

const BASELINE_SIZE_FACTOR: Readonly<Record<RunStyle["baselineOffset"], number>> = { none: 1, superscript: 0.7, subscript: 0.7 };

const BASELINE_VERTICAL_ALIGN: Readonly<Record<RunStyle["baselineOffset"], "baseline" | "super" | "sub">> = {
  none: "baseline",
  superscript: "super",
  subscript: "sub",
};

const TEXT_ALIGN: Readonly<Record<TextAlignment, "start" | "center" | "end" | "justify">> = {
  start: "start",
  centre: "center",
  end: "end",
  justify: "justify",
};

function textCaseDeclarations(textCase: RunStyle["textCase"]): CSSProperties {
  switch (textCase) {
    case "none":
      return {};
    case "smallCaps":
      return { fontVariant: "small-caps" };
    case "allCaps":
      return { textTransform: "uppercase" };
    default:
      return assertNever(textCase);
  }
}
