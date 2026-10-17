// LIST GLYPHS: the one table of what each of the 12 `ListGlyph` presets draws and which family
// (bulleted or numbered) it belongs to, and the 0..8 range of list levels. The renderer draws its
// markers from it (view/render/text-layout.ts), the list style picker shows them as samples
// (view/chrome/list-glyphs.ts), and the editor toggles lists by family (state/editor/text-editing.ts).
// The bullets are the characters Google Slides' BULLET_* presets draw, the ones the Google importer
// reads back as exact (google-slides/import-text.ts `EXACT_GLYPHS`): an arrow list is U+27A2 "➢".
// A total record over `ListGlyph`, so a new glyph in the contract does not compile until it draws.
// DOM-free and Node-free.

import type { ListGlyph } from "../contracts/style.ts";

export type ListFamily = "bulleted" | "numbered";

export type ListGlyphDefinition = Readonly<{ family: ListFamily; marker: (number: number) => string }>;

export const LIST_GLYPH: Readonly<Record<ListGlyph, ListGlyphDefinition>> = {
  disc: { family: "bulleted", marker: () => "●" },
  circle: { family: "bulleted", marker: () => "○" },
  square: { family: "bulleted", marker: () => "■" },
  arrow: { family: "bulleted", marker: () => "➢" },
  star: { family: "bulleted", marker: () => "★" },
  checkbox: { family: "bulleted", marker: () => "❏" },
  decimal: { family: "numbered", marker: (number) => `${number}.` },
  decimalZeroPadded: { family: "numbered", marker: (number) => `${String(number).padStart(2, "0")}.` },
  upperAlphabetic: { family: "numbered", marker: (number) => `${alphabetic(number)}.` },
  lowerAlphabetic: { family: "numbered", marker: (number) => `${alphabetic(number).toLowerCase()}.` },
  upperRoman: { family: "numbered", marker: (number) => `${roman(number)}.` },
  lowerRoman: { family: "numbered", marker: (number) => `${roman(number).toLowerCase()}.` },
};

/** List levels run 0..8 (nine levels, as Slides). */
export const MAXIMUM_LIST_LEVEL = 8;

/** The marker a glyph preset draws for the paragraph numbered `number` (1-based). */
export function listMarkerText(options: Readonly<{ glyph: ListGlyph; number: number }>): string {
  return LIST_GLYPH[options.glyph].marker(options.number);
}

/** `level` within the nine list levels. */
export function clampListLevel(level: number): number {
  return Math.max(0, Math.min(MAXIMUM_LIST_LEVEL, level));
}

function alphabetic(number: number): string {
  let remaining = Math.max(1, Math.floor(number));
  let text = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    text = String.fromCharCode(65 + index) + text;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return text;
}

const ROMAN_NUMERALS: readonly Readonly<{ value: number; numeral: string }>[] = [
  { value: 1000, numeral: "M" },
  { value: 900, numeral: "CM" },
  { value: 500, numeral: "D" },
  { value: 400, numeral: "CD" },
  { value: 100, numeral: "C" },
  { value: 90, numeral: "XC" },
  { value: 50, numeral: "L" },
  { value: 40, numeral: "XL" },
  { value: 10, numeral: "X" },
  { value: 9, numeral: "IX" },
  { value: 5, numeral: "V" },
  { value: 4, numeral: "IV" },
  { value: 1, numeral: "I" },
];

function roman(number: number): string {
  let remaining = Math.max(1, Math.min(3999, Math.floor(number)));
  let text = "";
  for (const entry of ROMAN_NUMERALS) {
    while (remaining >= entry.value) {
      text += entry.numeral;
      remaining -= entry.value;
    }
  }
  return text;
}
