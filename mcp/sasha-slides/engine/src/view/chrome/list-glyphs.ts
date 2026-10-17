// THE LIST STYLE PICKER'S PRESETS (SPEC.md 21.9, review fix 2): the 12 `ListGlyph`s Google Slides'
// `createParagraphBullets` offers, six bulleted and six numbered, each with a name in words. The
// mark each one shows and its family come from the one glyph table the renderer draws with
// (shared/list-glyphs.ts), so the picker's sample is the marker the slide will show. A total record
// over `ListGlyph`, so a new glyph in the contract does not compile until the picker can name it.

import type { ListGlyph } from "../../contracts/style.ts";
import { LIST_GLYPH, listMarkerText, type ListFamily } from "../../shared/list-glyphs.ts";

export type ListGlyphPreset = Readonly<{ glyph: ListGlyph; family: ListFamily; sample: string; label: string }>;

const LABEL_BY_GLYPH: Readonly<Record<ListGlyph, string>> = {
  disc: "Round bullets",
  circle: "Hollow round bullets",
  square: "Square bullets",
  arrow: "Arrow bullets",
  star: "Star bullets",
  checkbox: "Checkboxes",
  decimal: "Numbers",
  decimalZeroPadded: "Numbers with a leading zero",
  upperAlphabetic: "Capital letters",
  lowerAlphabetic: "Small letters",
  upperRoman: "Capital Roman numerals",
  lowerRoman: "Small Roman numerals",
};

/** The picker's order: the bulleted six, then the numbered six. */
// Object.keys widens to string[]; LABEL_BY_GLYPH is a total record over ListGlyph, so every key is one.
export const LIST_GLYPH_PRESETS: readonly ListGlyphPreset[] = (Object.keys(LABEL_BY_GLYPH) as ListGlyph[]).map((glyph) => ({
  glyph,
  family: LIST_GLYPH[glyph].family,
  sample: listMarkerText({ glyph, number: 1 }),
  label: LABEL_BY_GLYPH[glyph],
}));
