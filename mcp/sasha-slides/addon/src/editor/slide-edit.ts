// THE EDIT RECORD — the only thing that travels to the model, and the whole reason this editor
// exists. See ../../UI-CONTRACT.md: the model learns the user's INTENT ("the title moved down",
// "the accent got darker") without a single byte of the slide's markup entering its context.
//
// Everything in this file is pure and DOM-free, so the algebra that decides what an edit MEANS is
// unit-testable without a browser. The DOM lives next door in apply-edits.ts / slide-editor.ts.
//
// GEOMETRY IS FRACTIONAL, NEVER PIXELS. The host scales the candidate's 1280x720 document with a
// CSS transform, so a pixel is whatever the sidebar is wide today; a fraction means the same thing
// at every zoom. The conversion happens exactly twice -- `fractionOfSlideX/Y/W/H` on the way in
// from a measurement, `slidePxOf*` on the way back out into a CSS declaration -- and nowhere else.

import { assertNever } from "../protocol.ts";

/** The candidate document's intrinsic size. Every fraction in this file is against this box. */
export const SLIDE_WIDTH_PX = 1280;
export const SLIDE_HEIGHT_PX = 720;

export type FractionalPoint = Readonly<{ x: number; y: number }>;
export type FractionalSize = Readonly<{ w: number; h: number }>;

/**
 * The two colours a user can change by pointing at something. `background` is the shorthand on
 * purpose: recolouring the background of a gradient card means replacing the gradient, and a
 * `background-color` under a `background-image` would silently do nothing.
 */
export type ColourProperty = "color" | "background";

/**
 * One structured edit. The five kinds are closed by the contract -- an interaction that cannot be
 * expressed as one of them is DROPPED WITH A WARNING, never approximated into a neighbouring kind.
 */
export type SlideEdit =
  | Readonly<{ kind: "moved"; target: string; from: FractionalPoint; to: FractionalPoint }>
  | Readonly<{ kind: "resized"; target: string; from: FractionalSize; to: FractionalSize }>
  | Readonly<{ kind: "recoloured"; target: string; property: ColourProperty; from: string; to: string }>
  | Readonly<{ kind: "retext"; target: string; to: string }>
  | Readonly<{ kind: "removed"; target: string }>;

export function fractionOfSlideX(px: number): number {
  return roundFraction(px / SLIDE_WIDTH_PX);
}

export function fractionOfSlideY(px: number): number {
  return roundFraction(px / SLIDE_HEIGHT_PX);
}

export function slidePxOfX(fraction: number): number {
  return roundPx(fraction * SLIDE_WIDTH_PX);
}

export function slidePxOfY(fraction: number): number {
  return roundPx(fraction * SLIDE_HEIGHT_PX);
}

/**
 * Append one completed gesture to the record list.
 *
 * COALESCING. A pointer drag is thousands of positions; only the finished gesture is recorded. Two
 * finished gestures of the same kind on the same target still collapse into one record that keeps
 * the FIRST `from` and the LAST `to`, because "the title ended up here" is the intent and "the
 * title moved 4px, then 60px more" is noise the model would have to re-derive. The cost is that
 * `undo()` then steps back the whole run of same-kind gestures, which is documented on `undo`.
 *
 * A gesture that ends where it began is not an edit and is dropped, including when coalescing
 * cancels an earlier one out (drag away, drag back) -- the record list is the user's INTENT, and
 * they intended nothing.
 */
export function appendEdit({ edits, edit }: { edits: readonly SlideEdit[]; edit: SlideEdit }): readonly SlideEdit[] {
  if (isNoOp(edit)) return edits;
  const last = edits[edits.length - 1];
  if (last === undefined || !isSameSubject({ left: last, right: edit })) return [...edits, edit];
  const merged = mergeOntoPrevious({ previous: last, next: edit });
  const kept = edits.slice(0, -1);
  return merged === null || isNoOp(merged) ? kept : [...kept, merged];
}

/**
 * Everything the record list says about one target, folded in order: the last `to` wins, the first
 * `from` is kept. This is the single source of truth for BOTH what the live document shows and
 * what `html()` writes back, which is why `html()` round-trips by construction rather than by
 * a second, parallel code path that could drift.
 */
export type TargetOverride = Readonly<{
  target: string;
  position: Readonly<{ from: FractionalPoint; to: FractionalPoint }> | null;
  size: Readonly<{ from: FractionalSize; to: FractionalSize }> | null;
  colours: readonly Readonly<{ property: ColourProperty; to: string }>[];
  /** The plain text the user typed, or null when they never retexted this element. */
  text: string | null;
  removed: boolean;
}>;

/** Folded overrides, one per target, in the order each target was first touched. */
export function overridesOf(edits: readonly SlideEdit[]): readonly TargetOverride[] {
  const byTarget = new Map<string, TargetOverride>();
  for (const edit of edits) {
    const current = byTarget.get(edit.target) ?? emptyOverride(edit.target);
    byTarget.set(edit.target, withEdit({ override: current, edit }));
  }
  return [...byTarget.values()];
}

/** One CSS declaration to write onto an element's own `style` attribute. */
export type CssDeclaration = Readonly<{ property: string; value: string; important: boolean }>;

/**
 * What the element measured at attach time, so a declaration can be composed against it rather
 * than clobbering it. `transform` is the only one that composes; `inlineStyle` is kept so undo can
 * put the element back exactly as its author wrote it.
 */
export type ElementBaseline = Readonly<{
  /** Computed `transform` at attach: a matrix string, or "none". */
  transform: string;
  /** The element's own `style` attribute at attach, "" when it had none. */
  inlineStyle: string;
}>;

