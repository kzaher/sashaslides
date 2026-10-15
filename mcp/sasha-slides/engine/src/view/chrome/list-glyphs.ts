// THE LIST STYLE PICKER'S PRESETS (SPEC.md 21.9, review fix 2): the 12 `ListGlyph`s Google Slides'
// `createParagraphBullets` offers, six bulleted and six numbered, each with the mark it draws and
// a name in words. A total record over `ListGlyph`, so a new glyph in the contract does not compile
// until the picker knows how to show it.

import type { ListGlyph } from "../../contracts/style.ts";

export type ListGlyphPreset = Readonly<{ glyph: ListGlyph; family: "bulleted" | "numbered"; sample: string; label: string }>;

const PRESET_BY_GLYPH: Readonly<Record<ListGlyph, Omit<ListGlyphPreset, "glyph">>> = {
  disc: { family: "bulleted", sample: "•", label: "Round bullets" },
  circle: { family: "bulleted", sample: "◦", label: "Hollow round bullets" },
  square: { family: "bulleted", sample: "▪", label: "Square bullets" },
  arrow: { family: "bulleted", sample: "➢", label: "Arrow bullets" },
  star: { family: "bulleted", sample: "★", label: "Star bullets" },
  checkbox: { family: "bulleted", sample: "☐", label: "Checkboxes" },
  decimal: { family: "numbered", sample: "1.", label: "Numbers" },
  decimalZeroPadded: { family: "numbered", sample: "01.", label: "Numbers with a leading zero" },
  upperAlphabetic: { family: "numbered", sample: "A.", label: "Capital letters" },
  lowerAlphabetic: { family: "numbered", sample: "a.", label: "Small letters" },
  upperRoman: { family: "numbered", sample: "I.", label: "Capital Roman numerals" },
  lowerRoman: { family: "numbered", sample: "i.", label: "Small Roman numerals" },
};

/** The picker's order: the bulleted six, then the numbered six. */
// Object.keys widens to string[]; PRESET_BY_GLYPH is a total record over ListGlyph, so every key is one.
export const LIST_GLYPH_PRESETS: readonly ListGlyphPreset[] = (Object.keys(PRESET_BY_GLYPH) as ListGlyph[]).map((glyph) => ({ glyph, ...PRESET_BY_GLYPH[glyph] }));

export function listGlyphFamily(glyph: ListGlyph): "bulleted" | "numbered" {
  return PRESET_BY_GLYPH[glyph].family;
}
