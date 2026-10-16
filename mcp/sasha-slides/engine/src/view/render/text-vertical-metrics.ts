// WHERE A LINE OF TEXT SITS VERTICALLY, the way Google Slides places it, expressed as stylesheet
// values the inline styles (inline-styles.ts) can carry. Pure numbers, no layout.
//
// Google's line, measured on calibration decks (text boxes varying family, size and spacing,
// screenshots of Google's own thumbnails against Chrome; 2026-10-15, about 1 px at 1600 x 900):
//
//  * A LINE IS `lineSpacing` x 1.2 x its LARGEST font size tall, for every family: the pitch matched
//    1.2 em at 100 %, 1.8 em at 150 % and 2.4 em at 200 % in Arial, Inter, Playfair Display, Lato
//    and nine others alike.
//  * THE BASELINE SITS A FIXED 0.9465 x that size BELOW THE LINE'S TOP at 100 % and above, AND THE
//    EXTRA SPACING ALL GOES BELOW IT. The first line of a box at 200 % is exactly where it is at
//    100 %. A stylesheet splits the extra into equal halves above and below the glyphs, so at 173 %
//    a paragraph's first line drew 0.44 em low (10-14 px on complex slide 25).
//  * BELOW 100 % THE LINE SHRINKS FROM ITS TOP: the baseline sits `lineSpacing` x 0.9465 x size
//    below the line's top (70 % lifted the first line 0.29 em; a centred half-leading lifts 0.18).
//  * THE OFFSET IS THE SAME FOR EVERY FAMILY. 0.9465 is Arial's own (0.6 + (ascent - descent) / 2
//    of a 1.2 line box); Playfair Display's 1.0155 drew 0.07 em lower than Google, Lato's and Open
//    Sans's 0.987 about 0.04 em lower. `FONT_VERTICAL_METRICS` holds the families' layout ascent and
//    descent (canvas fontBoundingBox metrics of the Google Fonts files the exporter links, and of
//    the Liberation fonts that stand in for Arial, Times New Roman and Courier New with the same
//    metrics), so each run can correct its own font. A family not listed is taken as Arial-like,
//    which is how every family was drawn before this module existed.
//  * SPACE ABOVE AND BELOW and vertical alignment behave as a stylesheet's do: a middle- or
//    bottom-aligned box centres the full `lineSpacing` x 1.2 lines, trailing spacing included.
//
// How the stylesheet gets there (inline-styles.ts): every run is a box `lineSpacing` x 1.2 of its
// own size tall, LOWERED by `runDropEm` (vertical-align) so its top is the baseline's distance
// above it, and its glyphs RAISED back by the same amount (relative `top`), so all runs keep one
// baseline. A line box is the union of its runs' boxes, which is exactly Google's "largest size on
// the line" rule, a BIG word included. The paragraph's own strut is sized by `strutLineHeight` so it
// never reaches above the runs; an empty paragraph keeps its height through `min-height`.

/** Google's baseline below the line's top at 100 % spacing, per unit of font size, for every family. */
export const SLIDES_BASELINE_PER_FONT_SIZE = 0.9465;

/** A line's height per unit of line spacing and font size (SPEC.md section 8). */
export const LINE_BOX_PER_LINE_SPACING = 1.2;

export type FontVerticalMetrics = Readonly<{ ascent: number; descent: number }>;

/**
 * Layout ascent and descent per unit of font size, by lower-case family name, measured in Chrome
 * from the files the exporter links (every weight and style of a family measured alike).
 */
