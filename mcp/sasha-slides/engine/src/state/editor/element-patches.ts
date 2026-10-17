// MULTI-SELECTION EDITS MERGE PER ELEMENT (SPEC.md 21.9, review fix 1). A style group -- a text
// box's padding, a line's stroke, a border, a shadow, a corner radius, a crop -- is ONE stored value
// per element (yjs-schema.ts), so the panel's patch for "padding top = 5" carries a whole
// `TextBoxStyle`. Milestone 1 wrote that whole value onto every selected element, so two text boxes
// with different left paddings both ended up with the first one's left padding. Here each element
// gets ITS OWN group with only the fields the user changed replaced.
//
// Key decisions:
//
//  * WHAT CHANGED IS READ AGAINST THE PANEL'S BASE. The panel builds a group patch from the FIRST
//    selected leaf that has that group (`patchBaseOf`; the view uses the same rule) with one field
//    replaced. Comparing the patch with that base names the changed fields without a new event
//    shape. The cost, accepted until the contract carries the field name: typing exactly the first
//    element's current value into a field shown as "mixed" changes nothing on the others.
//  * A CHANGE OF KIND IS WHOLE. Switching a border from none to all sides, a shadow on, a corner
//    radius from uniform to per corner, or any fill sets the same value everywhere: there is no
//    "own value" of a kind the element does not have.
//  * EQUAL RESULTS SHARE ONE COMMAND. Elements whose merged patches are equal travel in one
//    `updateElements`, so a single selected element (or a selection that already agreed) queues
//    exactly the command milestone 1 queued. Everything stays one envelope: one undo step.

import {
  assertNever,
  type Border,
  type CornerRadius,
  type ElementId,
  type ElementPatch,
  type ElementSnapshot,
  type ImageCrop,
  type Shadow,
  type Stroke,
  type TextBoxStyle,
} from "../../contracts/index.ts";
import { firstDrawnStroke } from "../../shared/element-tree.ts";
import { sameValue } from "./text-model.ts";

/** One `updateElements` worth: these elements receive this patch. */
export type ElementPatchGroup = Readonly<{ elementIds: readonly ElementId[]; patch: ElementPatch }>;

/** The patch each of `leaves` should receive, grouped by equal patches, in selection order. */
export function perElementPatches(options: Readonly<{ leaves: readonly ElementSnapshot[]; patch: ElementPatch }>): readonly ElementPatchGroup[] {
  const base = patchBaseOf(options.leaves);
  const groups: { elementIds: ElementId[]; patch: ElementPatch }[] = [];
  for (const leaf of options.leaves) {
    const patch = mergedPatchFor({ leaf, base, patch: options.patch });
    const existing = groups.find((group) => sameValue(group.patch, patch));
    if (existing === undefined) {
      groups.push({ elementIds: [leaf.id], patch });
      continue;
    }
    existing.elementIds.push(leaf.id);
  }
  return groups;
}

/** The style groups of the first leaf that has each one: what the panel builds a group patch from. */
export type PatchBase = Readonly<{
  textBox: TextBoxStyle | null;
  stroke: Stroke | null;
  border: Border | null;
  shadow: Shadow | null | undefined;
  cornerRadius: CornerRadius | null;
  crop: ImageCrop | null;
}>;

export function patchBaseOf(leaves: readonly ElementSnapshot[]): PatchBase {
  const groups = leaves.map(styleGroupsOf);
  const first = <TValue>(read: (groups: StyleGroups) => TValue | undefined): TValue | undefined => groups.map(read).find((value) => value !== undefined);
  return {
    textBox: first((group) => group.textBox) ?? null,
    stroke: first((group) => group.stroke) ?? null,
    border: first((group) => group.border) ?? null,
    shadow: groups.find((group) => group.hasBox)?.shadow,
    cornerRadius: first((group) => group.cornerRadius) ?? null,
    crop: first((group) => group.crop) ?? null,
  };
}

function mergedPatchFor(options: Readonly<{ leaf: ElementSnapshot; base: PatchBase; patch: ElementPatch }>): ElementPatch {
  const own = styleGroupsOf(options.leaf);
  const patch = options.patch;
  const base = options.base;
  return {
    ...patch,
    ...(patch.textBox === undefined || own.textBox === undefined || base.textBox === null ? {} : { textBox: mergeChangedFields({ own: own.textBox, base: base.textBox, next: patch.textBox }) }),
    ...(patch.stroke === undefined || own.stroke === undefined || base.stroke === null ? {} : { stroke: mergeChangedFields({ own: own.stroke, base: base.stroke, next: patch.stroke }) }),
    ...(patch.crop === undefined || own.crop === undefined || base.crop === null ? {} : { crop: mergeChangedFields({ own: own.crop, base: base.crop, next: patch.crop }) }),
    ...(patch.border === undefined || own.border === undefined || base.border === null ? {} : { border: mergeBorder({ own: own.border, base: base.border, next: patch.border }) }),
    ...(patch.shadow === undefined || !own.hasBox || base.shadow === undefined ? {} : { shadow: mergeShadow({ own: own.shadow ?? null, base: base.shadow, next: patch.shadow }) }),
    ...(patch.cornerRadius === undefined || own.cornerRadius === undefined || base.cornerRadius === null ? {} : { cornerRadius: mergeCornerRadius({ own: own.cornerRadius, base: base.cornerRadius, next: patch.cornerRadius }) }),
  };
}

