// WHERE GOOGLE SLIDES PUTS A TOP-ANCHORED TEXT BOX'S FIRST BASELINE, and the box placement that
// makes it land on Chrome's.
//
// Why this exists: a stylesheet centres a line's extra leading around the glyphs and places the
// baseline by the font's own ascent, while Google Slides does neither. Its model, measured on
// calibration decks for the Sasha engine (mcp/sasha-slides/engine/src/view/render/
// text-vertical-metrics.ts, 2026-10-15, within about 1 px at 1600 x 900):
//
//   * a line is `lineSpacing` x 1.2 x its largest font size tall, for every family;
//   * at 100 % and above the baseline sits a FIXED 0.9465 x size below the line's top and all the
//     extra spacing goes BELOW the glyphs;
//   * below 100 % the line shrinks from its top: the baseline sits `lineSpacing` x 0.9465 x size down.
//
// So a top-anchored box whose top is Chrome's line top draws its text too high by the CSS
// half-leading plus the family's ascent difference: complex slide_06's Playfair quote at
// line-height 1.6 was 6.4 px high, slide_17's 48 px Playfair title at line-height normal 6.4 px.
// The converter measures Chrome's first baseline in the browser (extract-dom.ts, Range rect top +
// the font's ascent, which also covers padding and every family's metrics), and this module turns
// it into a top inset that puts Google's baseline on Chrome's. Pure numbers, CSS pixels.

/** Google's baseline below the line's top at 100 % spacing, per unit of font size, for every family. */
export const SLIDES_BASELINE_PER_FONT_SIZE = 0.9465;

export type TopAnchoredPlacement = Readonly<{
  /** The text box's top edge. */
  topPx: number;
  /** The text box's height; grows by exactly what `topPx` rose, so the bottom edge never moves. */
  heightPx: number;
  /** The `<a:bodyPr tIns>` inset, never negative. */
  topInsetPx: number;
}>;

/**
 * The text box placement whose first baseline Google draws at `chromeFirstBaselinePx`. When
 * Chrome's baseline is closer to the box top than Google's offset can reach, the box rises instead
 * of taking a negative inset (Google clamps insets at zero).
 */
export function topAnchoredTextPlacement(
  options: Readonly<{
    boxTopPx: number;
    boxHeightPx: number;
    chromeFirstBaselinePx: number;
    lineSpacingMultiple: number;
    firstLineFontSizePx: number;
  }>,
): TopAnchoredPlacement {
  const inset = options.chromeFirstBaselinePx - options.boxTopPx - slidesFirstBaselineOffsetPx(options);
  if (inset >= 0) return { topPx: options.boxTopPx, heightPx: options.boxHeightPx, topInsetPx: inset };
  return { topPx: options.boxTopPx + inset, heightPx: options.boxHeightPx - inset, topInsetPx: 0 };
}

/** Google's first baseline below a top-anchored box's inner top edge (see the header). */
export function slidesFirstBaselineOffsetPx(options: Readonly<{ lineSpacingMultiple: number; firstLineFontSizePx: number }>): number {
  return Math.min(options.lineSpacingMultiple, 1) * SLIDES_BASELINE_PER_FONT_SIZE * options.firstLineFontSizePx;
}
