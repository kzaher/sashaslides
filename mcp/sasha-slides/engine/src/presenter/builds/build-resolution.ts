// WHAT THE HOST PLAYS FOR ONE BUILD SEGMENT: the in-page build player, an approved script in the
// sandbox, or nothing at all -- the segment's outcome shown at once. Pure, so the reducer decides it
// and a test tables it; the slide-transition counterpart is transition-resolution.ts.
//
// Key decisions:
//
//  * A BUILD THAT CANNOT PLAY APPEARS AT ONCE, IT IS NOT SUBSTITUTED BY A FADE. A slide transition
//    must show that the slide changed, so it falls back to a short fade; a build step's outcome is
//    the slide at the next build position, which the presenter draws without replaying anything
//    (build-states.ts). Reduced motion does the same for every segment, silently: a notice per
//    click would bury the diagnostics a presenter actually needs.
//  * AN UNAPPROVED, MISSING OR WRONG-PURPOSE SCRIPT IS SAID, with the transition's substitution
//    reasons (`scriptNotApproved`, `scriptMissing`): code approved to run between slides is not
//    thereby approved as a build step (document.ts `ScriptPurpose`), and the fingerprint an approval
//    covers already includes the purpose.
//  * A SCRIPTED STEP'S PARAMETERS are the script's defaults, then the step's own, then what the step
//    is about -- `targetElementId` and `category` -- which a script cannot be configured out of.

import { effectiveDurationMilliseconds, scriptedEffectOf, type BuildSegment } from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { scriptFingerprint, type ScriptPurpose, type TransitionScriptRecord } from "../../contracts/document.ts";
import type { ResolvedTransition } from "../../contracts/presenter.ts";
import type { TransitionSubstitutionReason } from "../../contracts/transition-protocol.ts";
import { approvalCovers, clampDuration } from "../transition-resolution.ts";

export type BuildResolution =
  | Readonly<{ kind: "play"; transition: ResolvedTransition }>
  /** Show the segment's outcome at once; `substitution` names why when it is not the viewer's own preference. */
  | Readonly<{ kind: "instant"; substitution: TransitionSubstitutionReason | null }>;

export function resolveBuildSegment(
  options: Readonly<{ segment: BuildSegment; scripts: readonly TransitionScriptRecord[]; reducedMotion: boolean }>,
): BuildResolution {
  if (options.reducedMotion) return { kind: "instant", substitution: null };
  const first = options.segment.steps[0];
  if (first === undefined) return { kind: "instant", substitution: null };
  const step = first.step;
  const effect = scriptedEffectOf(step.effect);
  if (effect === null) return { kind: "play", transition: { kind: "build", segment: options.segment } };
  const record = options.scripts.find((script) => script.id === effect.scriptId);
  if (record === undefined || !servesBuildSteps(record.purpose)) return { kind: "instant", substitution: "scriptMissing" };
  const fingerprint = scriptFingerprint(record);
  if (!approvalCovers({ approval: record.approval, fingerprint })) return { kind: "instant", substitution: "scriptNotApproved" };
  return {
    kind: "play",
    transition: {
      kind: "scripted",
      scriptId: record.id,
      fingerprint,
      durationMilliseconds: clampDuration(effectiveDurationMilliseconds(step)),
      parameters: { ...record.defaultParameters, ...effect.parameters, targetElementId: step.elementId, category: effect.category },
    },
  };
}

/** What a diagnostic says when a build step was shown at once instead of played. */
export const BUILD_SUBSTITUTION_MESSAGES: Readonly<Record<TransitionSubstitutionReason, string>> = {
  reducedMotion: "Showed the build step at once: the viewer prefers reduced motion.",
  scriptNotApproved: "Showed the build step at once: its animation script is waiting for a person to review and approve it.",
  scriptMissing: "Showed the build step at once: the animation script it names is not in the deck.",
};

/** True for a script written to animate a build step (see the header). */
export function servesBuildSteps(purpose: ScriptPurpose): boolean {
  switch (purpose) {
    case "animation":
      return true;
    case "transition":
      return false;
    default:
      return assertNever(purpose);
  }
}