export const FONT_VERTICAL_METRICS: Readonly<Record<string, FontVerticalMetrics>> = {
  "anton": { ascent: 1.176, descent: 0.329 },
  "archivo": { ascent: 0.878, descent: 0.21 },
  "arial": { ascent: 0.905, descent: 0.212 },
  "arimo": { ascent: 0.905, descent: 0.212 },
  "barlow": { ascent: 1, descent: 0.2 },
  "bebas neue": { ascent: 0.9, descent: 0.3 },
  "caveat": { ascent: 0.96, descent: 0.3 },
  "comfortaa": { ascent: 0.881, descent: 0.234 },
  "courier new": { ascent: 0.833, descent: 0.3 },
  "cousine": { ascent: 0.833, descent: 0.3 },
  "dm sans": { ascent: 0.992, descent: 0.31 },
  "eb garamond": { ascent: 1.007, descent: 0.298 },
  "fira code": { ascent: 0.99, descent: 0.322 },
  "fira sans": { ascent: 0.935, descent: 0.265 },
  "gelasio": { ascent: 0.928, descent: 0.342 },
  "ibm plex mono": { ascent: 1.025, descent: 0.275 },
  "ibm plex sans": { ascent: 1.025, descent: 0.275 },
  "inter": { ascent: 0.969, descent: 0.241 },
  "jetbrains mono": { ascent: 1.02, descent: 0.3 },
  "lato": { ascent: 0.987, descent: 0.213 },
  "lexend": { ascent: 1, descent: 0.25 },
  "liberation mono": { ascent: 0.833, descent: 0.3 },
  "liberation sans": { ascent: 0.905, descent: 0.212 },
  "liberation serif": { ascent: 0.891, descent: 0.216 },
  "libre baskerville": { ascent: 0.97, descent: 0.27 },
  "lora": { ascent: 1.006, descent: 0.274 },
  "manrope": { ascent: 1.066, descent: 0.3 },
  "merriweather": { ascent: 0.984, descent: 0.273 },
  "montserrat": { ascent: 0.968, descent: 0.251 },
  "noto sans": { ascent: 1.069, descent: 0.293 },
  "noto serif": { ascent: 1.069, descent: 0.293 },
  "nunito": { ascent: 1.011, descent: 0.353 },
  "open sans": { ascent: 1.069, descent: 0.293 },
  "oswald": { ascent: 1.193, descent: 0.289 },
  "patrick hand": { ascent: 1.042, descent: 0.312 },
  "playfair display": { ascent: 1.082, descent: 0.251 },
  "poppins": { ascent: 1.05, descent: 0.35 },
  "pt sans": { ascent: 1.018, descent: 0.276 },
  "pt serif": { ascent: 1.039, descent: 0.286 },
  "quicksand": { ascent: 1, descent: 0.25 },
  "raleway": { ascent: 0.94, descent: 0.234 },
  "roboto": { ascent: 0.928, descent: 0.244 },
  "roboto mono": { ascent: 1.048, descent: 0.271 },
  "rubik": { ascent: 0.935, descent: 0.25 },
  "source code pro": { ascent: 0.984, descent: 0.273 },
  "source sans 3": { ascent: 1.024, descent: 0.4 },
  "space grotesk": { ascent: 0.984, descent: 0.292 },
  "times new roman": { ascent: 0.891, descent: 0.216 },
  "tinos": { ascent: 0.891, descent: 0.216 },
  "ubuntu": { ascent: 0.932, descent: 0.189 },
  "work sans": { ascent: 0.93, descent: 0.243 },
};

/**
 * Where a stylesheet puts this family's baseline below the top of a 1.2 line box, per unit of font
 * size: the half-leading plus the ascent. An unlisted family is taken as Google's own offset.
 */
export function stylesheetBaselineInLineBox(family: string): number {
  const metrics = FONT_VERTICAL_METRICS[family.trim().toLowerCase()];
  if (metrics === undefined) return SLIDES_BASELINE_PER_FONT_SIZE;
  return LINE_BOX_PER_LINE_SPACING / 2 + (metrics.ascent - metrics.descent) / 2;
}

/** Google's baseline below the line's top, per unit of the line's font size (see the header). */
export function slidesBaselineInLine(lineSpacing: number): number {
  return Math.min(lineSpacing, 1) * SLIDES_BASELINE_PER_FONT_SIZE;
}

/**
 * The part of a run's drop that depends only on the paragraph's spacing, in em of the run's size:
 * the stylesheet's half-leading minus Google's baseline offset. A run adds its own font's offset.
 */
export function paragraphLineDropEm(lineSpacing: number): number {
  return ((lineSpacing - 1) * LINE_BOX_PER_LINE_SPACING) / 2 - slidesBaselineInLine(lineSpacing);
}

/**
 * How far a stylesheet's centred line box must move DOWN, in em of the run's own size, for its top
 * to sit Google's baseline offset above the baseline: the stylesheet's own offset at this spacing
 * (its half-leading plus the font's) minus Google's.
 */
export function runDropEm(options: Readonly<{ lineSpacing: number; family: string }>): number {
  return stylesheetBaselineInLineBox(options.family) + paragraphLineDropEm(options.lineSpacing);
}

/**
 * The paragraph's line height (a multiple of its own size) for its strut, the box every line of
 * the paragraph has: tall enough to place Google's baseline, and never reaching above a run's box,
 * so only runs decide where a line's top is. Zero once the spacing is tighter than the font's
 * ascent can follow.
 */
export function strutLineHeight(options: Readonly<{ lineSpacing: number; family: string }>): number {
  const above = slidesBaselineInLine(options.lineSpacing);
  return Math.max(0, LINE_BOX_PER_LINE_SPACING + 2 * (above - stylesheetBaselineInLineBox(options.family)));
}
