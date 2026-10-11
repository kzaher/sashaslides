// WHERE A COMMENT COMPOSER SITS, given the thing it is about.
//
// This is the geometry half of "comment on what you clicked" -- the interaction Claude's own
// artifact comments use, and the one the annotate tool now follows: hover highlights an element,
// a click selects it, and a composer opens ANCHORED TO IT rather than in a list somewhere else.
// A composer that is not attached to its subject makes the user carry the association in their
// head, which is the whole reason the old drag-a-box-then-scroll-to-a-row flow felt like filing a
// bug report instead of pointing at something.
//
// IT IS PURE, AND IN ITS OWN FILE, because placement is the part that has edge cases: a selection
// at the bottom of the slide, a selection at the right edge, a selection taller than the room
// below it. Those are decisions, and a decision with edge cases should be a tested function
// rather than a few clamps buried in JSX.
//
// EVERYTHING IS A FRACTION of the stage, 0-1, the same convention `Region` uses everywhere else
// in the product (region-overlay.tsx): the stage is 16:9 at whatever pixel size the dialog gives
// it, so fractions are the only coordinates that mean the same thing at every width.

import type { Region } from "./protocol.ts";

/** How tall the composer is, as a fraction of the stage. Measured from the rendered card. */
export const COMPOSER_HEIGHT = 0.3;
/** How wide, likewise. Wide enough for a sentence at the dialog's smallest stage. */
export const COMPOSER_WIDTH = 0.42;
/** The gap between the selection's edge and the composer, so the outline stays readable. */
export const COMPOSER_GAP = 0.015;

/**
 * An element's measured box, trimmed to the slide.
 *
 * A measurement is NOT automatically a legal `Region`. An element can start inside the slide and
 * run past its edge -- a full-bleed wrapper with a few pixels of margin measures y=0.03 h=1.0,
 * so y+h is 1.03 -- and a sub-pixel rounding can do the same at the boundary. The comment
 * channel refuses anything that is not a 0-1 box ("nothing was sent: the marked region is not a
 * 0-1 box"), so without this the user clicks a thing, types a sentence, presses Comment and
 * nothing happens. Measured on a real candidate before this existed.
 *
 * Trimming rather than refusing: the part of the element that is ON the slide is exactly what
 * the user is pointing at, since the rest of it is not visible to them either.
 */
export function regionOnSlide(region: Region): Region {
  const x = clampUnit(region.x);
  const y = clampUnit(region.y);
  return {
    x,
    y,
    w: clampUnit(Math.min(region.w, 1 - x)),
    h: clampUnit(Math.min(region.h, 1 - y)),
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export type ComposerPlacement = Readonly<{
  /** Fractional box for the composer itself, inside the stage. */
  left: number;
  top: number;
  width: number;
  /** Which side of the selection it ended up on -- the caller points a tail at the subject. */
  side: "below" | "above";
}>;

/**
 * Place the composer under the selection, or over it when there is no room underneath.
 *
 * BELOW IS THE DEFAULT because a comment reads as a consequence of the thing above it, and
 * because the selection stays visible while typing. It flips rather than shrinks: a composer
 * squeezed into 40 px of leftover space is worse than one that covers a little of the slide.
 */
export function composerPlacementFor(region: Region): ComposerPlacement {
  const roomBelow = 1 - (region.y + region.h);
  const roomAbove = region.y;
  const needed = COMPOSER_HEIGHT + COMPOSER_GAP;
  // Below unless it genuinely will not fit AND above fits better. A selection that fills the
  // slide has room nowhere, and then below is still the better answer: it covers the bottom,
  // which is where the least of a slide's meaning usually is.
  const side: "below" | "above" = roomBelow >= needed || roomBelow >= roomAbove ? "below" : "above";
  const top =
    side === "below"
      ? Math.min(region.y + region.h + COMPOSER_GAP, 1 - COMPOSER_HEIGHT)
      : Math.max(region.y - COMPOSER_GAP - COMPOSER_HEIGHT, 0);
  return {
    left: clamp01(region.x, COMPOSER_WIDTH),
    top: clampTop(top),
    width: COMPOSER_WIDTH,
    side,
  };
}

/**
 * The composer's left edge: aligned with the selection, pulled back so its right edge stays on
 * the stage. A composer that runs off the right of the slide is clipped by the stage's
 * `overflow: hidden` and the Comment button goes with it.
 */
function clamp01(left: number, width: number): number {
  if (left + width > 1) return Math.max(0, 1 - width);
  return Math.max(0, left);
}

function clampTop(top: number): number {
  if (top + COMPOSER_HEIGHT > 1) return Math.max(0, 1 - COMPOSER_HEIGHT);
  return Math.max(0, top);
}

/**
 * The selector, shortened for the composer's heading.
 *
 * A generated selector is often a long chain (`div > section:nth-of-type(2) > h1`) and the user
 * does not need the chain -- they can see what they clicked. The LAST step names the thing.
 */
export function describeSelected(target: string): string {
  const steps = target.split(">").map((step) => step.trim()).filter((step) => step.length > 0);
  const last = steps[steps.length - 1] ?? target;
  // Strip an `:nth-of-type(2)` tail: it disambiguates for the machine and means nothing here.
  const bare = last.replace(/:nth-[a-z-]+\([^)]*\)/g, "");
  return bare.length === 0 ? target : bare;
}
