// A COLOUR THE RECORD CAN CARRY. `getComputedStyle` hands back `rgb(43, 58, 143)`; the contract's
// example record carries `#2b3a8f`, and `<input type="color">` speaks hex too. One parser at the
// boundary, so the record format never depends on which browser rendered the candidate.

/**
 * `rgb(…)` / `rgba(…)` as hex. Alpha is kept as an 8-digit hex rather than dropped, because a
 * translucent card is a deliberate design choice and `#ffffff` would be a different slide.
 * Anything already hex, a keyword, or a value this does not understand comes back UNCHANGED --
 * a record that says `linear-gradient(...)` is honest, where a guessed `#000000` would not be.
 */
export function hexOfCssColour(value: string): string {
  const parts = parseRgbFunction(value);
  if (parts === null) return value.trim();
  if (parts.alpha === 0) return "transparent";
  const base = `#${hexByte(parts.red)}${hexByte(parts.green)}${hexByte(parts.blue)}`;
  return parts.alpha >= 1 ? base : `${base}${hexByte(Math.round(parts.alpha * 255))}`;
}

/** True when the value is a colour an `<input type="color">` can be seeded with. */
export function isOpaqueHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * The swatch control only speaks 6-digit hex, so it needs a seed even for a translucent or
 * keyword colour. The fallback is a neutral, never a guess at the original.
 */
export function swatchValueOf({ colour, fallback }: { colour: string; fallback: string }): string {
  const hex = hexOfCssColour(colour);
  if (isOpaqueHex(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return hex.slice(0, 7).toLowerCase();
  return fallback;
}

type RgbParts = Readonly<{ red: number; green: number; blue: number; alpha: number }>;

function parseRgbFunction(value: string): RgbParts | null {
  const match = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:\s*[,/]\s*([0-9.%]+))?\s*\)$/i.exec(value.trim());
  if (match === null) return null;
  const red = byteOf(match[1]);
  const green = byteOf(match[2]);
  const blue = byteOf(match[3]);
  if (red === null || green === null || blue === null) return null;
  return { red, green, blue, alpha: alphaOf(match[4]) };
}

function byteOf(text: string | undefined): number | null {
  if (text === undefined) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.min(255, Math.max(0, Math.round(parsed))) : null;
}

function alphaOf(text: string | undefined): number {
  if (text === undefined) return 1;
  const percent = text.endsWith("%");
  const parsed = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, percent ? parsed / 100 : parsed));
}

function hexByte(value: number): string {
  return Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0");
}
