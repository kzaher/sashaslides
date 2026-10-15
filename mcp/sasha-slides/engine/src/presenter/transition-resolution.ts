// WHAT THE HOST ACTUALLY PLAYS for a slide's transition: a cut, a built-in, an approved script, or
// the host's own 150 millisecond fade standing in for something it will not run. Pure, so the
// reducer can decide it and a test can table it.
//
// Key decisions:
//
//  * REDUCED MOTION SUBSTITUTES EVERY TRANSITION, built-in or scripted. The host never trusts a
//    script to honour `reducedMotion`, and a push or a zoom is exactly the flying a person who asked
//    for reduced motion does not want; a short fade still says "the slide changed".
//  * ONLY AN APPROVAL OF THIS EXACT TEXT COUNTS. The approval names a `scriptFingerprint`; any later
//    edit changes the fingerprint and voids it (document.ts `TransitionApproval`), so the check is
//    "approved AND the fingerprint still matches", never the approval kind alone.
//  * A SLIDE TRANSITION RUNS ONLY A SCRIPT WRITTEN AS ONE. A script whose purpose is "animation" (a
//    scripted build step, document.ts `ScriptPurpose`) named by a slide's transition is treated as
//    missing: its approval covered running it as a build step, not between slides.
//  * DURATIONS ARE CLAMPED to [0, maximumDurationMilliseconds] here, once, so every deadline the
//    reducer computes from a run is bounded.

import { assertNever } from "../contracts/assert-never.ts";
import { scriptFingerprint, type ScriptPurpose, type SlideTransition, type TransitionApproval, type TransitionScriptRecord } from "../contracts/document.ts";
import type { ResolvedTransition } from "../contracts/presenter.ts";
import type { SerialisableObject } from "../contracts/serialisable.ts";
import { TRANSITION_LIMITS } from "../contracts/transition-protocol.ts";

export type TransitionResolution = Readonly<{ kind: "cut" }> | Readonly<{ kind: "play"; transition: ResolvedTransition }>;

export function resolveTransition(
  options: Readonly<{
    transition: SlideTransition | null;
    scripts: readonly TransitionScriptRecord[];
    reducedMotion: boolean;
  }>,
): TransitionResolution {
  const transition = options.transition;
  if (transition === null) return { kind: "cut" };
  if (options.reducedMotion) return substituted("reducedMotion");
  switch (transition.kind) {
    case "builtin":
      return {
        kind: "play",
        transition: {
          kind: "builtin",
          effect: transition.effect,
          durationMilliseconds: clampDuration(transition.durationMilliseconds),
          easing: transition.easing,
        },
      };
    case "scripted": {
      const record = options.scripts.find((script) => script.id === transition.scriptId);
      if (record === undefined || !servesTransitions(record.purpose)) return substituted("scriptMissing");
      const fingerprint = scriptFingerprint(record);
      if (!approvalCovers({ approval: record.approval, fingerprint })) return substituted("scriptNotApproved");
      return {
        kind: "play",
        transition: {
          kind: "scripted",
          scriptId: record.id,
          fingerprint,
          durationMilliseconds: clampDuration(transition.durationMilliseconds),
          parameters: mergeParameters({ defaults: record.defaultParameters, overrides: transition.parameters }),
        },
      };
    }
    default:
      return assertNever(transition);
  }
}

/** True when a person approved exactly this text. */
export function approvalCovers(options: Readonly<{ approval: TransitionApproval; fingerprint: string }>): boolean {
  const approval = options.approval;
  switch (approval.kind) {
    case "unapproved":
      return false;
    case "approved":
      return approval.fingerprint === options.fingerprint;
    default:
      return assertNever(approval);
  }
}

export function clampDuration(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return 0;
  return Math.min(Math.max(milliseconds, 0), TRANSITION_LIMITS.maximumDurationMilliseconds);
}

function servesTransitions(purpose: ScriptPurpose): boolean {
  switch (purpose) {
    case "transition":
      return true;
    case "animation":
      return false;
    default:
      return assertNever(purpose);
  }
}

function substituted(reason: Extract<ResolvedTransition, { kind: "substitutedFade" }>["reason"]): TransitionResolution {
  return { kind: "play", transition: { kind: "substitutedFade", reason } };
}

function mergeParameters(options: Readonly<{ defaults: SerialisableObject; overrides: SerialisableObject }>): SerialisableObject {
  return { ...options.defaults, ...options.overrides };
}
