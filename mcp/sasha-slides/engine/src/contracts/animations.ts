// BUILDS: animations of the objects ON a slide (PowerPoint's "animations", Keynote's "builds"), as
// opposed to transitions, which animate from one slide to the next (transition-protocol.ts).
//
// A slide holds an ordered SEQUENCE of steps; each step names one element by id, an effect, a
// trigger, timing and the effect's options. The presenter plays the sequence one click at a time:
// a click or Right runs the next step, the steps chained to it ("with previous", "after previous")
// follow by themselves, and only when the sequence is done does the next press go to the next slide.
//
// Key decisions:
//
//  * A STEP IS DATA, NEVER CODE, except the scripted effect. Fifteen built-in effects cover what
//    Slides, PowerPoint and Keynote users reach for; each is a pure description the presenter turns
//    into Web Animations. A SCRIPTED step names a script in the deck's script store
//    (document.ts `TransitionScriptRecord` with `purpose: "animation"`), which runs in the SAME
//    sandbox as a scripted transition under the SAME rule: only a script a person approved runs.
//
//  * EVERY STEP HAS A RESTING STATE. An entrance leaves its element visible, an exit hidden, an
//    emphasis or motion changes its frame or colour. The presenter derives "the slide after N
//    segments" from these declared outcomes alone (presenter/builds/build-states.ts), so jumping to
//    a slide, going back a step, reduced motion and the morph into the next slide all agree on what
//    the slide looks like without replaying a single animation. A scripted step declares its
//    `category` for exactly that reason: the script draws the motion, the category says where it
//    ends.
//
//  * STEPS ARE KEYED, ORDER IS A FRACTIONAL KEY (yjs-schema.ts `ANIMATION_STEP_KEY`), like slides
//    and elements: two people adding steps at once both keep theirs, a reorder is one field write,
//    and one person changing a duration while another changes the trigger keeps both changes.
//
//  * A STEP WHOSE ELEMENT IS GONE IS KEPT, NOT PLAYED. Deleting an element deletes its steps in the
//    same transaction (one undo step restores both); a step left dangling by a concurrent delete is
//    shown in the editor as "element removed" and skipped by the presenter.
//
//  * SEGMENTS ARE WHAT THE PRESENTER PLAYS (`buildSegmentsOf`). Built-in steps chained together are
//    one segment with a timeline; a scripted step is a segment of its own (it owns the sandbox's
//    stage while it runs), and a step chained to a scripted one starts after it.

import { assertNever } from "./assert-never.ts";
import type { TransitionEasing } from "./document.ts";
import type { AnimationStepId, ElementId, TransitionScriptId } from "./ids.ts";
import type { SerialisableObject } from "./serialisable.ts";
import type { Colour } from "./style.ts";

/** When a step starts: on the presenter's next click, together with the step before it, or after it ends. */
export type AnimationTrigger = "onClick" | "withPrevious" | "afterPrevious";

/** A slide edge an element flies or wipes in from, or flies out to. */
export type AnimationEdge = "left" | "right" | "top" | "bottom";

/** What a step does to its element's visibility and geometry; decides where it rests (see the header). */
export type AnimationCategory = "entrance" | "emphasis" | "exit" | "motion";

/** The categories a scripted step may declare: a script draws its own motion, so "motion" adds nothing. */
export type ScriptedAnimationCategory = "entrance" | "emphasis" | "exit";

/** Which colour a colour change changes. */
export type ColourChangePart = "fill" | "text";

export type AnimationEffect =
  // --- entrance: the element is hidden until the step runs
  | Readonly<{ kind: "appear" }>
  | Readonly<{ kind: "fadeIn" }>
  | Readonly<{ kind: "flyIn"; from: AnimationEdge }>
  | Readonly<{ kind: "zoomIn" }>
  /** Rises a short distance while fading in. */
  | Readonly<{ kind: "floatIn" }>
  /** Revealed by an edge sweeping across it. */
  | Readonly<{ kind: "wipe"; from: AnimationEdge }>
  // --- emphasis: the element stays, something about it changes
  /** Swells and settles back; changes nothing. */
  | Readonly<{ kind: "pulse" }>
  /** Ends `scale` times its size, about its centre. */
  | Readonly<{ kind: "growShrink"; scale: number }>
  /** Turns by `degrees` about its centre (positive is clockwise; 360 is one full turn). */
  | Readonly<{ kind: "spin"; degrees: number }>
  | Readonly<{ kind: "colourChange"; colour: Colour; part: ColourChangePart }>
  // --- exit: the element is hidden after the step
  | Readonly<{ kind: "disappear" }>
  | Readonly<{ kind: "fadeOut" }>
  | Readonly<{ kind: "flyOut"; to: AnimationEdge }>
  | Readonly<{ kind: "zoomOut" }>
  // --- motion: a straight line to an offset, in slide units
  | Readonly<{ kind: "motionPath"; offsetX: number; offsetY: number }>
  // --- a script in the deck's script store, run in the transition sandbox once approved
  | Readonly<{ kind: "scripted"; scriptId: TransitionScriptId; category: ScriptedAnimationCategory; parameters: SerialisableObject }>;

