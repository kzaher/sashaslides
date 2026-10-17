// COLOUR TEXT: the one reader for the colour strings browsers and the theme tokens produce --
// "#rrggbb", "rgb(r, g, b)" and "rgba(r, g, b, a)". The text input reads a chosen or pasted colour
// with it (view/text/input-parser.ts), the render code splits a hexadecimal colour to add an alpha
// (view/render/inline-styles.ts), and the theme's contrast test parses its tokens with it
// (theme/testing/colour-contrast.ts). Channels come back as written (0..255 for well-formed text);
// a caller that needs them clamped does so.

/** A colour as 0..255 channels and an alpha in 0..1. */
export type ColourChannels = Readonly<{ red: number; green: number; blue: number; alpha: number }>;

const HEXADECIMAL_PATTERN = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const FUNCTIONAL_PATTERN = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** Parses "#rrggbb", "rgb(r, g, b)" or "rgba(r, g, b, a)" (surrounding spaces allowed); null for anything else. */
export function parseColourText(text: string): ColourChannels | null {
  return parseHexadecimalColour(text) ?? parseFunctionalColour(text);
}

/** Parses "#rrggbb" only (surrounding spaces allowed, alpha 1); null for anything else. */
export function parseHexadecimalColour(text: string): ColourChannels | null {
  const match = HEXADECIMAL_PATTERN.exec(text.trim());
  if (match === null) return null;
  return { red: parseInt(match[1] ?? "0", 16), green: parseInt(match[2] ?? "0", 16), blue: parseInt(match[3] ?? "0", 16), alpha: 1 };
}

function parseFunctionalColour(text: string): ColourChannels | null {
  const match = FUNCTIONAL_PATTERN.exec(text.trim());
  if (match === null) return null;
  return { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]), alpha: match[4] === undefined ? 1 : Number(match[4]) };
}
