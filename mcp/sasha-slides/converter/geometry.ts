/**
 * geometry.ts — CSS px to Slides EMU, and the measured Slides layout laws.
 *
 * The constants in here are NOT guesses and must not be re-derived. They come
 * from the closed-loop fuzz harness described in CLAUDE.md ("Google Slides
 * table layout — reverse-engineered model (measured, not guessed)"), validated
 * cross-seed on 701 points with held-out row RMSE 1.02 px (R² 0.998) and column
 * RMSE 1.31 px (R² 0.9999). Train ≈ test, so there is no overfit to undo.
 *
 * The practical consequence, also from CLAUDE.md: Google honours specified
 * geometry to about a pixel (origin offset -0.4 ± 0.85 px, width +1.8 ± 2.5 px,
 * column slope 1.003). So a multi-pixel misfit on a real slide is this
 * converter's own arithmetic, never Google re-rasterising — which is why the
 * inverse functions below exist at all: specify the number that *renders* to
 * the measured CSS box, rather than specifying the measured box and hoping.
 */
import type { AffineTransform, Dimension, PageElementProperties, Size } from "./slides-api.js";
import type { BoundsPx, SizePx } from "./extraction.js";
import type { FractionalRegion } from "./unsupported-feature.js";

/** English Metric Units per inch — the unit every Slides magnitude is emitted in. */
export const EMU_PER_INCH = 914400;

/** EMU per PostScript point; a CSS px at 96 dpi is 0.75 pt. */
export const EMU_PER_POINT = 12700;

/**
 * Google's default 16:9 page: 10in x 5.625in. A 1280x720 slide document maps
 * onto it at exactly 7143.75 EMU/px on both axes, which is why PROTOCOL.md can
 * fix the slide HTML at 1280x720 and still land square on the page.
 */
export const DEFAULT_PAGE_SIZE_EMU: SlidePageSizeEmu = {
  widthEmu: 9144000,
  heightEmu: 5143500,
};

export type SlidePageSizeEmu = Readonly<{ widthEmu: number; heightEmu: number }>;

/**
 * `line-height: normal` as Slides rasterises it: 1.197 x font size. This is the
 * same number the pptx path uses (convert-pptx-lib.ts:532, `SLIDES_NORMAL_LH`),
 * measured rather than assumed to be CSS's nominal 1.2.
 */
export const SLIDES_NORMAL_LINE_BOX = 1.197;

/**
 * Default text insets on a Slides shape, in EMU: 9 CSS px (0.09375in) on ALL
 * FOUR edges. `ShapeProperties` has NO inset field, so these cannot be set and
 * must be compensated for geometrically — a text box is created larger than the
 * HTML box by exactly these amounts so the text's content edge lands where the
 * HTML put it.
 *
 * MEASURED against the live API, not documented: see
 * `calibration/measure-text-inset.ts`. The documented PowerPoint defaults
 * (0.1in horizontal, 0.05in vertical) that this constant used to hold are BOTH
 * wrong for Slides, and the vertical one is wrong by a factor of two.
 *
 * `presentations.get` reports no inset, so the inset is only observable as a
 * displacement of rendered ink. Each edge was read as the intercept of a
 * straight line through 6-7 font sizes (the glyph bearing and the line-box
 * half-leading scale with the font; the inset does not). Two independent runs:
 *
 *     edge     run A (10-40pt)   run B (8-36pt)
 *     left         85398             85226
 *     right        85509             85270
 *     top          84433             84837
 *     bottom       83584             85778
 *     pooled                   85065 +- 482 EMU  (8.93 css px)
 *
 * All four edges agree, so this is one number, and 9 px = 85725 EMU sits +1.4
 * sigma from the pooled estimate while 0.1in = 91440 sits +13 sigma and 0.05in
 * = 45720 sits -82 sigma. The remaining ~0.05 px shortfall is the known bias of
 * reading an anti-aliased edge as linear coverage, so the round CSS-pixel value
 * is taken as the truth. End-to-end check on a live slide, text aimed at a known
 * point: the old constants landed it -0.69 px horizontally and +4.09 px
 * vertically off; these land it within 0.1 px on both axes.
 *
 * Still injectable through `EmitOptions.textInsetEmu`, which is how the
 * calibration run compares candidates.
 */
export const DEFAULT_TEXT_INSET_EMU: TextInsetEmu = {
  left: 85725,
  right: 85725,
  top: 85725,
  bottom: 85725,
};

export type TextInsetEmu = Readonly<{
  left: number;
  right: number;
  top: number;
  bottom: number;
}>;