export type AnimationEffectKind = AnimationEffect["kind"];

export type BuiltinAnimationEffectKind = Exclude<AnimationEffectKind, "scripted">;

export type AnimationStep = Readonly<{
  id: AnimationStepId;
  /** The element it animates: a leaf or a group (a group's leaves move together). */
  elementId: ElementId;
  effect: AnimationEffect;
  trigger: AnimationTrigger;
  durationMilliseconds: number;
  /** Waited after the trigger, before the effect starts. */
  delayMilliseconds: number;
  easing: TransitionEasing;
  /** Stored keys whose values this client does not understand; such a step is shown, never played or rewritten. */
  unsupportedKeys: readonly string[];
}>;

/** Every change to a step's fields; the id and the order are changed by their own commands. */
export type AnimationStepPatch = Readonly<{
  elementId?: ElementId;
  effect?: AnimationEffect;
  trigger?: AnimationTrigger;
  durationMilliseconds?: number;
  delayMilliseconds?: number;
  easing?: TransitionEasing;
}>;

export const ANIMATION_LIMITS = {
  /** Per slide; a longer sequence is rejected (`invalidValue`), it is never a build anyone clicks through. */
  maximumStepsPerSlide: 100,
  maximumDurationMilliseconds: 20_000,
  maximumDelayMilliseconds: 20_000,
  minimumScale: 0.1,
  maximumScale: 10,
  maximumSpinDegrees: 3600,
  /** A motion path may end off the slide (to leave it), but not absurdly far: five slide widths. */
  maximumMotionOffset: 6400,
} as const;

/** A new step's timing when nobody chose one. */
export const DEFAULT_ANIMATION_DURATION_MILLISECONDS = 500;

/** Total over the effect kinds, so a new effect is a compile error here until it is listed. */
// `Object.keys` widens to string[]; the `satisfies` record below has exactly the AnimationEffectKind keys.
export const ANIMATION_EFFECT_KINDS: readonly AnimationEffectKind[] = Object.keys({
  appear: true,
  fadeIn: true,
  flyIn: true,
  zoomIn: true,
  floatIn: true,
  wipe: true,
  pulse: true,
  growShrink: true,
  spin: true,
  colourChange: true,
  disappear: true,
  fadeOut: true,
  flyOut: true,
  zoomOut: true,
  motionPath: true,
  scripted: true,
} satisfies Readonly<Record<AnimationEffectKind, true>>) as readonly AnimationEffectKind[];

export const ANIMATION_TRIGGERS: readonly AnimationTrigger[] = ["onClick", "withPrevious", "afterPrevious"];
export const ANIMATION_EDGES: readonly AnimationEdge[] = ["left", "right", "top", "bottom"];

/** The names a person reads in the Animate tab and Claude reads in the tool descriptions. */
export const ANIMATION_EFFECT_LABELS: Readonly<Record<AnimationEffectKind, string>> = {
  appear: "Appear",
  fadeIn: "Fade in",
  flyIn: "Fly in",
  zoomIn: "Zoom in",
  floatIn: "Float in",
  wipe: "Wipe",
  pulse: "Pulse",
  growShrink: "Grow or shrink",
  spin: "Spin",
  colourChange: "Colour change",
  disappear: "Disappear",
  fadeOut: "Fade out",
  flyOut: "Fly out",
  zoomOut: "Zoom out",
  motionPath: "Motion path",
  scripted: "Scripted",
};

export const ANIMATION_TRIGGER_LABELS: Readonly<Record<AnimationTrigger, string>> = {
  onClick: "On click",
  withPrevious: "With previous",
  afterPrevious: "After previous",
};

export function animationCategoryOf(effect: AnimationEffect): AnimationCategory {
  switch (effect.kind) {
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
      return "entrance";
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
      return "emphasis";
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
      return "exit";
    case "motionPath":
      return "motion";
    case "scripted":
      return effect.category;
    default:
      return assertNever(effect);
  }
}

/** A built-in effect with its usual options, for "Add animation" and for Claude's tools. */
export function defaultAnimationEffect(kind: BuiltinAnimationEffectKind): AnimationEffect {
  switch (kind) {
    case "appear":
    case "fadeIn":
    case "zoomIn":
    case "floatIn":
    case "pulse":
    case "disappear":
    case "fadeOut":
    case "zoomOut":
      return { kind };
    case "flyIn":
      return { kind, from: "left" };
    case "wipe":
      return { kind, from: "left" };
    case "growShrink":
      return { kind, scale: 1.5 };
    case "spin":
      return { kind, degrees: 360 };
    case "colourChange":
      return { kind, colour: { kind: "theme", slot: "accent2", alpha: 1 }, part: "fill" };
    case "flyOut":
      return { kind, to: "right" };
    case "motionPath":
      return { kind, offsetX: 200, offsetY: 0 };
    default:
      return assertNever(kind);
  }
}