/**
 * The declarations that express one target's override.
 *
 * `important` is set on every one of them. The candidate is arbitrary third-party CSS and may well
 * have `#id h1 { color: … !important }`; an override the slide's own stylesheet beats is a lie on
 * screen, and the user would watch their click do nothing. The trade-off is that these five
 * properties stop responding to the slide's own rules for that element -- harmless on a static
 * 1280x720 document that has no media queries, no :hover state worth keeping and no animation.
 *
 * A MOVE IS A TRANSLATE, NOT AN ABSOLUTE POSITION. `position: absolute; left; top` is the obvious
 * expression and the wrong one: it rips the element out of flow, so every sibling after it in a
 * flex row, a grid cell or a text column re-lays-out, and the user's "nudge the title down" silently
 * reflows the slide they were happy with. `transform: translate(dx, dy)` leaves the layout box
 * exactly where the author put it and moves only the paint, so nothing else on the slide can move.
 * The costs, both accepted: the vacated space is not reclaimed (a moved element leaves a hole, and
 * can overlap a neighbour -- which is what the user asked for), and the element's own transform has
 * to be composed rather than replaced. The translate is PREPENDED so it applies in the parent's
 * coordinate space: `translate(…) rotate(20deg)` moves a rotated badge the way the pointer moved,
 * where `rotate(20deg) translate(…)` would send it off along its own rotated axis.
 */
export function declarationsFor({
  override,
  baseline,
}: {
  override: TargetOverride;
  baseline: ElementBaseline;
}): readonly CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  if (override.position !== null) {
    const dx = roundPx(slidePxOfX(override.position.to.x) - slidePxOfX(override.position.from.x));
    const dy = roundPx(slidePxOfY(override.position.to.y) - slidePxOfY(override.position.from.y));
    const base = baseline.transform === "none" || baseline.transform.trim() === "" ? "" : ` ${baseline.transform}`;
    declarations.push({ property: "transform", value: `translate(${dx}px, ${dy}px)${base}`, important: true });
  }
  if (override.size !== null) {
    // The record carries the BORDER box, because that is what `getBoundingClientRect` measures and
    // what the user dragged the handle to. `border-box` sizing is what makes the two agree.
    declarations.push({ property: "box-sizing", value: "border-box", important: true });
    declarations.push({ property: "width", value: `${slidePxOfX(override.size.to.w)}px`, important: true });
    declarations.push({ property: "height", value: `${slidePxOfY(override.size.to.h)}px`, important: true });
  }
  for (const colour of override.colours) {
    declarations.push({ property: colour.property, value: colour.to, important: true });
  }
  return declarations;
}

/** The targets the user deleted: hidden in the live document, gone from `html()`. */
export function removedTargetsOf(overrides: readonly TargetOverride[]): readonly string[] {
  return overrides.filter((override) => override.removed).map((override) => override.target);
}

/** One line a human can read in a log or a review row. */
export function describeEdit(edit: SlideEdit): string {
  switch (edit.kind) {
    case "moved":
      return `moved ${edit.target} to ${percent(edit.to.x)},${percent(edit.to.y)}`;
    case "resized":
      return `resized ${edit.target} to ${percent(edit.to.w)}x${percent(edit.to.h)}`;
    case "recoloured":
      return `recoloured ${edit.target} ${edit.property} to ${edit.to}`;
    case "retext":
      return `retext ${edit.target} to "${edit.to}"`;
    case "removed":
      return `removed ${edit.target}`;
    default:
      return assertNever(edit);
  }
}

/** 1e-4 of the slide is 0.128px wide: finer than anything anyone can drag, and short to read. */
function roundFraction(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : 0;
}

function roundPx(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

function emptyOverride(target: string): TargetOverride {
  return { target, position: null, size: null, colours: [], text: null, removed: false };
}

function withEdit({ override, edit }: { override: TargetOverride; edit: SlideEdit }): TargetOverride {
  switch (edit.kind) {
    case "moved":
      return { ...override, position: { from: override.position?.from ?? edit.from, to: edit.to } };
    case "resized":
      return { ...override, size: { from: override.size?.from ?? edit.from, to: edit.to } };
    case "recoloured":
      return {
        ...override,
        colours: [
          ...override.colours.filter((colour) => colour.property !== edit.property),
          { property: edit.property, to: edit.to },
        ],
      };
    case "retext":
      return { ...override, text: edit.to };
    case "removed":
      return { ...override, removed: true };
    default:
      return assertNever(edit);
  }
}

function isNoOp(edit: SlideEdit): boolean {
  switch (edit.kind) {
    case "moved":
      return edit.from.x === edit.to.x && edit.from.y === edit.to.y;
    case "resized":
      return edit.from.w === edit.to.w && edit.from.h === edit.to.h;
    case "recoloured":
      return edit.from === edit.to;
    case "retext":
    case "removed":
      return false;
    default:
      return assertNever(edit);
  }
}

/** Same kind, same element, and for a recolour the same property -- i.e. the same subject. */
function isSameSubject({ left, right }: { left: SlideEdit; right: SlideEdit }): boolean {
  if (left.target !== right.target || left.kind !== right.kind) return false;
  if (left.kind === "recoloured" && right.kind === "recoloured") return left.property === right.property;
  return true;
}

/** Null when the pair does not coalesce; the callers have already proved they share a subject. */
function mergeOntoPrevious({ previous, next }: { previous: SlideEdit; next: SlideEdit }): SlideEdit | null {
  switch (next.kind) {
    case "moved":
      return previous.kind === "moved" ? { ...next, from: previous.from } : null;
    case "resized":
      return previous.kind === "resized" ? { ...next, from: previous.from } : null;
    case "recoloured":
      return previous.kind === "recoloured" ? { ...next, from: previous.from } : null;
    case "retext":
      return next;
    case "removed":
      return next;
    default:
      return assertNever(next);
  }
}
