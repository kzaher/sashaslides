// WHAT THE ANIMATE TAB SHOWS, as pure values: the sequence's rows (number, element, effect,
// trigger, and whether the step can play), the effect picker's groups, an effect re-kinded with
// the options that still make sense, the reorder a drag or Alt+Arrow means, and the numbered badges
// the canvas draws on animated elements. Kept out of the component so each decision is a table test
// (animate-tab.test.ts) and the tab itself only lays controls out.
//
// Key decisions:
//
//  * A ROW'S NUMBER IS ITS 1-BASED POSITION, the same number the canvas badge shows, so "3" in the
//    list and "3" on the slide are the same step even when several steps share a click.
//  * CHANGING THE EFFECT KEEPS WHAT STILL APPLIES: the edge carries between fly in, wipe and fly out
//    (from becomes to), a scripted step keeps its script, and everything else starts from the
//    effect's defaults (contracts/animations.ts `defaultAnimationEffect`).
//  * A MOVE THAT CHANGES NOTHING IS NO EVENT: the first row cannot go up, the last cannot go down,
//    and a row dropped on itself stays.

import {
  ANIMATION_EFFECT_LABELS,
  ANIMATION_LIMITS,
  ANIMATION_TRIGGER_LABELS,
  animationCategoryOf,
  defaultAnimationEffect,
  scriptedEffectOf,
  type AnimationEdge,
  type AnimationEffect,
  type AnimationEffectKind,
  type AnimationStep,
  type BuiltinAnimationEffectKind,
  type ScriptedAnimationCategory,
} from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { plainText, type DocumentSnapshot, type ElementSnapshot, type SlideSnapshot, type TransitionScriptRecord } from "../../contracts/document.ts";
import type { AnimationStepId, ElementId } from "../../contracts/ids.ts";
import { findInTree } from "../../shared/element-tree.ts";

/** "Add animation", grouped as Slides, PowerPoint and Keynote group them. */
export const ANIMATION_EFFECT_GROUPS: readonly Readonly<{ label: string; kinds: readonly BuiltinAnimationEffectKind[] }>[] = [
  { label: "Entrance", kinds: ["appear", "fadeIn", "flyIn", "zoomIn", "floatIn", "wipe"] },
  { label: "Emphasis", kinds: ["pulse", "growShrink", "spin", "colourChange"] },
  { label: "Exit", kinds: ["disappear", "fadeOut", "flyOut", "zoomOut"] },
  { label: "Motion", kinds: ["motionPath"] },
];

/** Whether a row's step can play, and if not, why it is shown anyway. */
export type AnimationRowStatus = "playable" | "elementRemoved" | "newerVersion";

export type AnimationRow = Readonly<{
  step: AnimationStep;
  /** 1-based position in the sequence (see the header). */
  number: number;
  elementLabel: string;
  effectLabel: string;
  triggerLabel: string;
  status: AnimationRowStatus;
}>;

/** Total over the statuses: whether Preview and the presenter play the row's step. */
export const ROW_PLAYS: Readonly<Record<AnimationRowStatus, boolean>> = { playable: true, elementRemoved: false, newerVersion: false };

export const ELEMENT_REMOVED_LABEL = "element removed";
export const NEWER_VERSION_LABEL = "made with a newer version";

export function animationRows(options: Readonly<{ slide: SlideSnapshot; scripts: readonly TransitionScriptRecord[] }>): readonly AnimationRow[] {
  return options.slide.animations.map((step, index) => {
    const element = findInTree(options.slide.elements, step.elementId);
    return {
      step,
      number: index + 1,
      elementLabel: element === null ? ELEMENT_REMOVED_LABEL : elementLabel(element),
      effectLabel: effectSummary({ effect: step.effect, scripts: options.scripts }),
      triggerLabel: ANIMATION_TRIGGER_LABELS[step.trigger],
      status: step.unsupportedKeys.length > 0 ? "newerVersion" : element === null ? "elementRemoved" : "playable",
    };
  });
}

