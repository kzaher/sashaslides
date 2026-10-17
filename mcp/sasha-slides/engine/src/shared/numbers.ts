// NUMBERS: the one rounding rule for values the engine prints or compares. Style declarations,
// shape paths, morph transforms, build keyframes, gradient stops and the properties panel all round
// to a fixed number of decimals so markup stays stable and typed percentages stay exact.

/** Rounds to `digits` decimals; never returns -0 (it would print as "0" anyway, but compares unequal to 0 with Object.is). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}
