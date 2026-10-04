/**
 * glyph-advance-widths.ts — how wide a string is, as a number, without a browser.
 *
 * WHY THIS IS NOT substitute-text.ts's BUCKETS. The substituter only ever has to answer "which
 * other letter is about as wide as this one", so an ORDERING is enough and the buckets encode one.
 * The lorem strategy has to answer "how much text is this wide", which is a sum, so it needs the
 * widths as numbers. Same measurement, same tool family, different shape: `glyph-widths.e2e.ts`
 * scores the buckets, `glyph-advance-widths.e2e.ts` prints the tables below.
 *
 * THE UNIT is per mille of the font size, which is the unit advance widths are stored in inside a
 * font and the only one that is independent of the `font-size` on the element — a run of text at
 * 58px and the same run at 14px have the same width in these units. Nothing here needs the font
 * size, so nothing here reads one.
 *
 * THERE IS A TABLE PER FAMILY, NOT AN AVERAGE OF THE TWO, and that is the difference between a
 * 10px drift and a 2px one. Averaging looked reasonable until it was measured: `Georgia` and
 * `Helvetica` disagree by 9.3% per glyph on average and by 25% on `s`, `e`, `a`, `i`, `l` and `J`,
 * and they disagree in OPPOSITE DIRECTIONS (Georgia's `i` is wider than Helvetica's, its `e` is
 * narrower), so the average is wrong for either of them and a word fitted to it is wrong twice.
 * `lorem-text.ts` scores a candidate against every model here at once instead.
 *
 * WHAT THIS CANNOT KNOW, written down because the lorem strategy's accuracy is bounded by it:
 *   - the actual font on the element. These are the two stacks the four candidate fixtures ask
 *     for; a condensed or a display face has its own ratios, and an embedded `data:` font (which
 *     the anonymiser preserves byte for byte) can have any at all.
 *   - a MONOSPACE run, where every advance is identical and width is the character COUNT. That is
 *     not an error bar, it is a different model, so it is a separate number here
 *     (`MONOSPACE_ADVANCE_PER_MILLE`). It also stands in for `letter-spacing`, which adds a fixed
 *     advance PER CHARACTER in any family and so makes the character count matter again.
 *   - kerning pairs, ligatures, `font-variant`, synthetic bold and synthetic italic. Each shifts a
 *     measured run by a per cent or two.
 *
 * Re-measure with `glyph-advance-widths.e2e.ts` before editing a number.
 */

/** The font models a width can be asked for. One per proportional stack the fixtures declare. */
export type WidthModel = "serif" | "sans";

/** Every model, for a caller that has to fit a word under all of them at once. */
export const WIDTH_MODELS: readonly WidthModel[] = ["serif", "sans"];

/**
 * The advance width of `text` under one font model, in per mille of the font size.
 *
 * It is a plain sum of per-glyph advances: no kerning, no ligatures, no shaping. That is what
 * `CanvasRenderingContext2D.measureText` reports for Latin text to within a per cent, and the
 * lorem strategy compares two such sums against each other, so a shared bias cancels.
 */
export function textAdvanceWidth({ text, model }: { text: string; model: WidthModel }): number {
  const table = ADVANCE_WIDTHS_PER_MILLE[model];
  let total = 0;
  for (const character of text) total += table.get(character) ?? UNMEASURED_ADVANCE_PER_MILLE[model];
  return total;
}

/**
 * Every cell of a monospace run, in per mille. Measured on `"SF Mono", Menlo, monospace`, where
 * all 62 measured characters came back identical — which is the definition of the family.
 */
export const MONOSPACE_ADVANCE_PER_MILLE = 602;

// Measured by glyph-advance-widths.e2e.ts in Chrome 154. Per mille of the font size.
const ADVANCE_WIDTHS_PER_MILLE: Readonly<Record<WidthModel, ReadonlyMap<string, number>>> = {
  // Georgia, "Times New Roman", serif
  serif: new Map([
    ["a", 444], ["b", 500], ["c", 444], ["d", 500], ["e", 444], ["f", 333],
    ["g", 500], ["h", 500], ["i", 278], ["j", 278], ["k", 500], ["l", 278],
    ["m", 778], ["n", 500], ["o", 500], ["p", 500], ["q", 500], ["r", 333],
    ["s", 389], ["t", 278], ["u", 500], ["v", 500], ["w", 722], ["x", 500],
    ["y", 500], ["z", 444],
    ["A", 722], ["B", 667], ["C", 667], ["D", 722], ["E", 611], ["F", 556],
    ["G", 722], ["H", 722], ["I", 333], ["J", 389], ["K", 722], ["L", 611],
    ["M", 889], ["N", 722], ["O", 722], ["P", 556], ["Q", 722], ["R", 667],
    ["S", 556], ["T", 611], ["U", 722], ["V", 722], ["W", 944], ["X", 722],
    ["Y", 722], ["Z", 611],
    ["0", 500], ["1", 500], ["2", 500], ["3", 500], ["4", 500], ["5", 500],
    ["6", 500], ["7", 500], ["8", 500], ["9", 500],
  ]),
  // "Helvetica Neue", Arial, sans-serif
  sans: new Map([
    ["a", 556], ["b", 556], ["c", 500], ["d", 556], ["e", 556], ["f", 278],
    ["g", 556], ["h", 556], ["i", 222], ["j", 222], ["k", 500], ["l", 222],
    ["m", 833], ["n", 556], ["o", 556], ["p", 556], ["q", 556], ["r", 333],
    ["s", 500], ["t", 278], ["u", 556], ["v", 500], ["w", 722], ["x", 500],
    ["y", 500], ["z", 500],
    ["A", 667], ["B", 667], ["C", 722], ["D", 722], ["E", 667], ["F", 611],
    ["G", 778], ["H", 722], ["I", 278], ["J", 500], ["K", 667], ["L", 556],
    ["M", 833], ["N", 722], ["O", 778], ["P", 667], ["Q", 778], ["R", 722],
    ["S", 667], ["T", 611], ["U", 722], ["V", 667], ["W", 944], ["X", 667],
    ["Y", 667], ["Z", 611],
    ["0", 556], ["1", 556], ["2", 556], ["3", 556], ["4", 556], ["5", 556],
    ["6", 556], ["7", 556], ["8", 556], ["9", 556],
  ]),
};

/**
 * A character the table does not name — punctuation, a symbol, a non-Latin letter.
 *
 * It is each family's measured mean over the 62 characters above rather than zero, so a string
 * full of unmeasured characters is not reported as weightless. It is only ever reached for a
 * character lorem-text.ts does not generate and does not target: a chunk holding one is handed to
 * the substituter whole, which preserves its width by staying inside the glyph-width buckets.
 */
const UNMEASURED_ADVANCE_PER_MILLE: Readonly<Record<WidthModel, number>> = { serif: 553, sans: 579 };
