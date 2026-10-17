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
//  * A LINE SITS WHERE GOOGLE SLIDES PUTS IT: extra line spacing goes below the glyphs, not half
//    above, and the baseline offset does not depend on the family (text-vertical-metrics.ts has the
//    measurements). A paragraph's runs sit in ONE span carrying the base run's typography and line
//    box; a run states only what differs from it, and only a run larger than the base moves its
//    own box, so exported HTML stays editable.
//  * FLIPS COMPOSE BEFORE THE ROTATION in ONE transform (geometry.ts header): `rotate() scale()`
//    applies the scale first, which is the mirror inside the element's own box.

import type { CSSProperties } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ThemeSnapshot } from "../../contracts/document.ts";
import type { Frame } from "../../contracts/geometry.ts";
import type { AssetAddressResolver } from "../../contracts/render.ts";
import { parseHexadecimalColour } from "../../shared/colour-text.ts";
import { roundTo } from "../../shared/numbers.ts";
import { fontFamilyValue } from "./font-families.ts";
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
import { LINE_BOX_PER_LINE_SPACING, paragraphLineDropEm, strutLineHeight, stylesheetBaselineInLineBox } from "./text-vertical-metrics.ts";

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
export const LINE_HEIGHT_PER_LINE_SPACING = LINE_BOX_PER_LINE_SPACING;

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

/**
 * The ONE span a paragraph's runs sit in, carrying the paragraph's base run (see the header): its
 * family, size, weight, style and colour, and the line box Google draws (runLineBoxDeclarations).
 * Every run inherits all of it, so a run in the paragraph's own style is a bare span and an HTML
 * editor can type into the paragraph without breaking a line apart. Exactly the declarations every
 * run used to repeat, so the paragraph draws as it always did.
 */
export function paragraphRunsDeclarations(options: Readonly<{ base: RunStyle; lineSpacing: number; theme: ThemeSnapshot; fontScale: number }>): CSSProperties {
  return {
    ...baseTypography({ base: options.base, theme: options.theme, fontScale: options.fontScale }),
    ...lineBoxDeclarations({ family: options.base.fontFamily, lineSpacing: options.lineSpacing }),
  };
}

/**
 * Whether a run's line box lies inside the paragraph span's: a run no taller above or below the
 * baseline than the base run (a smaller size, a code font) cannot change its line, so it needs no
 * placement of its own and its glyphs simply sit on the span's baseline. Only a run that reaches
 * past the span's box (a BIG word) is moved, by the difference of the two drops.
 */
export function runFitsParagraphSpan(options: Readonly<{ style: RunStyle; base: RunStyle; lineSpacing: number }>): boolean {
  const extent = (style: RunStyle): Readonly<{ above: number; below: number }> => {
    const halfLine = (LINE_HEIGHT_PER_LINE_SPACING * options.lineSpacing) / 2;
    const centre = stylesheetBaselineInLineBox(style.fontFamily) - LINE_HEIGHT_PER_LINE_SPACING / 2;
    return { above: style.fontSize * (halfLine + centre), below: style.fontSize * (halfLine - centre) };
  };
  const run = extent(options.style);
  const span = extent(options.base);
  return run.above <= span.above && run.below <= span.below;
}

/**
 * A run's inline style inside its paragraph's span: only what differs from the base run.
 * Decoration and highlight are never inherited (an underline could not be taken off one run), so a
 * run states them itself. `fontScale` is the shrink-on-overflow factor (1 when the text fits).
 */
export function runDeclarations(options: Readonly<{ style: RunStyle; base: RunStyle; lineSpacing: number; theme: ThemeSnapshot; fontScale: number }>): CSSProperties {
  const style = options.style;
  const own = runTypography({ style, theme: options.theme, fontScale: options.fontScale });
  const inherited = baseTypography({ base: options.base, theme: options.theme, fontScale: options.fontScale });
  const differing = Object.fromEntries(INHERITED_TYPOGRAPHY.filter((key) => own[key] !== inherited[key]).map((key) => [key, own[key]]));
  const decorations = [style.underline ? "underline" : null, style.strikethrough ? "line-through" : null].filter((part): part is string => part !== null);
  const highlight = optionalColourValue(style.highlight, options.theme);
  return {
    ...differing,
    ...(decorations.length === 0 ? {} : { textDecoration: decorations.join(" ") }),
    ...(highlight === "transparent" ? {} : { backgroundColor: highlight }),
    ...runLineBoxDeclarations({ style, base: options.base, lineSpacing: options.lineSpacing, fontScale: options.fontScale }),
    ...(style.letterSpacing === 0 ? {} : { letterSpacing: `${roundNumber(style.letterSpacing * options.fontScale)}px` }),
    ...textCaseDeclarations(style.textCase),
  };
}

/** A list marker's inline style: the paragraph's base run with its line box, in a box of its own. */
export function markerRunDeclarations(options: Readonly<{ base: RunStyle; lineSpacing: number; theme: ThemeSnapshot; fontScale: number }>): CSSProperties {
  return {
    ...runTypography({ style: options.base, theme: options.theme, fontScale: options.fontScale }),
    textDecoration: "none",
    ...lineBoxDeclarations({ family: options.base.fontFamily, lineSpacing: options.lineSpacing }),
    ...(options.base.letterSpacing === 0 ? {} : { letterSpacing: `${roundNumber(options.base.letterSpacing * options.fontScale)}px` }),
    ...textCaseDeclarations(options.base.textCase),
  };
}

