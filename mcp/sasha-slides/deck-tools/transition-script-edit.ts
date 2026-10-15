/**
 * `deck_write_transition` AND `deck_write_animation` AS COMMANDS. A script is arbitrary code a
 * model wrote from a prompt someone else may control, so it is saved UNAPPROVED whoever's account
 * the agent acts for -- the deck owner's included -- and runs only after a person approves that
 * exact text in the editor (document.ts `TransitionApproval`, collaboration.ts header). The save and
 * what uses it (the slides' transitions, or the scripted build steps) travel in ONE envelope: one
 * undo step, and nothing ever points at a script that is not there.
 *
 * A transition script and an animation script differ only in their `purpose` (document.ts
 * `ScriptPurpose`), which is part of what an approval covers. Each tool writes only its own
 * purpose and refuses to replace a script of the other one: turning a build step's script into a
 * transition would leave the slides' steps naming a script they can no longer run.
 *
 * Sizes are checked here, before anything is sent, against the runner's limits
 * (transition-limits.ts): a script the presenter would refuse to load is not worth storing.
 */
import type { AssistantAnimationScript, AssistantTransitionScript } from "../engine/src/contracts/assistant-deck-tools.ts";
import type { AnimationStep } from "../engine/src/contracts/animations.ts";
import type { DocumentCommand } from "../engine/src/contracts/commands.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { DocumentSnapshot, ElementSnapshot, ScriptPurpose, TransitionScriptRecord } from "../engine/src/contracts/document.ts";
import { mintId, type AnimationStepId, type ElementId, type IdSeed, type SlideId, type TransitionScriptId } from "../engine/src/contracts/ids.ts";
import { SCRIPT_LIMITS } from "./transition-limits.ts";

export type TransitionScriptExpansion =
  | Readonly<{ kind: "expanded"; scriptId: TransitionScriptId; commands: readonly DocumentCommand[]; seed: IdSeed }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export type AnimationScriptExpansion =
  | Readonly<{ kind: "expanded"; scriptId: TransitionScriptId; commands: readonly DocumentCommand[]; stepIds: readonly AnimationStepId[]; seed: IdSeed }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export function expandTransitionScript(
  options: Readonly<{ snapshot: DocumentSnapshot; request: AssistantTransitionScript; seed: IdSeed }>,
): TransitionScriptExpansion {
  const { snapshot, request } = options;
  const saved = scriptSave({ snapshot, request, purpose: "transition", seed: options.seed });
  switch (saved.kind) {
    case "rejected":
      return saved;
    case "saved":
      break;
    default:
      return assertNever(saved);
  }
  const slideIds = new Set(snapshot.slides.map((slide) => slide.id));
  const missingSlide = request.assignTo.find((assignment) => !slideIds.has(assignment.slideId));
  if (missingSlide !== undefined) return { kind: "rejected", reason: `slideMissing: there is no slide ${missingSlide.slideId} in this deck` };
  const scriptId = saved.scriptId;
  const commands: DocumentCommand[] = [
    saved.command,
    ...request.assignTo.map(
      (assignment): DocumentCommand => ({
        kind: "setSlideProperties",
        slideId: assignment.slideId,
        patch: { transition: { kind: "scripted", scriptId, durationMilliseconds: assignment.durationMilliseconds, parameters: {} } },
      }),
    ),
  ];
  return { kind: "expanded", scriptId, commands, seed: saved.seed };
}

/**
 * The script saved with purpose "animation", then one scripted step per assignment, appended to
 * its slide's sequence (after the steps appended before it in the same call), animating its
 * element. The step's parameters stay empty: the presenter hands the script the step's element as
 * `context.parameters.targetElementId`, so a person retargeting the step in the Animate tab
 * retargets the script too.
 */
