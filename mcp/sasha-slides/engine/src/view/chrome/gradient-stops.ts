// GRADIENT EDITING AS VALUES (SPEC.md 21.9, review fix 3): a stop's position, adding and removing
// stops (2 to 10), the radial centre and the linear angle, each a pure function from one `Fill` to
// the next, so the panel's controls only dispatch the result and a test can check it exactly.
// Positions are fractions 0 to 1 in the fill; the panel shows them as percent.

import type { Fill, GradientStop } from "../../contracts/style.ts";
import { roundTo } from "../../shared/numbers.ts";

export type GradientFill = Extract<Fill, { kind: "linearGradient" | "radialGradient" }>;

export const MINIMUM_GRADIENT_STOPS = 2;
export const MAXIMUM_GRADIENT_STOPS = 10;

/** Stop `index` moved to `offset` (clamped to 0..1); the stops stay in offset order. */
export function withStopOffset(fill: GradientFill, options: Readonly<{ index: number; offset: number }>): GradientFill {
  const offset = clampFraction(options.offset);
  const moved = fill.stops.map((stop, index) => (index === options.index ? { ...stop, offset } : stop));
  return { ...fill, stops: sortedStops(moved) };
}

export function withStopColour(fill: GradientFill, options: Readonly<{ index: number; colour: GradientStop["colour"] }>): GradientFill {
  return { ...fill, stops: fill.stops.map((stop, index) => (index === options.index ? { ...stop, colour: options.colour } : stop)) };
}

/**
 * One more stop, in the middle of the widest gap, with the colour of the stop before it; null
 * (refused) at MAXIMUM_GRADIENT_STOPS.
 */
export function withAddedStop(fill: GradientFill): GradientFill | null {
  if (fill.stops.length >= MAXIMUM_GRADIENT_STOPS) return null;
  const stops = sortedStops(fill.stops);
  let widest = 0;
  for (let index = 1; index < stops.length; index += 1) {
    if (gap(stops, index) > gap(stops, widest)) widest = index;
  }
  const after = stops[widest];
  const before = stops[widest - 1];
  if (after === undefined) return null;
  const offset = before === undefined ? after.offset / 2 : (before.offset + after.offset) / 2;
  const added: GradientStop = { colour: (before ?? after).colour, offset: roundFraction(offset) };
  return { ...fill, stops: sortedStops([...stops.slice(0, widest), added, ...stops.slice(widest)]) };
}

/** Stop `index` removed; null (refused) when only MINIMUM_GRADIENT_STOPS remain. */
export function withoutStop(fill: GradientFill, index: number): GradientFill | null {
  if (fill.stops.length <= MINIMUM_GRADIENT_STOPS) return null;
  return { ...fill, stops: fill.stops.filter((_, stopIndex) => stopIndex !== index) };
}

/** A radial gradient's centre, fractions of the element box, each clamped to 0..1. */
export function withRadialCentre(fill: Extract<Fill, { kind: "radialGradient" }>, centre: Readonly<{ x?: number; y?: number }>): Extract<Fill, { kind: "radialGradient" }> {
  return { ...fill, centreX: centre.x === undefined ? fill.centreX : clampFraction(centre.x), centreY: centre.y === undefined ? fill.centreY : clampFraction(centre.y) };
}

/** A linear gradient's angle in degrees, normalised to [0, 360). */
export function withLinearAngle(fill: Extract<Fill, { kind: "linearGradient" }>, angle: number): Extract<Fill, { kind: "linearGradient" }> {
  return { ...fill, angle: ((angle % 360) + 360) % 360 };
}

/** The gap before stop `index` (from 0 for the first stop). */
function gap(stops: readonly GradientStop[], index: number): number {
  const stop = stops[index];
  if (stop === undefined) return -1;
  return stop.offset - (stops[index - 1]?.offset ?? 0);
}

function sortedStops(stops: readonly GradientStop[]): readonly GradientStop[] {
  return stops.map((stop, index) => ({ stop, index })).sort((first, second) => first.stop.offset - second.stop.offset || first.index - second.index).map((entry) => entry.stop);
}

function clampFraction(value: number): number {
  return roundFraction(Math.max(0, Math.min(1, value)));
}

/** Four decimals: a typed "40 %" stays exactly 0.4, not 0.39999999999999997. */
function roundFraction(value: number): number {
  return roundTo(value, 4);
}
