// THE `TransitionContext` EVERY TRANSITION RECEIVES, built the same way by both hosts: the in-page
// host (built-ins and the substituted fade, on two React-rendered slides) and the runner bootstrap
// (scripts, on two slides parsed from markup). One builder is what makes "a built-in also runs in
// the runner" true by construction rather than by care (transition-protocol.ts header).
//
// Decisions:
//
//  * EVERYTHING EFFECTFUL IS INJECTED: the animation primitive, the clock and the timer. In a page
//    they are `Element.animate`, `performance.now` and `setTimeout`; a test passes a recorder and
//    a fake clock, so a built-in's keyframes are asserted without a browser.
//  * ANIMATIONS ARE THE HOST'S, NOT THE SCRIPT'S. Every `context.animate` is tracked and cancelled
//    when `signal` aborts, and its timing is clamped so delay plus active time never runs past
//    the transition's declared duration: a script cannot keep drawing after the host moved on.
//  * NODES ARE FOUND BY THE STABLE ATTRIBUTE (`data-sasha-element-id`, render.ts) inside each
//    side's layer; a record whose node is missing (an element the renderer skipped) is left out
//    rather than handed to a script as null.

import { assertNever } from "../contracts/assert-never.ts";
import { ELEMENT_ID_ATTRIBUTE, type StageElementRecord } from "../contracts/render.ts";
import type { SerialisableObject } from "../contracts/serialisable.ts";
import type { MorphPair, StageElementHandle, TransitionContext, TransitionDirection } from "../contracts/transition-protocol.ts";

export type AnimateNode = (node: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => Animation;

/** Starts a timer and returns its cancel function. */
export type StartTimer = (callback: () => void, milliseconds: number) => () => void;

/** The four elements a transition draws with. */
export type TransitionStage = Readonly<{
  stage: HTMLElement;
  /** null when starting from black. */
  outgoing: HTMLElement | null;
  incoming: HTMLElement;
  overlay: HTMLElement;
}>;

export function buildTransitionContext(
  options: Readonly<{
    stage: TransitionStage;
    outgoingElements: readonly StageElementRecord[];
    incomingElements: readonly StageElementRecord[];
    durationMilliseconds: number;
    direction: TransitionDirection;
    parameters: SerialisableObject;
    reducedMotion: boolean;
    signal: AbortSignal;
    animateNode: AnimateNode;
    now: () => number;
    startTimer: StartTimer;
  }>,
): TransitionContext {
  const startedAt = options.now();
  const liveAnimations = new Set<Animation>();
  options.signal.addEventListener(
    "abort",
    () => {
      for (const animation of liveAnimations) animation.cancel();
      liveAnimations.clear();
    },
    { once: true },
  );
  const outgoingHandles = options.stage.outgoing === null ? [] : handlesOf({ layer: options.stage.outgoing, records: options.outgoingElements });
  const incomingHandles = handlesOf({ layer: options.stage.incoming, records: options.incomingElements });
  return {
    stage: options.stage.stage,
    outgoing: options.stage.outgoing,
    incoming: options.stage.incoming,
    overlay: options.stage.overlay,
    durationMilliseconds: options.durationMilliseconds,
    direction: options.direction,
    parameters: options.parameters,
    reducedMotion: options.reducedMotion,
    signal: options.signal,
    elements(side) {
      switch (side) {
        case "outgoing":
          return outgoingHandles;
        case "incoming":
          return incomingHandles;
        default:
          return assertNever(side);
      }
    },
    pairs() {
      return pairByMorphKey({ outgoing: outgoingHandles, incoming: incomingHandles });
    },
    animate(node, keyframes, animationOptions) {
      const remaining = Math.max(0, options.durationMilliseconds - (options.now() - startedAt));
      const animation = options.animateNode(node, keyframes, clampTiming({ timing: animationOptions, remaining }));
      if (options.signal.aborted) {
        animation.cancel();
        return animation;
      }
      liveAnimations.add(animation);
      return animation;
    },
    wait(milliseconds) {
      return new Promise<void>((resolve, reject) => {
        if (options.signal.aborted) {
          reject(abortError());
          return;
        }
        const cancel = options.startTimer(resolve, Math.max(0, milliseconds));
        options.signal.addEventListener(
          "abort",
          () => {
            cancel();
            reject(abortError());
          },
          { once: true },
        );
      });
    },
  };
}

/**
 * Leaves present on both sides with the same morph key, in the incoming side's z-order. A key used
 * by several leaves on one side pairs them in z-order, first with first.
 */
export function pairByMorphKey(options: Readonly<{ outgoing: readonly StageElementHandle[]; incoming: readonly StageElementHandle[] }>): readonly MorphPair[] {
  const unusedOutgoing = new Map<string, StageElementHandle[]>();
  for (const handle of options.outgoing) unusedOutgoing.set(handle.morphKey, [...(unusedOutgoing.get(handle.morphKey) ?? []), handle]);
  const pairs: MorphPair[] = [];
  for (const incoming of options.incoming) {
    const candidates = unusedOutgoing.get(incoming.morphKey);
    const outgoing = candidates?.shift();
    if (outgoing === undefined) continue;
    pairs.push({ morphKey: incoming.morphKey, outgoing, incoming });
  }
  return pairs;
}

/** Delay plus active time never exceeds `remaining` milliseconds (see the header). */
export function clampTiming(options: Readonly<{ timing: KeyframeAnimationOptions; remaining: number }>): KeyframeAnimationOptions {
  const timing = options.timing;
  if (typeof timing.duration !== "number") return timing;
  const iterations = timing.iterations !== undefined && Number.isFinite(timing.iterations) && timing.iterations > 0 ? timing.iterations : 1;
  const delay = Math.min(Math.max(timing.delay ?? 0, 0), options.remaining);
  const activeTime = timing.duration * iterations;
  if (delay + activeTime <= options.remaining) return { ...timing, delay, iterations };
  return { ...timing, delay, iterations, duration: Math.max(0, (options.remaining - delay) / iterations) };
}

function handlesOf(options: Readonly<{ layer: HTMLElement; records: readonly StageElementRecord[] }>): readonly StageElementHandle[] {
  const handles: StageElementHandle[] = [];
  for (const record of options.records) {
    const node = options.layer.querySelector<HTMLElement>(`[${ELEMENT_ID_ATTRIBUTE}="${record.elementId}"]`);
    if (node === null) continue;
    handles.push({ elementId: record.elementId, morphKey: record.morphKey, kind: record.kind, frame: record.frame, bounds: record.bounds, node });
  }
  return handles;
}

function abortError(): Error {
  const error = new Error("The transition was cancelled.");
  error.name = "AbortError";
  return error;
}
