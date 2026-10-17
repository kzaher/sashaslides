// COLOUR ARITHMETIC FOR THE CONTRAST GATE: parsing the token formats, compositing translucent
// glass onto what is behind it, applying the calm wash's filter, and the contrast ratio of the Web
// Content Accessibility Guidelines. It exists so tidepool-theme.test.ts can prove every text
// colour readable on every surface it is drawn on -- before anyone has to notice a failure on
// screen. Only that test uses it, so it lives in the theme's testing folder, beside the tokens, as a
// token change and its proof travel together.
//
// The wash filter is the stylesheet's `hue-rotate(angle) saturate(amount)`, computed with the
// matrices the Filter Effects specification defines, in sRGB (how browsers apply the shorthand
// filter functions).

import { parseColourText } from "../../shared/colour-text.ts";

/** An opaque colour as 0..255 channels. */
export type OpaqueColour = Readonly<{ red: number; green: number; blue: number }>;

export type ParsedColour = Readonly<{ colour: OpaqueColour; alpha: number }>;

/** Parses "#rrggbb" or "rgba(r, g, b, a)"; null for anything else. */
export function parseColour(text: string): ParsedColour | null {
  const parsed = parseColourText(text);
  if (parsed === null) return null;
  return { colour: { red: parsed.red, green: parsed.green, blue: parsed.blue }, alpha: parsed.alpha };
}

/** `over` alpha-composited onto an opaque `under`. */
export function compositeOver(options: Readonly<{ over: string; under: OpaqueColour }>): OpaqueColour {
  const parsed = parseColour(options.over);
  if (parsed === null) throw new Error(`Not a colour this helper understands: ${options.over}`);
  const mix = (top: number, bottom: number): number => Math.round(top * parsed.alpha + bottom * (1 - parsed.alpha));
  return {
    red: mix(parsed.colour.red, options.under.red),
    green: mix(parsed.colour.green, options.under.green),
    blue: mix(parsed.colour.blue, options.under.blue),
  };
}

/** `filter: hue-rotate(degrees) saturate(amount)` applied to one colour. */
export function washFilter(options: Readonly<{ colour: OpaqueColour; hueDegrees: number; saturation: number }>): OpaqueColour {
  const rotated = applyMatrix({ colour: options.colour, matrix: hueRotationMatrix(options.hueDegrees) });
  return applyMatrix({ colour: rotated, matrix: saturationMatrix(options.saturation) });
}

/** The contrast ratio between two opaque colours, 1..21. */
export function contrastRatio(options: Readonly<{ first: OpaqueColour; second: OpaqueColour }>): number {
  const first = relativeLuminance(options.first);
  const second = relativeLuminance(options.second);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Parses an opaque token; throws on anything else (a test-time programming error). */
export function opaque(text: string): OpaqueColour {
  const parsed = parseColour(text);
  if (parsed === null) throw new Error(`Unparseable colour ${text}`);
  return parsed.colour;
}

type Matrix = readonly (readonly [number, number, number])[];

function hueRotationMatrix(degrees: number): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    [0.213 + cosine * 0.787 - sine * 0.213, 0.715 - cosine * 0.715 - sine * 0.715, 0.072 - cosine * 0.072 + sine * 0.928],
    [0.213 - cosine * 0.213 + sine * 0.143, 0.715 + cosine * 0.285 + sine * 0.14, 0.072 - cosine * 0.072 - sine * 0.283],
    [0.213 - cosine * 0.213 - sine * 0.787, 0.715 - cosine * 0.715 + sine * 0.715, 0.072 + cosine * 0.928 + sine * 0.072],
  ];
}

function saturationMatrix(amount: number): Matrix {
  return [
    [0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount],
    [0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount],
    [0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount],
  ];
}

function applyMatrix(options: Readonly<{ colour: OpaqueColour; matrix: Matrix }>): OpaqueColour {
  const channels = [options.colour.red, options.colour.green, options.colour.blue];
  const row = (index: number): number => {
    const coefficients = options.matrix[index] ?? [0, 0, 0];
    const value = coefficients[0] * (channels[0] ?? 0) + coefficients[1] * (channels[1] ?? 0) + coefficients[2] * (channels[2] ?? 0);
    return Math.min(255, Math.max(0, Math.round(value)));
  };
  return { red: row(0), green: row(1), blue: row(2) };
}

function relativeLuminance(colour: OpaqueColour): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour.red) + 0.7152 * channel(colour.green) + 0.0722 * channel(colour.blue);
}
