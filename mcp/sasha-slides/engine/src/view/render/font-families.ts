// FONT FAMILIES AS THE BROWSER SHOULD ASK FOR THEM: the family a run names, then a web font that
// draws it with the same metrics where it is not installed, then a generic family of the same kind.
//
// Why: Google Slides draws Georgia, Calibri and Cambria with the real faces on every machine. A
// browser without them (Linux, the container that screenshots exported slides, a Chromebook) fell
// through to its default sans-serif, so a serif title turned sans and its lines broke elsewhere.
// Measured on the reverse round trip of the test deck (1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U):
// "Part 2: Savings" and "Thank you" drew in Liberation Sans instead of a serif.
//
// Key decisions:
//
//  * A STAND-IN ONLY WHERE A METRIC-COMPATIBLE ONE IS ON GOOGLE FONTS AND THE PLATFORMS LACK AN
//    ALIAS: Georgia -> Gelasio, Calibri -> Carlito, Cambria -> Caladea. Each has the same advance
//    widths as the face it stands in for, so lines break where Google breaks them. Arial,
//    Helvetica, Times New Roman and Courier New ask for nothing more: fontconfig already resolves
//    them to the metric-compatible Liberation faces (measured with CSS.getPlatformFontsForNode in
//    the container's Chrome), and Mac and Windows have them installed.
//  * THE NAMED FAMILY STAYS FIRST, so a machine that has Georgia draws Georgia; the stand-in is
//    only reached where it is missing.
//  * THE GENERIC FAMILY FOLLOWS THE KIND OF FACE (serif, monospace or sans-serif), so a family whose
//    web font failed to load still keeps its kind instead of turning sans.
//  * THE STAND-IN SITS ON THE ORIGINAL'S BASELINE. Equal advance widths are not enough: a line box
//    of fixed height places the baseline by the face's ascent and descent, and Gelasio's (0.928 and
//    0.342 em, measured with Chrome's canvas) put a 100 px Georgia title 6 px above Google's. A
//    stand-in with a measured difference carries the original's metrics (Georgia's hhea table: 1878
//    and 449 of 2048 units, no line gap) as ascent, descent and line-gap overrides, which the page
//    sets on the stand-in's loaded faces (`applyFontMetricOverrides`; the export's layout pass does
//    the same from its settings). They are skipped where the slide names the stand-in family
//    itself, so a run set in Gelasio keeps Gelasio's own metrics. Carlito and Caladea are not
//    measured against Google yet, so they have none.
//  * HELVETICA NEUE GETS NO STAND-IN. Google draws it with its Arial fallback, and Chrome here
//    resolves it to Liberation Sans, Arial's metric twin (reverse mismatch 0.01% on the deck's
//    Helvetica Neue slides), so the generic sans-serif is already right.

import type { FontFaceRequest } from "../../contracts/render.ts";

const SYSTEM_FAMILIES: ReadonlySet<string> = new Set(["arial", "helvetica", "times new roman", "georgia", "courier new", "verdana", "sans-serif", "serif", "monospace", "system-ui"]);

/** The kind of face a generic family names, the last entry of every family list. */
export type GenericFontFamily = "serif" | "sans-serif" | "monospace";

/** Vertical metrics a stand-in takes from the face it stands in for, as CSS percentages of the em. */
export type FontMetricOverride = Readonly<{ family: string; ascent: string; descent: string; lineGap: string }>;

/** A family as a stylesheet value: the family, quoted, then its stand-in, then its generic kind. */
export function fontFamilyValue(family: string): string {
  const standIn = fontStandInOf(family);
  const quoted = [family, ...(standIn === null ? [] : [standIn])].map((name) => `"${name.replace(/["\\]/g, "")}"`);
  return [...quoted, genericFontFamilyOf(family)].join(", ");
}

/** Whether a family is a system or generic one, which is never requested from Google Fonts. */
export function isSystemFontFamily(family: string): boolean {
  return SYSTEM_FAMILIES.has(family.toLowerCase());
}

/**
 * The faces a page must load to draw `faces`: each face, followed by the same face of its stand-in
 * when the family has one. Order is kept and duplicates are dropped.
 */
