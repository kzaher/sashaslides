/**
 * fixture-render.ts — the "render service" adapter that turns the merge
 * integration test's on-disk converter into REAL per-slide PNGs, and computes
 * the changed-slide set from ACTUAL pixel diffs (no scripted list).
 *
 * The converter under test (renderer/html2slides/convert.ts in the temp repo)
 * exposes a handful of numbered feature functions:
 *
 *   borderWidth() → return N; // L03 BORDER
 *   shadowBlur()  → return N; // L06 SHADOW
 *   gradientStops()→ return N; // L09 GRADIENT
 *   radius()      → return N; // L12 RADIUS
 *
 * Each fixture slide is bound to ONE feature; its rendered text is
 * `<FEATURE> <current-value>` extracted LIVE from the converter file on disk.
 * So when a cluster's edit changes a feature's value, EVERY slide bound to that
 * feature renders different text ⇒ a different PNG ⇒ the pixel diff flags it.
 * Slides bound to features the edit did not touch render byte-identical.
 *
 * This is what makes the ripple REAL: the gradient cluster's edit changes BOTH
 * the GRADIENT value (its intended slide) AND the RADIUS value (a non-intended
 * slide bound to RADIUS) → the pixel diff genuinely detects the extra slide.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSlideTextPng, pngPixelsDiffer } from "./small-text-png.js";

/** Feature keyword each converter line is tagged with. */
export type Feature = "BORDER" | "SHADOW" | "GRADIENT" | "RADIUS" | "INSET";

/**
 * Which converter feature each fixture slide's rendered text is derived from —
 * a clean 1:1 slide↔feature binding so a single-feature edit changes exactly one
 * slide's pixels. (The deck is slide_02/04/05/07/09 — see makeFixtureRepo.)
 *   - slide_02 → BORDER  (L03)  ← the border cluster's slide (edits L03)
 *   - slide_04 → RADIUS  (L12)  ← the conflict clusters' slide; a resolved
 *                                 border/radius merge lands its change on RADIUS
 *                                 so it renders WITHOUT disturbing slide_02.
 *   - slide_05 → GRADIENT(L09)  ← the gradient cluster's INTENDED slide
 *   - slide_07 → SHADOW  (L06)  ← the shadow cluster's slide
 *   - slide_09 → INSET   (L15)  ← the RIPPLE slide: editGradient ALSO perturbs
 *                                 INSET, so gradient's compose changes an EXTRA,
 *                                 non-intended slide the real pixel-diff catches.
 */
export const SLIDE_FEATURE: Record<string, Feature> = {
  slide_02: "BORDER",
  slide_04: "RADIUS",
  slide_05: "GRADIENT",
  slide_07: "SHADOW",
  slide_09: "INSET",
};

/** Extract a feature's current value from the converter body. A conflict-marked
 *  or otherwise unparsable region yields a sentinel so its PNG still differs. */
export function featureValue(converterText: string, feat: Feature): string {
  // match e.g.  `  return 11; // L03 BORDER ...`  → capture the numeric literal(s).
  const re = new RegExp(`return\\s+([^;]+);\\s*//\\s*L\\d+\\s+${feat}`);
  const m = converterText.match(re);
  return m ? m[1].replace(/\s+/g, "") : "NA";
}

/** The rendered text for one slide, derived from the current converter on disk. */
export function slideText(converterText: string, slideId: string): string {
  const feat = SLIDE_FEATURE[slideId] ?? "BORDER";
  return `${feat} ${featureValue(converterText, feat)}`;
}

/**
 * Render EVERY deck slide to a PNG under `dir/<slide>.png`, deriving each
 * slide's text from `converterText`. Deterministic (pure fn of converterText).
 */
export function renderDeck(converterText: string, slideIds: string[], dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const sid of slideIds) {
    renderSlideTextPng(slideText(converterText, sid), join(dir, `${sid}.png`));
  }
}

/**
 * The REAL renderAndDiff: render the current staging converter's deck into
 * `outDir` and, when a baseline is given, return the slides whose PNG differs
 * pixel-for-pixel from the baseline. `baselineDir===null` establishes the
 * baseline (renders + returns []).
 *
 * `readConverter()` returns the current composed converter text off the staging
 * tree; `slideIds` is the fixture deck.
 */
export function realRenderAndDiff(
  readConverter: () => string,
  slideIds: string[],
  baselineDir: string | null,
  outDir: string,
): string[] {
  const converter = readConverter();
  renderDeck(converter, slideIds, outDir);
  if (baselineDir === null) return [];
  const changed: string[] = [];
  for (const sid of slideIds) {
    const a = join(baselineDir, `${sid}.png`);
    const b = join(outDir, `${sid}.png`);
    if (!existsSync(a) || !existsSync(b)) { changed.push(sid); continue; }
    if (pngPixelsDiffer(a, b)) changed.push(sid);
  }
  return changed.sort();
}

/** Convenience: read the converter file off the staging worktree (null-safe). */
export function readStagingConverter(stagingDir: string, converterRel: string): string {
  try { return readFileSync(join(stagingDir, converterRel), "utf8"); } catch { return ""; }
}

/** Render ONE slide's real PNG (text derived from `converterText`) to `outPath`. */
export function renderSlideTextPngToFile(converterText: string, slideId: string, outPath: string): number {
  return renderSlideTextPng(slideText(converterText, slideId), outPath);
}