/** px to EMU for one specific slide document / page pairing. */
export type PageScale = Readonly<{
  emuPerPx: number;
  pageSizeEmu: SlidePageSizeEmu;
  viewportPx: SizePx;
}>;

export function pageScaleFor(
  options: Readonly<{ viewportPx: SizePx; pageSizeEmu: SlidePageSizeEmu }>,
): PageScale {
  const { viewportPx, pageSizeEmu } = options;
  const width = viewportPx.w > 0 ? viewportPx.w : 1280;
  return { emuPerPx: pageSizeEmu.widthEmu / width, pageSizeEmu, viewportPx };
}

export function emu(valuePx: number, scale: PageScale): number {
  return Math.round(valuePx * scale.emuPerPx);
}

export function emuDimension(valuePx: number, scale: PageScale): Dimension {
  return { magnitude: emu(valuePx, scale), unit: "EMU" };
}

export function emuSize(box: SizePx, scale: PageScale): Size {
  // Slides rejects a zero or negative extent, so collapse to one whole EMU.
  return {
    width: { magnitude: Math.max(1, emu(box.w, scale)), unit: "EMU" },
    height: { magnitude: Math.max(1, emu(box.h, scale)), unit: "EMU" },
  };
}

/**
 * Place a box with no rotation. `scaleX`/`scaleY` stay at 1 and the size
 * carries the extent, which keeps the element's own coordinate space in EMU and
 * makes later hand-editing in Slides behave normally.
 */
export function placeBox(
  options: Readonly<{ bounds: BoundsPx; pageObjectId: string; scale: PageScale }>,
): PageElementProperties {
  const { bounds, pageObjectId, scale } = options;
  return {
    pageObjectId,
    size: emuSize({ w: bounds.w, h: bounds.h }, scale),
    transform: {
      scaleX: 1,
      scaleY: 1,
      translateX: emu(bounds.x, scale),
      translateY: emu(bounds.y, scale),
      unit: "EMU",
    },
  };
}

/**
 * Place a rotated box.
 *
 * `extract-dom.ts` reports `bounds` as the post-transform axis-aligned box and
 * `naturalWidth`/`naturalHeight` as the pre-transform layout box (extract-dom.ts
 * :231-239), so the element keeps its natural extent and the rotation is folded
 * into the affine terms. CSS `rotate(θ)` is `matrix(cos, sin, -sin, cos)` in a
 * y-down space, which maps onto Slides' transform as scaleX = scaleY = cos,
 * shearX = -sin, shearY = sin. The translation is then solved so the natural
 * box's centre lands on the measured bounds' centre.
 */
export function placeRotatedBox(
  options: Readonly<{
    bounds: BoundsPx;
    naturalSizePx: SizePx;
    rotateDeg: number;
    pageObjectId: string;
    scale: PageScale;
  }>,
): PageElementProperties {
  const { bounds, naturalSizePx, rotateDeg, pageObjectId, scale } = options;
  const radians = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = naturalSizePx.w / 2;
  const halfHeight = naturalSizePx.h / 2;
  const centreX = bounds.x + bounds.w / 2;
  const centreY = bounds.y + bounds.h / 2;
  const transform: AffineTransform = {
    scaleX: cos,
    scaleY: cos,
    shearX: -sin,
    shearY: sin,
    translateX: emu(centreX - (cos * halfWidth - sin * halfHeight), scale),
    translateY: emu(centreY - (sin * halfWidth + cos * halfHeight), scale),
    unit: "EMU",
  };
  return { pageObjectId, size: emuSize(naturalSizePx, scale), transform };
}

/**
 * Grow a text box by the uncontrollable text insets so the TEXT lands on the
 * HTML box. The returned bounds are what to hand `placeBox`.
 */
export function outsetForTextInset(
  options: Readonly<{ bounds: BoundsPx; insetEmu: TextInsetEmu; scale: PageScale }>,
): BoundsPx {
  const { bounds, insetEmu, scale } = options;
  const leftPx = insetEmu.left / scale.emuPerPx;
  const rightPx = insetEmu.right / scale.emuPerPx;
  const topPx = insetEmu.top / scale.emuPerPx;
  const bottomPx = insetEmu.bottom / scale.emuPerPx;
  return {
    x: bounds.x - leftPx,
    y: bounds.y - topPx,
    w: bounds.w + leftPx + rightPx,
    h: bounds.h + topPx + bottomPx,
  };
}