/** The element's name, else its kind and the start of its text: `Shape "Quarterly review"`. */
export function elementLabel(element: ElementSnapshot): string {
  if (element.name.trim().length > 0) return element.name.trim();
  const preview = textPreview(element);
  const kind = ELEMENT_KIND_LABEL[element.kind];
  return preview.length === 0 ? kind : `${kind} "${preview}"`;
}

/** "Fly in from the left", "Spin 360 degrees", or the script's name for a scripted step. */
export function effectSummary(options: Readonly<{ effect: AnimationEffect; scripts: readonly TransitionScriptRecord[] }>): string {
  const effect = options.effect;
  const label = ANIMATION_EFFECT_LABELS[effect.kind];
  switch (effect.kind) {
    case "flyIn":
    case "wipe":
      return `${label} from the ${effect.from}`;
    case "flyOut":
      return `${label} to the ${effect.to}`;
    case "spin":
      return `${label} ${effect.degrees} degrees`;
    case "growShrink":
      return `${label} to ${Math.round(effect.scale * 100)} percent`;
    case "scripted": {
      const script = options.scripts.find((candidate) => candidate.id === effect.scriptId);
      return script === undefined ? `${label} (script missing)` : `${label}: ${script.name}`;
    }
    case "appear":
    case "fadeIn":
    case "zoomIn":
    case "floatIn":
    case "pulse":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "zoomOut":
    case "motionPath":
      return label;
    default:
      return assertNever(effect);
  }
}

/** The scripts a scripted step may name: those written as build steps. */
export function animationScripts(document: DocumentSnapshot): readonly TransitionScriptRecord[] {
  return document.transitionScripts.filter((script) => SCRIPT_IS_ANIMATION[script.purpose]);
}

/** True for a step whose effect is a script from the deck's store. */
export function isScriptedEffect(effect: AnimationEffect): boolean {
  return scriptedEffectOf(effect) !== null;
}

/** The effect after choosing `kind` for a step whose effect was `previous` (see the header); null when it cannot exist yet. */
export function effectWithKind(options: Readonly<{ kind: AnimationEffectKind; previous: AnimationEffect | null; scripts: readonly TransitionScriptRecord[] }>): AnimationEffect | null {
  const previous = options.previous;
  const kind = options.kind;
  if (previous !== null && previous.kind === kind) return previous;
  const edge = previous === null ? null : edgeOf(previous);
  switch (kind) {
    case "scripted": {
      const script = options.scripts[0];
      if (script === undefined) return null;
      return { kind, scriptId: script.id, category: previous === null ? "entrance" : scriptedCategoryOf(previous), parameters: {} };
    }
    case "flyIn":
    case "wipe":
      return { kind, from: edge ?? "left" };
    case "flyOut":
      return { kind, to: edge ?? "right" };
    case "appear":
    case "fadeIn":
    case "zoomIn":
    case "floatIn":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "zoomOut":
    case "motionPath":
      return defaultAnimationEffect(kind);
    default:
      return assertNever(kind);
  }
}

/** Alt+ArrowUp / Alt+ArrowDown and the move buttons: where the step lands, or null when it cannot move. */
export function stepMoveFor(options: Readonly<{ order: readonly AnimationStepId[]; stepId: AnimationStepId; direction: "up" | "down" }>): Readonly<{ after: AnimationStepId | null }> | null {
  const index = options.order.indexOf(options.stepId);
  if (index < 0) return null;
  switch (options.direction) {
    case "up":
      return index === 0 ? null : { after: options.order[index - 2] ?? null };
    case "down": {
      const next = options.order[index + 1];
      return next === undefined ? null : { after: next };
    }
    default:
      return assertNever(options.direction);
  }
}