export function withFontStandIns(faces: readonly FontFaceRequest[]): readonly FontFaceRequest[] {
  const requested = new Map<string, FontFaceRequest>();
  const add = (face: FontFaceRequest): void => {
    const key = `${face.family}|${face.weight}|${face.style}`;
    if (!requested.has(key)) requested.set(key, face);
  };
  for (const face of faces) {
    add(face);
    const standIn = fontStandInOf(face.family);
    if (standIn !== null) add({ ...face, family: standIn });
  }
  return [...requested.values()];
}

/**
 * The overrides that put each stand-in drawn for one of `families` on the original's baseline,
 * except for a stand-in that `families` also names directly (see the header).
 */
export function fontMetricOverridesFor(families: Iterable<string>): readonly FontMetricOverride[] {
  const named = new Set([...families].map(normalisedFamily));
  const overrides = new Map<string, FontMetricOverride>();
  for (const family of named) {
    const standIn = STAND_INS.get(family);
    if (standIn === undefined || standIn.metrics === null || named.has(normalisedFamily(standIn.family))) continue;
    overrides.set(standIn.family, { family: standIn.family, ...standIn.metrics });
  }
  return [...overrides.values()];
}

/** The part of a `FontFace` an override sets; a page's `document.fonts` is a set of them. */
export type MetricOverridableFace = { readonly family: string; ascentOverride: string; descentOverride: string; lineGapOverride: string };

/** Gives every face the page has of each overridden family (stylesheet faces included) its override. */
export function applyFontMetricOverrides(fonts: Readonly<{ forEach: (visit: (face: MetricOverridableFace) => void) => void }>, overrides: readonly FontMetricOverride[]): void {
  if (overrides.length === 0) return;
  fonts.forEach((face) => {
    const override = overrides.find((candidate) => candidate.family === face.family.replace(/["']/g, ""));
    if (override === undefined) return;
    face.ascentOverride = override.ascent;
    face.descentOverride = override.descent;
    face.lineGapOverride = override.lineGap;
  });
}

/** The Google Fonts family that draws `family` with the same advance widths where it is missing, or null. */
export function fontStandInOf(family: string): string | null {
  return STAND_INS.get(normalisedFamily(family))?.family ?? null;
}

/** Whether `family` is a serif, monospace or sans-serif face (sans-serif when nothing says otherwise). */
export function genericFontFamilyOf(family: string): GenericFontFamily {
  const name = normalisedFamily(family);
  if (MONOSPACE_FAMILIES.has(name) || /\bmono\b|\bcode\b/.test(name)) return "monospace";
  if (SERIF_FAMILIES.has(name) || /\bslab\b/.test(name) || (/\bserif\b/.test(name) && !/\bsans\b/.test(name))) return "serif";
  return "sans-serif";
}

type StandIn = Readonly<{ family: string; metrics: Readonly<{ ascent: string; descent: string; lineGap: string }> | null }>;

/** Metric-compatible stand-ins on Google Fonts, keyed by the lower-case family (see the header). */
const STAND_INS: ReadonlyMap<string, StandIn> = new Map([
  ["georgia", { family: "Gelasio", metrics: { ascent: "91.699%", descent: "21.924%", lineGap: "0%" } }],
  ["calibri", { family: "Carlito", metrics: null }],
  ["cambria", { family: "Caladea", metrics: null }],
]);

const SERIF_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "georgia",
  "gelasio",
  "cambria",
  "caladea",
  "times",
  "times new roman",
  "tinos",
  "liberation serif",
  "garamond",
  "palatino",
  "palatino linotype",
  "book antiqua",
  "baskerville",
  "constantia",
  "century schoolbook",
  "didot",
  "bodoni 72",
  "hoefler text",
  "big caslon",
  "rockwell",
]);

const MONOSPACE_FAMILIES: ReadonlySet<string> = new Set(["monospace", "courier", "courier new", "cousine", "liberation mono", "consolas", "menlo", "monaco", "lucida console"]);

function normalisedFamily(family: string): string {
  return family.trim().replace(/\s+/g, " ").toLowerCase();
}
