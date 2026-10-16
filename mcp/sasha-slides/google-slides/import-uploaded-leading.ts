/**
 * TEXT UPLOADED FROM POWERPOINT ENDS WITHOUT ITS LAST LINE'S SPACING, and the importer moves the
 * text inset to say so in the engine's one line model.
 *
 * Measured 2026-10-15 on calibration decks this pipeline created (Google's thumbnails, 1600 x 900):
 * Slides gives each line `lineSpacing` x 1.2 x its size and puts the extra spacing BELOW the glyphs
 * (engine render/text-vertical-metrics.ts). For a shape built in Slides that holds for the last line
 * too, so a centred or bottom-aligned box counts the last line's trailing spacing. For a shape that
 * came from an uploaded .pptx it does not: a centred single line at 100, 120 and 200 % sat at the
 * same height, and the last line of a bottom-aligned pair sat at the same height at 120 and 200 %.
 * Spacing BETWEEN lines and the first line's place are the same for both. Boxes created through the
 * API inside an uploaded deck followed the Slides rule, so the difference belongs to the shape.
 *
 * `presentations.get` does not name it. The one field that tells the two apart is the paragraph's
 * `spacingMode`: a .pptx upload writes NEVER_COLLAPSE on every paragraph (all 1,149 text shapes
 * of the two uploaded fixture decks), a shape made in Slides or through the API has COLLAPSE_LISTS
 * (all 30 of the test deck's), and the engine's export never sets it.
 *
 * The engine draws every box by the Slides rule, so an uploaded box's centred or bottom-aligned text
 * would sit the trailing spacing (or half of it) too high. The importer gives that spacing back to
 * the inset instead: a centred box's top inset grows by it, a bottom-aligned box's bottom inset
 * shrinks by it (never below zero). Spacing under 100 % is left alone: it was not measured.
 */
import type { SlidesText } from "./slides-presentation.ts";

/** A line's height per unit of line spacing and font size, as Slides draws it. */
const LINE_BOX_PER_LINE_SPACING = 1.2;

/** The `spacingMode` a .pptx upload writes on every paragraph (see the header). */
export const UPLOADED_SPACING_MODE = "NEVER_COLLAPSE";

/**
 * The spacing, in points, Slides leaves off below the last line of an uploaded box: the last
 * paragraph's extra spacing over 100 % of its largest text. Zero for a box built in Slides, for
 * spacing at or under 100 %, and when the spacing or the size is inherited rather than stated.
 */
export function uploadedTrailingSpacingPoints(text: SlidesText | null): number {
  const last = text?.paragraphs[text.paragraphs.length - 1];
  if (last === undefined || last.style.spacingMode !== UPLOADED_SPACING_MODE) return 0;
  const spacing = last.style.lineSpacingPercent;
  if (spacing === undefined || spacing <= 100) return 0;
  const sizes = last.runs.flatMap((run) => (run.style.fontSizePoints !== undefined && (run.style.baselineOffset ?? "NONE") === "NONE" ? [run.style.fontSizePoints] : []));
  const size = sizes.length > 0 ? Math.max(...sizes) : last.markStyle.fontSizePoints;
  if (size === undefined) return 0;
  return ((spacing - 100) / 100) * LINE_BOX_PER_LINE_SPACING * size;
}

/**
 * The insets that keep an uploaded box's text where Slides draws it (see the header), given the
 * trailing spacing in engine units.
 */
export function insetsForUploadedText(
  options: Readonly<{ verticalAlignment: "top" | "middle" | "bottom"; top: number; bottom: number; trailingSpacing: number }>,
): Readonly<{ top: number; bottom: number }> {
  const spacing = options.trailingSpacing;
  if (!(spacing > 0)) return { top: options.top, bottom: options.bottom };
  switch (options.verticalAlignment) {
    case "top":
      return { top: options.top, bottom: options.bottom };
    case "middle":
      return { top: roundHundredths(options.top + spacing), bottom: options.bottom };
    case "bottom":
      return { top: options.top, bottom: roundHundredths(Math.max(0, options.bottom - spacing)) };
  }
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