/** One step placed on its segment's timeline, milliseconds from the segment's start. */
export type TimedAnimationStep = Readonly<{ step: AnimationStep; startMilliseconds: number; endMilliseconds: number }>;

/** What the presenter plays in one go (see the header). */
export type BuildSegment = Readonly<{
  /** A click starts it; false: it follows the previous segment (or the slide's arrival) by itself. */
  startsOnClick: boolean;
  /** Built-in steps run in the presenter's page; a scripted step runs in the sandbox, alone. */
  host: "inPage" | "sandbox";
  steps: readonly TimedAnimationStep[];
  durationMilliseconds: number;
}>;

/**
 * The slide's sequence cut into segments, keeping only the steps that can play: their element is on
 * the slide (`elementIds`) and every stored value was understood.
 */
export function buildSegmentsOf(options: Readonly<{ steps: readonly AnimationStep[]; elementIds: ReadonlySet<string> }>): readonly BuildSegment[] {
  const segments: BuildSegment[] = [];
  let open: OpenSegment | null = null;
  for (const step of options.steps) {
    if (step.unsupportedKeys.length > 0 || !options.elementIds.has(step.elementId)) continue;
    const host = hostOf(step.effect);
    const continuing = open !== null && step.trigger !== "onClick" && host === "inPage" && open.host === "inPage" ? open : null;
    if (continuing === null && open !== null) segments.push(finishedSegment(open));
    const segment: OpenSegment = continuing ?? { startsOnClick: step.trigger === "onClick", host, steps: [], end: 0, previousTrigger: 0 };
    const trigger = continuing === null ? 0 : triggerTime({ trigger: step.trigger, previousTrigger: segment.previousTrigger, segmentEnd: segment.end });
    const start = trigger + clampTo(step.delayMilliseconds, ANIMATION_LIMITS.maximumDelayMilliseconds);
    const end = start + effectiveDurationMilliseconds(step);
    segment.steps.push({ step, startMilliseconds: start, endMilliseconds: end });
    segment.end = Math.max(segment.end, end);
    segment.previousTrigger = trigger;
    open = segment;
  }
  if (open !== null) segments.push(finishedSegment(open));
  return segments;
}

/** "build 2 of 5": how many clicks the sequence takes, and how many are done after `completed` segments. */
export function buildClickCount(options: Readonly<{ segments: readonly BuildSegment[]; completed: number }>): Readonly<{ done: number; total: number }> {
  const clicks = (segments: readonly BuildSegment[]): number => segments.filter((segment) => segment.startsOnClick).length;
  return { done: clicks(options.segments.slice(0, Math.max(0, options.completed))), total: clicks(options.segments) };
}

/** Where a show rests on a slide: after `completed` segments, when the next one waits for a click (or none is left). */
export function isRestingBuild(options: Readonly<{ segments: readonly BuildSegment[]; completed: number }>): boolean {
  const next = options.segments[options.completed];
  return next === undefined || next.startsOnClick;
}

/** How long the effect itself lasts: appear and disappear are instant whatever duration is stored. */
export function effectiveDurationMilliseconds(step: AnimationStep): number {
  const effect = step.effect;
  switch (effect.kind) {
    case "appear":
    case "disappear":
      return 0;
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
    case "scripted":
      return clampTo(step.durationMilliseconds, ANIMATION_LIMITS.maximumDurationMilliseconds);
    default:
      return assertNever(effect);
  }
}

/** A segment while `buildSegmentsOf` is still adding steps to it; local to that one call. */
type OpenSegment = {
  readonly startsOnClick: boolean;
  readonly host: "inPage" | "sandbox";
  readonly steps: TimedAnimationStep[];
  end: number;
  previousTrigger: number;
};

function finishedSegment(open: OpenSegment): BuildSegment {
  return { startsOnClick: open.startsOnClick, host: open.host, steps: open.steps, durationMilliseconds: open.end };
}

function hostOf(effect: AnimationEffect): "inPage" | "sandbox" {
  switch (effect.kind) {
    case "scripted":
      return "sandbox";
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
      return "inPage";
    default:
      return assertNever(effect);
  }
}

function triggerTime(options: Readonly<{ trigger: AnimationTrigger; previousTrigger: number; segmentEnd: number }>): number {
  switch (options.trigger) {
    case "onClick":
      return 0;
    case "withPrevious":
      return options.previousTrigger;
    case "afterPrevious":
      return options.segmentEnd;
    default:
      return assertNever(options.trigger);
  }
}

function clampTo(milliseconds: number, maximum: number): number {
  if (!Number.isFinite(milliseconds)) return 0;
  return Math.min(Math.max(milliseconds, 0), maximum);
}
