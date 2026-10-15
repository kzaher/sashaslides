// WHAT A BUILT-IN TRANSITION READS FROM `context.parameters`, and the small geometry they share.
// A built-in receives its effect's fields (direction, mode) and easing as parameters rather than
// through a private side channel, so the very same definition runs in the runner, where everything
// arrives as a serialisable `prepare` message (transition-protocol.ts header).
//
// Decisions:
//
//  * PARAMETERS ARE UNTRUSTED EVEN FOR BUILT-INS: in the runner they come from a slide's stored
//    parameters, so every reader validates against the closed set and falls back to a default.
//  * BACKWARD IS A MIRROR: going back plays the left slide's transition with direction "backward",
//    so a push from the right becomes a push from the left, a cover becomes an uncover, and a zoom
//    in becomes a zoom out (presenter.ts header, Keynote's behaviour).

import { assertNever } from "../../contracts/assert-never.ts";
import type { BuiltinTransitionEffect, SlideDirection, TransitionEasing } from "../../contracts/document.ts";
import type { SerialisableObject } from "../../contracts/serialisable.ts";
import type { TransitionContext, TransitionDirection } from "../../contracts/transition-protocol.ts";

/** The parameters the in-page host gives a built-in for a resolved effect. */
export function builtinParameters(options: Readonly<{ effect: BuiltinTransitionEffect; easing: TransitionEasing }>): SerialisableObject {
  const easing = EASING_FUNCTIONS[options.easing];
  const effect = options.effect;
  switch (effect.effect) {
    case "fade":
    case "morph":
      return { easing };
    case "push":
      return { easing, direction: effect.direction };
    case "slide":
      return { easing, direction: effect.direction, mode: effect.mode };
    case "zoom":
      return { easing, mode: effect.mode };
    default:
      return assertNever(effect);
  }
}

export const EASING_FUNCTIONS: Readonly<Record<TransitionEasing, string>> = {
  linear: "linear",
  easeIn: "ease-in",
  easeOut: "ease-out",
  easeInOut: "ease-in-out",
};

/** Timing every built-in uses: the whole duration, the chosen easing, holding the end state. */
export function builtinTiming(context: TransitionContext): KeyframeAnimationOptions {
  return { duration: context.durationMilliseconds, easing: easingOf(context.parameters), fill: "both" };
}

export function easingOf(parameters: SerialisableObject): string {
  const easing = parameters["easing"];
  if (typeof easing !== "string") return EASING_FUNCTIONS.easeInOut;
  if (Object.values(EASING_FUNCTIONS).includes(easing) || /^cubic-bezier\(\s*[-0-9.]+\s*(,\s*[-0-9.]+\s*){3}\)$/.test(easing)) return easing;
  return EASING_FUNCTIONS.easeInOut;
}

/** Where the incoming slide comes from, mirrored when going backward. */
export function slideDirectionOf(options: Readonly<{ parameters: SerialisableObject; direction: TransitionDirection }>): SlideDirection {
  const stored = options.parameters["direction"];
  const forward: SlideDirection = isSlideDirection(stored) ? stored : "fromRight";
  switch (options.direction) {
    case "forward":
      return forward;
    case "backward":
      return OPPOSITE_DIRECTION[forward];
    default:
      return assertNever(options.direction);
  }
}

/** A two-valued mode parameter, swapped when going backward. */
export function modeOf<TMode extends string>(
  options: Readonly<{ parameters: SerialisableObject; direction: TransitionDirection; modes: readonly [TMode, TMode] }>,
): TMode {
  const stored = options.parameters["mode"];
  const [first, second] = options.modes;
  const forward = stored === second ? second : first;
  switch (options.direction) {
    case "forward":
      return forward;
    case "backward":
      return forward === first ? second : first;
    default:
      return assertNever(options.direction);
  }
}

/** Off-stage position a slide enters from (the slide's own size, so percentages are exact). */
export function offStageFrom(direction: SlideDirection): string {
  switch (direction) {
    case "fromRight":
      return "translateX(100%)";
    case "fromLeft":
      return "translateX(-100%)";
    case "fromTop":
      return "translateY(-100%)";
    case "fromBottom":
      return "translateY(100%)";
    default:
      return assertNever(direction);
  }
}

/** Where the outgoing slide leaves to when the incoming one enters from `direction`. */
export function offStageTowards(direction: SlideDirection): string {
  return offStageFrom(OPPOSITE_DIRECTION[direction]);
}

export const OPPOSITE_DIRECTION: Readonly<Record<SlideDirection, SlideDirection>> = {
  fromRight: "fromLeft",
  fromLeft: "fromRight",
  fromTop: "fromBottom",
  fromBottom: "fromTop",
};

/** Waits for every animation; a cancelled one rejects, which ends the run as the host asked. */
export async function allFinished(animations: readonly Animation[]): Promise<void> {
  await Promise.all(animations.map((animation) => animation.finished));
}

function isSlideDirection(candidate: unknown): candidate is SlideDirection {
  // Parse-boundary guard over untrusted parameters; the four values are listed by hand.
  return candidate === "fromRight" || candidate === "fromLeft" || candidate === "fromTop" || candidate === "fromBottom";
}