export function expandAnimationScript(options: Readonly<{ snapshot: DocumentSnapshot; request: AssistantAnimationScript; seed: IdSeed }>): AnimationScriptExpansion {
  const { snapshot, request } = options;
  const saved = scriptSave({ snapshot, request, purpose: "animation", seed: options.seed });
  switch (saved.kind) {
    case "rejected":
      return saved;
    case "saved":
      break;
    default:
      return assertNever(saved);
  }
  const scriptId = saved.scriptId;
  let seed = saved.seed;
  const lastStepOf = new Map<SlideId, AnimationStepId | null>(snapshot.slides.map((slide) => [slide.id, slide.animations.at(-1)?.id ?? null] as const));
  const commands: DocumentCommand[] = [saved.command];
  const stepIds: AnimationStepId[] = [];
  for (const assignment of request.assignTo) {
    const slide = snapshot.slides.find((candidate) => candidate.id === assignment.slideId);
    if (slide === undefined) return { kind: "rejected", reason: `slideMissing: there is no slide ${assignment.slideId} in this deck` };
    if (!hasElement({ elements: slide.elements, elementId: assignment.elementId })) {
      return { kind: "rejected", reason: `elementMissing: there is no element ${assignment.elementId} on slide ${assignment.slideId}` };
    }
    const minted = mintId({ seed, kind: "animationStep" });
    seed = minted.seed;
    const step: AnimationStep = {
      id: minted.id,
      elementId: assignment.elementId,
      effect: { kind: "scripted", scriptId, category: assignment.category, parameters: {} },
      trigger: assignment.trigger,
      durationMilliseconds: assignment.durationMilliseconds,
      delayMilliseconds: 0,
      easing: "easeOut",
      unsupportedKeys: [],
    };
    commands.push({ kind: "insertAnimationSteps", slideId: slide.id, steps: [step], after: lastStepOf.get(slide.id) ?? null });
    lastStepOf.set(slide.id, step.id);
    stepIds.push(step.id);
  }
  return { kind: "expanded", scriptId, commands, stepIds, seed };
}

/** The one save both tools share: sizes, the script to replace (of the same purpose), a fresh id. */
function scriptSave(
  options: Readonly<{ snapshot: DocumentSnapshot; request: AssistantTransitionScript | AssistantAnimationScript; purpose: ScriptPurpose; seed: IdSeed }>,
): Readonly<{ kind: "saved"; scriptId: TransitionScriptId; command: DocumentCommand; seed: IdSeed }> | Readonly<{ kind: "rejected"; reason: string }> {
  const { snapshot, request, purpose } = options;
  const tooLarge = sizeProblem(request);
  if (tooLarge !== null) return { kind: "rejected", reason: tooLarge };
  const existing = request.scriptId === null ? null : (snapshot.transitionScripts.find((script) => script.id === request.scriptId) ?? null);
  if (request.scriptId !== null && existing === null) {
    return { kind: "rejected", reason: `transitionScriptMissing: there is no ${PURPOSE_WORDS[purpose].name} ${request.scriptId} in this deck; pass scriptId null to write a new one` };
  }
  if (existing !== null && existing.purpose !== purpose) return { kind: "rejected", reason: wrongPurpose({ script: existing }) };
  const minted = request.scriptId === null ? mintId({ seed: options.seed, kind: "transitionScript" }) : { id: request.scriptId, seed: options.seed };
  return {
    kind: "saved",
    scriptId: minted.id,
    seed: minted.seed,
    command: {
      kind: "upsertTransitionScript",
      script: {
        id: minted.id,
        name: request.name,
        description: request.description,
        purpose,
        script: request.script,
        stylesheet: request.stylesheet,
        markup: request.markup,
        defaultParameters: request.defaultParameters,
      },
      basedOnUpdatedAt: existing?.updatedAt ?? null,
      approval: "unapproved",
    },
  };
}

/** Total over purposes: what a script of this purpose is called, and which tool writes it. */
const PURPOSE_WORDS: Readonly<Record<ScriptPurpose, Readonly<{ name: string; article: string; tool: string }>>> = {
  transition: { name: "transition script", article: "a", tool: "deck_write_transition" },
  animation: { name: "animation script", article: "an", tool: "deck_write_animation" },
};

function wrongPurpose(options: Readonly<{ script: TransitionScriptRecord }>): string {
  const words = PURPOSE_WORDS[options.script.purpose];
  return `invalidValue: script ${options.script.id} is ${words.article} ${words.name}; replace it with ${words.tool}, or pass scriptId null to write a new one`;
}

function hasElement(options: Readonly<{ elements: readonly ElementSnapshot[]; elementId: ElementId }>): boolean {
  return options.elements.some((element) => element.id === options.elementId || hasElement({ elements: childrenOf(element), elementId: options.elementId }));
}

function childrenOf(element: ElementSnapshot): readonly ElementSnapshot[] {
  switch (element.kind) {
    case "group":
      return element.children;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function sizeProblem(request: Readonly<{ script: string; stylesheet: string; markup: string }>): string | null {
  const checks = [
    { field: "script", text: request.script, limit: SCRIPT_LIMITS.maximumScriptBytes },
    { field: "stylesheet", text: request.stylesheet, limit: SCRIPT_LIMITS.maximumStylesheetBytes },
    { field: "markup", text: request.markup, limit: SCRIPT_LIMITS.maximumOverlayMarkupBytes },
  ] as const;
  for (const check of checks) {
    const bytes = Buffer.byteLength(check.text, "utf8");
    if (bytes > check.limit) {
      return `tooLarge: the ${check.field} is ${String(bytes)} bytes; the presenter runs at most ${String(check.limit)} (${String(check.limit / 1024)} kilobytes)`;
    }
  }
  return null;
}