/** A paragraph's inline style. `base` is the paragraph's own run style, so an empty line keeps its height. */
export function paragraphDeclarations(options: Readonly<{ style: ParagraphStyle; base: RunStyle; theme: ThemeSnapshot; fontScale: number; listIndent: number }>): CSSProperties {
  const style = options.style;
  const scale = options.fontScale;
  const spacing = style.lineSpacing;
  return {
    position: "relative",
    margin: 0,
    marginTop: `${roundNumber(style.spaceAbove * scale)}px`,
    marginBottom: `${roundNumber(style.spaceBelow * scale)}px`,
    paddingInlineStart: `${roundNumber((style.indentStart + options.listIndent) * scale)}px`,
    textIndent: `${roundNumber(style.indentFirstLine * scale)}px`,
    textAlign: TEXT_ALIGN[style.alignment],
    direction: style.direction === "rightToLeft" ? "rtl" : "ltr",
    // The strut never reaches above a run's box; an empty paragraph keeps one full line through min-height.
    lineHeight: roundNumber(strutLineHeight({ lineSpacing: spacing, family: options.base.fontFamily })),
    minHeight: `${roundNumber(spacing * LINE_HEIGHT_PER_LINE_SPACING)}em`,
    fontFamily: fontFamilyValue(options.base.fontFamily),
    fontSize: `${roundNumber(options.base.fontSize * scale)}px`,
    color: colourValue(options.base.colour, options.theme),
  };
}

/** The typography the paragraph's span declares and its runs inherit. */
const INHERITED_TYPOGRAPHY = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "color"] as const;

type Typography = Readonly<Pick<CSSProperties, (typeof INHERITED_TYPOGRAPHY)[number]>>;

function runTypography(options: Readonly<{ style: RunStyle; theme: ThemeSnapshot; fontScale: number }>): Typography {
  const style = options.style;
  return {
    fontFamily: fontFamilyValue(style.fontFamily),
    fontSize: `${roundNumber(style.fontSize * options.fontScale * BASELINE_SIZE_FACTOR[style.baselineOffset])}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    color: colourValue(style.colour, options.theme),
  };
}

/** The base run's typography at its full size: a superscript first run still sets the line's size. */
function baseTypography(options: Readonly<{ base: RunStyle; theme: ThemeSnapshot; fontScale: number }>): Typography {
  return runTypography({ style: { ...options.base, baselineOffset: "none" }, theme: options.theme, fontScale: options.fontScale });
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

/** Numbers in styles keep at most three decimals, so markup stays stable and readable. */
export function roundNumber(value: number): number {
  return roundTo(value, 3);
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
  const parsed = parseHexadecimalColour(normalised);
  if (parsed === null) return normalised;
  return `rgba(${parsed.red}, ${parsed.green}, ${parsed.blue}, ${roundNumber(Math.max(0, alpha))})`;
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

/**
 * A line box placed the way Google places a line (text-vertical-metrics.ts): `lineSpacing` x 1.2
 * of the box's own size tall, lowered so its top is Google's baseline offset above the baseline,
 * and its glyphs raised back onto the line's baseline. Both moves are one length in em of the
 * box's size, so shrink-on-overflow scales them with the font. The line height is unitless, so a
 * run inside the paragraph's span gets a box of its own size.
 */
function lineBoxDeclarations(options: Readonly<{ family: string; lineSpacing: number }>): CSSProperties {
  const shift = `${roundNumber(-writtenDropEm(options))}em`;
  return {
    lineHeight: Math.round(LINE_HEIGHT_PER_LINE_SPACING * roundNumber(options.lineSpacing) * 1e6) / 1e6,
    verticalAlign: shift,
    position: "relative",
    top: shift,
  };
}

/**
 * A run's own placement inside the paragraph's span. A superscript or subscript keeps the
 * stylesheet's raise and takes no room: Google's lines ignore them too. A run whose box fits the
 * span's needs nothing (runFitsParagraphSpan). A larger run is lowered by the difference between
 * its drop and the base's, so its box is placed as its own drop places it, and its glyphs raised
 * back onto the line's baseline: a BIG word sets its line's height as in Google Slides.
 */
function runLineBoxDeclarations(options: Readonly<{ style: RunStyle; base: RunStyle; lineSpacing: number; fontScale: number }>): CSSProperties {
  const style = options.style;
  if (style.baselineOffset !== "none") return { verticalAlign: BASELINE_VERTICAL_ALIGN[style.baselineOffset], lineHeight: 0 };
  if (runFitsParagraphSpan({ style, base: options.base, lineSpacing: options.lineSpacing })) return {};
  const own = writtenDropEm({ family: style.fontFamily, lineSpacing: options.lineSpacing }) * style.fontSize * options.fontScale;
  const paragraph = writtenDropEm({ family: options.base.fontFamily, lineSpacing: options.lineSpacing }) * options.base.fontSize * options.fontScale;
  const shift = roundNumber(own - paragraph);
  if (shift === 0) return {};
  return { verticalAlign: `${-shift}px`, position: "relative", top: `${-shift}px` };
}

/**
 * How far a stylesheet's line box must move down for Google's baseline (text-vertical-metrics.ts),
 * in em of the box's size: the family's offset plus the paragraph's share, each to a thousandth as
 * the renderer has always written them.
 */
function writtenDropEm(options: Readonly<{ family: string; lineSpacing: number }>): number {
  return roundNumber(stylesheetBaselineInLineBox(options.family)) + roundNumber(paragraphLineDropEm(options.lineSpacing));
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