/** A row dropped on another row takes that row's place: after it when dragged down, before it when dragged up. */
export function dropMoveFor(options: Readonly<{ order: readonly AnimationStepId[]; stepId: AnimationStepId; targetId: AnimationStepId }>): Readonly<{ after: AnimationStepId | null }> | null {
  const from = options.order.indexOf(options.stepId);
  const to = options.order.indexOf(options.targetId);
  if (from < 0 || to < 0 || from === to) return null;
  return to > from ? { after: options.targetId } : { after: options.order[to - 1] ?? null };
}

/** The numbered badges on the canvas: for each animated element on the slide, its steps' positions ("1, 3"). */
export function animationBadges(slide: SlideSnapshot): ReadonlyMap<ElementId, string> {
  const numbers = new Map<ElementId, number[]>();
  slide.animations.forEach((step, index) => {
    if (findInTree(slide.elements, step.elementId) === null) return;
    numbers.set(step.elementId, [...(numbers.get(step.elementId) ?? []), index + 1]);
  });
  return new Map([...numbers].map(([elementId, positions]) => [elementId, positions.join(", ")]));
}

/** The range a number field accepts, from ANIMATION_LIMITS, for clamping what is typed. */
export const ANIMATION_FIELD_RANGES = {
  duration: { minimum: 0, maximum: ANIMATION_LIMITS.maximumDurationMilliseconds },
  delay: { minimum: 0, maximum: ANIMATION_LIMITS.maximumDelayMilliseconds },
  scale: { minimum: ANIMATION_LIMITS.minimumScale, maximum: ANIMATION_LIMITS.maximumScale },
  degrees: { minimum: -ANIMATION_LIMITS.maximumSpinDegrees, maximum: ANIMATION_LIMITS.maximumSpinDegrees },
  offset: { minimum: -ANIMATION_LIMITS.maximumMotionOffset, maximum: ANIMATION_LIMITS.maximumMotionOffset },
} as const;

/** A typed number within its range; null for text that is not a number. */
export function clampedNumber(options: Readonly<{ text: string; range: Readonly<{ minimum: number; maximum: number }> }>): number | null {
  const value = Number(options.text);
  if (options.text.trim().length === 0 || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, options.range.minimum), options.range.maximum);
}

const SCRIPT_IS_ANIMATION: Readonly<Record<TransitionScriptRecord["purpose"], boolean>> = { transition: false, animation: true };

const ELEMENT_KIND_LABEL: Readonly<Record<ElementSnapshot["kind"], string>> = {
  shape: "Shape",
  image: "Image",
  line: "Line",
  table: "Table",
  group: "Group",
  unsupported: "Object",
};

const PREVIEW_LENGTH = 28;

function textPreview(element: ElementSnapshot): string {
  const text = textOf(element).replace(/\s+/gu, " ").trim();
  return text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;
}

function textOf(element: ElementSnapshot): string {
  switch (element.kind) {
    case "shape":
      return plainText({ body: element.text, slideNumber: null });
    case "table":
      return element.cells.map((cell) => plainText({ body: cell.text, slideNumber: null })).join(" ");
    case "group":
      return element.children.map(textOf).join(" ");
    case "image":
      return element.description;
    case "line":
    case "unsupported":
      return "";
    default:
      return assertNever(element);
  }
}

function edgeOf(effect: AnimationEffect): AnimationEdge | null {
  switch (effect.kind) {
    case "flyIn":
    case "wipe":
      return effect.from;
    case "flyOut":
      return effect.to;
    case "appear":
    case "fadeIn":
    case "zoomIn":
    case "floatIn":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "zoomOut":
    case "motionPath":
    case "scripted":
      return null;
    default:
      return assertNever(effect);
  }
}

/** A scripted step replacing a built-in keeps where the built-in rested; a motion rests like an emphasis. */
function scriptedCategoryOf(effect: AnimationEffect): ScriptedAnimationCategory {
  const category = animationCategoryOf(effect);
  switch (category) {
    case "entrance":
    case "emphasis":
    case "exit":
      return category;
    case "motion":
      return "emphasis";
    default:
      return assertNever(category);
  }
}