/** `own` with every field where `base` and `next` differ taken from `next`. */
export function mergeChangedFields<TGroup extends Readonly<Record<string, unknown>>>(options: Readonly<{ own: TGroup; base: TGroup; next: TGroup }>): TGroup {
  const changed = Object.keys(options.next).filter((key) => !sameValue(options.base[key], options.next[key]));
  if (changed.length === 0) return options.own;
  return { ...options.own, ...Object.fromEntries(changed.map((key) => [key, options.next[key]])) };
}

function mergeShadow(options: Readonly<{ own: Shadow | null; base: Shadow | null; next: Shadow | null }>): Shadow | null {
  if (options.next === null || options.base === null || options.own === null) return options.next;
  return mergeChangedFields({ own: options.own, base: options.base, next: options.next });
}

function mergeCornerRadius(options: Readonly<{ own: CornerRadius; base: CornerRadius; next: CornerRadius }>): CornerRadius {
  const next = options.next;
  switch (next.kind) {
    case "uniform":
      return next;
    case "perCorner":
      if (options.base.kind !== "perCorner" || options.own.kind !== "perCorner") return next;
      return mergeChangedFields({ own: options.own, base: options.base, next });
    default:
      return assertNever(next);
  }
}

/** A changed stroke field reaches every drawn side of the element's own border (see the header). */
function mergeBorder(options: Readonly<{ own: Border; base: Border; next: Border }>): Border {
  const next = options.next;
  const baseStroke = firstDrawnStroke(options.base);
  const nextStroke = firstDrawnStroke(next);
  if (next.kind !== options.base.kind || baseStroke === null || nextStroke === null || !sameSidePattern(options.base, next)) return next;
  const restroke = (stroke: Stroke): Stroke => mergeChangedFields({ own: stroke, base: baseStroke, next: nextStroke });
  const own = options.own;
  switch (own.kind) {
    case "none":
      return next;
    case "uniform":
      return next.kind === "uniform" ? { kind: "uniform", stroke: restroke(own.stroke) } : next;
    case "perSide":
      return next.kind === "perSide"
        ? {
            kind: "perSide",
            top: own.top === null ? null : restroke(own.top),
            right: own.right === null ? null : restroke(own.right),
            bottom: own.bottom === null ? null : restroke(own.bottom),
            left: own.left === null ? null : restroke(own.left),
          }
        : next;
    default:
      return assertNever(own);
  }
}

/** Per-side borders whose drawn sides differ changed a side, which is a whole-value change. */
function sameSidePattern(first: Border, second: Border): boolean {
  if (first.kind !== "perSide" || second.kind !== "perSide") return true;
  return (["top", "right", "bottom", "left"] as const).every((side) => (first[side] === null) === (second[side] === null));
}

type StyleGroups = Readonly<{
  hasBox: boolean;
  textBox: TextBoxStyle | undefined;
  stroke: Stroke | undefined;
  border: Border | undefined;
  shadow: Shadow | null | undefined;
  cornerRadius: CornerRadius | undefined;
  crop: ImageCrop | undefined;
}>;

const NO_GROUPS: StyleGroups = { hasBox: false, textBox: undefined, stroke: undefined, border: undefined, shadow: undefined, cornerRadius: undefined, crop: undefined };

function styleGroupsOf(element: ElementSnapshot): StyleGroups {
  switch (element.kind) {
    case "shape":
      return { ...NO_GROUPS, hasBox: true, textBox: element.textBox, border: element.box.border, shadow: element.box.shadow, cornerRadius: element.box.cornerRadius };
    case "image":
      return { ...NO_GROUPS, hasBox: true, border: element.box.border, shadow: element.box.shadow, cornerRadius: element.box.cornerRadius, crop: element.crop };
    case "line":
      return { ...NO_GROUPS, stroke: element.stroke };
    case "table":
    case "group":
    case "unsupported":
      return NO_GROUPS;
    default:
      return assertNever(element);
  }
}
