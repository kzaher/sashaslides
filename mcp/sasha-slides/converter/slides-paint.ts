/**
 * slides-paint.ts — turning extracted CSS colour into Slides fill/outline values.
 *
 * Colours arriving here are already `#rrggbb`: `extract-dom.ts:562`
 * (`rgbaToBlendedHex`) composites any `rgba()` onto whatever is painted behind
 * it during extraction, and `extraction.ts` rejects anything that is not a hex
 * triple. So this file never parses a CSS colour keyword — it only re-bases a
 * known hex into Slides' 0–1 channel space.
 */
import type { Paint, Gradient } from "./extraction.js";
import type { DashStyle, OpaqueColor, OptionalColor, RgbColor, SolidFill } from "./slides-api.js";

export function rgbColorFromHex(hex: string): RgbColor {
  const red = channel(hex, 1);
  const green = channel(hex, 3);
  const blue = channel(hex, 5);
  // Slides treats an omitted channel as 0; emitting all three keeps the request
  // readable in a log and avoids depending on that default.
  return { red, green, blue };
}

export function opaqueColorFromHex(hex: string): OpaqueColor {
  return { rgbColor: rgbColorFromHex(hex) };
}

export function optionalColorFromHex(hex: string): OptionalColor {
  return { opaqueColor: opaqueColorFromHex(hex) };
}

export function solidFillFromPaint(paint: Paint): SolidFill {
  return { color: opaqueColorFromHex(paint.hex), alpha: clamp01(paint.alpha) };
}

/**
 * Flatten a gradient to the one solid colour a Slides shape fill can hold.
 *
 * Each stop is weighted by the share of the gradient it dominates (half the gap
 * to each neighbour), so a gradient that sits at one colour for 80% of its run
 * flattens to that colour rather than to the midpoint of its endpoints. A plain
 * mean of the stop list gets that case visibly wrong.
 */
export function flattenGradient(gradient: Gradient): string {
  const stops = gradient.stops;
  // SAFETY: `extraction.ts`'s parseGradient returns null for an empty stop
  // list, so a Gradient value always has at least one stop.
  const first = stops[0]!;
  if (stops.length === 1) return first.hex;

  let totalWeight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let index = 0; index < stops.length; index++) {
    // SAFETY: index is bounded by stops.length.
    const stop = stops[index]!;
    const previous = index === 0 ? stop.position : stops[index - 1]!.position;
    const next = index === stops.length - 1 ? stop.position : stops[index + 1]!.position;
    const span = (stop.position - previous) / 2 + (next - stop.position) / 2;
    // A degenerate run (every stop at the same position) would weight to zero;
    // fall back to an equal share so the result is still the stops' mean.
    const weight = span > 0 ? span : 1 / stops.length;
    totalWeight += weight;
    red += channel(stop.hex, 1) * weight;
    green += channel(stop.hex, 3) * weight;
    blue += channel(stop.hex, 5) * weight;
  }
  if (totalWeight <= 0) return first.hex;
  return toHex({ red: red / totalWeight, green: green / totalWeight, blue: blue / totalWeight });
}

/**
 * CSS border-style to the nearest Slides dash style.
 *
 * `double`, `groove`, `ridge`, `inset` and `outset` have no Slides equivalent
 * and collapse to SOLID. They are not reported as anomalies: every one of them
 * still draws a line of the right colour and weight in roughly the right place,
 * and slide HTML in this pipeline does not use them.
 */
export function dashStyleFromCss(borderStyle: string): DashStyle {
  switch (borderStyle.trim().toLowerCase()) {
    case "dashed":
      return "DASH";
    case "dotted":
      return "DOT";
    default:
      return "SOLID";
  }
}

function channel(hex: string, offset: number): number {
  const text = hex.slice(offset, offset + 2);
  const value = Number.parseInt(text, 16);
  return Number.isFinite(value) ? value / 255 : 0;
}

function toHex(color: Readonly<{ red: number; green: number; blue: number }>): string {
  const part = (value: number): string =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(color.red)}${part(color.green)}${part(color.blue)}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
