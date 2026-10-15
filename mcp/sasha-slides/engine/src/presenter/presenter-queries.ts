// QUESTIONS ASKED OF THE PRESENTER'S STATE, answered by exhaustive switches so a new variant of a
// screen, slot, host or transition is a compile error wherever one of these is asked -- not a
// silent `else`. The reducer, the feedbacks and the view all ask through here.

import { assertNever } from "../contracts/assert-never.ts";
import type { RunnerId } from "../contracts/ids.ts";
import type { PresenterScreen, ResolvedTransition, RunnerSlot, TransitionRun, TransitionRunHost, TransitionRunPhase } from "../contracts/presenter.ts";
import { TRANSITION_LIMITS, type TransitionFallbackReason } from "../contracts/transition-protocol.ts";
import { resolveBuildSegment, type BuildResolution } from "./builds/build-resolution.ts";
import { slideBuildSegments } from "./builds/build-states.ts";
import { runDurationMilliseconds, slideById, type PresenterSystemState } from "./presenter-state.ts";
import { resolveTransition, type TransitionResolution } from "./transition-resolution.ts";

/** How long a run may stay in its phase, in visible milliseconds; null: no phase deadline. */
export function phaseDeadline(run: TransitionRun): Readonly<{ milliseconds: number; reason: TransitionFallbackReason }> | null {
  const phase: TransitionRunPhase = run.phase;
  switch (phase) {
    case "awaitingRunner":
      return { milliseconds: TRANSITION_LIMITS.runnerReadyTimeoutMilliseconds, reason: "runnerNotReady" };
    case "preparing":
    case "prepared":
      return { milliseconds: TRANSITION_LIMITS.prepareTimeoutMilliseconds, reason: "prepareTimedOut" };
    case "running":
      return {
        milliseconds: runDurationMilliseconds(run, TRANSITION_LIMITS.substituteFadeMilliseconds) + TRANSITION_LIMITS.finishGraceMilliseconds,
        reason: "overran",
      };
    default:
      return assertNever(phase);
  }
}

export function isBlankScreen(screen: PresenterScreen): boolean {
  switch (screen.kind) {
    case "blank":
      return true;
    case "slide":
    case "transition":
    case "end":
      return false;
    default:
      return assertNever(screen);
  }
}

/** The runner a slot holds, loading or ready; null when empty. */
export function slotRunnerId(slot: RunnerSlot): RunnerId | null {
  switch (slot.kind) {
    case "none":
      return null;
    case "loading":
    case "ready":
      return slot.runnerId;
    default:
      return assertNever(slot);
  }
}

/** The runner a run is hosted on; null for an in-page run. */
export function hostRunnerId(host: TransitionRunHost): RunnerId | null {
  switch (host.kind) {
    case "inPage":
      return null;
    case "sandbox":
      return host.runnerId;
    default:
      return assertNever(host);
  }
}

/** True when moving to or from some playlist slide, or one of its build segments, would run a script in the sandbox. */
export function playlistUsesSandbox(state: PresenterSystemState): boolean {
  const scripts = state.document.transitionScripts;
  return state.playlist.some((slideId) => {
    const slide = slideById(state.document, slideId);
    if (slide === null) return false;
    if (runsInSandbox(resolveTransition({ transition: slide.transition, scripts, reducedMotion: state.reducedMotion }))) return true;
    return slideBuildSegments(slide).some((segment) => buildRunsInSandbox(resolveBuildSegment({ segment, scripts, reducedMotion: state.reducedMotion })));
  });
}

export function isScripted(transition: ResolvedTransition): boolean {
  switch (transition.kind) {
    case "scripted":
      return true;
    case "builtin":
    case "substitutedFade":
    case "build":
      return false;
    default:
      return assertNever(transition);
  }
}

function runsInSandbox(resolution: TransitionResolution): boolean {
  switch (resolution.kind) {
    case "cut":
      return false;
    case "play":
      return isScripted(resolution.transition);
    default:
      return assertNever(resolution);
  }
}

function buildRunsInSandbox(resolution: BuildResolution): boolean {
  switch (resolution.kind) {
    case "instant":
      return false;
    case "play":
      return isScripted(resolution.transition);
    default:
      return assertNever(resolution);
  }
}