/**
 * THE LAW, forward direction: what Slides will actually render a table row as.
 *
 *   rendered = max(spec + 0.72, 1.197·font·lines + 0.98·(2·padY) + 0.51)
 *
 * The second term is the floor a row cannot go below, because the cell's own
 * line box plus vertical padding has to fit. Border width does NOT enter it —
 * an A/B test adding it worsened held-out RMSE from 1.02 to 1.51 px.
 *
 * Caveat recorded with the measurement: fonts at or below 10 px hit an absolute
 * ~13 px minimum that this linear floor under-predicts, so the floor is lifted
 * to that minimum for tiny text.
 */
export function predictGoogleRowHeightPx(
  options: Readonly<{ specPx: number; fontPx: number; lines: number; padYPx: number }>,
): RowHeightPrediction {
  const { specPx, fontPx, lines, padYPx } = options;
  const linear =
    SLIDES_NORMAL_LINE_BOX * fontPx * Math.max(1, lines) + 0.98 * (2 * padYPx) + 0.51;
  const floorPx = Math.max(linear, fontPx <= 10 ? TINY_FONT_MIN_ROW_PX : 0);
  const fromSpec = specPx + ROW_HEIGHT_SPEC_OFFSET_PX;
  return {
    renderedPx: Math.max(fromSpec, floorPx),
    floorPx,
    floorWins: floorPx > fromSpec,
  };
}

export type RowHeightPrediction = Readonly<{
  renderedPx: number;
  /** The height the row cannot render below, whatever `minRowHeight` says. */
  floorPx: number;
  /** True when the floor, not the spec, decides the height — i.e. an anomaly. */
  floorWins: boolean;
}>;

/**
 * THE LAW, inverted: the `minRowHeight` to specify so the row RENDERS at
 * `targetPx`. Clamped at zero because a negative magnitude is rejected.
 */
export function specForRowHeightPx(targetPx: number): number {
  return Math.max(0, targetPx - ROW_HEIGHT_SPEC_OFFSET_PX);
}

/**
 * Column law inverted: `rendered = 1.003·spec − 0.10`, so
 * `spec = (target + 0.10) / 1.003`. Slope 1.003 with RMSE 1.31 px over 701
 * points — i.e. columns are honoured almost exactly, and this correction is
 * sub-pixel on a typical column but worth applying on a full-width table.
 */
export function specForColumnWidthPx(targetPx: number): number {
  return Math.max(1, (targetPx + COLUMN_WIDTH_INTERCEPT_PX) / COLUMN_WIDTH_SLOPE);
}

/**
 * CSS `line-height` in px expressed as Slides' `lineSpacing` percentage, where
 * 100 means one normal line box. Because a normal box is 1.197·font (measured,
 * not 1.2), the conversion divides by that and not by the CSS nominal.
 */
export function lineSpacingPercent(
  options: Readonly<{ lineHeightPx: number; fontSizePx: number }>,
): number {
  const { lineHeightPx, fontSizePx } = options;
  if (fontSizePx <= 0 || lineHeightPx <= 0) return 100;
  const percent = (100 * lineHeightPx) / (SLIDES_NORMAL_LINE_BOX * fontSizePx);
  // Slides clamps well outside this; keeping it sane avoids absurd requests
  // from a measured pitch that belonged to a taller inline child.
  return Math.min(400, Math.max(20, Math.round(percent * 10) / 10));
}

/** CSS px to points, which is the unit Slides wants for font sizes. */
export function pxToPoints(valuePx: number): number {
  return Math.round(valuePx * 0.75 * 100) / 100;
}

/** The 0–1 box PROTOCOL.md's anomaly `region` wants. */
export function fractionalRegion(
  options: Readonly<{ bounds: BoundsPx; viewportPx: SizePx }>,
): FractionalRegion {
  const { bounds, viewportPx } = options;
  const width = viewportPx.w > 0 ? viewportPx.w : 1280;
  const height = viewportPx.h > 0 ? viewportPx.h : 720;
  const round = (value: number): number => Math.round(value * 10000) / 10000;
  return {
    x: round(bounds.x / width),
    y: round(bounds.y / height),
    w: round(bounds.w / width),
    h: round(bounds.h / height),
  };
}

/** From the fitted model: `rendered_row_h = max(spec + 0.72, …)`. */
const ROW_HEIGHT_SPEC_OFFSET_PX = 0.72;

/** From the fitted model: `rendered_col_w = 1.003·spec − 0.10`. */
const COLUMN_WIDTH_SLOPE = 1.003;
const COLUMN_WIDTH_INTERCEPT_PX = 0.1;

/** Absolute minimum row height observed for fonts of 10 px or less. */
const TINY_FONT_MIN_ROW_PX = 13;
