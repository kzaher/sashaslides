// THE ANIMATE TAB'S STATE: a slide's build sequence edited through the four step commands
// (contracts/commands.ts), plus the two pieces of chrome it owns -- the chosen step and the build
// preview. Every edit goes through `queueEnvelope`, so a viewer or commenter is refused at the same
// door as every other edit, and one intent is one envelope, one undo step.
//
// Key decisions:
//
//  * ADDING ANIMATES THE SELECTION AS IT IS. One step per selected element (a selected group is one
//    step on the group, whose leaves move together); the first starts on a click and the rest "with
//    previous", because a person who selected three things and chose "Fly in" meant them to fly in
//    together. The steps land after the chosen step when it is on this slide, else at the end, and
//    the first becomes the chosen step so its fields are what the tab shows next.
//
//  * THE CHOSEN STEP LIVES ONLY WHILE IT EXISTS ON THE CURRENT SLIDE. `surviveAnimationChoice` runs
//    after every event (reduce-editor.ts): a slide switch clears it, and so does a document change
//    that removed the step -- an undo, a collaborator, the element's deletion. A step still waiting
//    in the edit queue counts as existing, so a collaborator's change arriving before our own insert
//    does not drop the step just added.
//
//  * A STEP MADE WITH A NEWER VERSION IS READ-ONLY. Its stored keys are not all understood, so a
//    patch could only lose them; the tab shows it and refuses edits with a reason. Moving and
//    removing it are allowed: neither rewrites the step's own fields.

import {
  ANIMATION_LIMITS,
  DEFAULT_ANIMATION_DURATION_MILLISECONDS,
  assertNever,
  type AnimationEffect,
  type AnimationStep,
  type AnimationStepId,
  type AnimationStepPatch,
  type EditorState,
  type QueuedEdit,
  type SlideId,
  type SlideSnapshot,
} from "../../contracts/index.ts";
import { editingRefusal } from "../../shared/access-refusals.ts";
import { commandOfKind } from "./command-kinds.ts";
import { findSlide } from "./document-lookup.ts";
import { queueCommands, refuse } from "./editor-queue.ts";
import { selectedElements } from "./editor-selection.ts";
import { createIdMinter } from "./id-minter.ts";
import { orderUnchanged } from "./slides.ts";

export const NOTHING_TO_ANIMATE_MESSAGE = "Select something on the slide first, then add an animation.";
export const NEWER_VERSION_STEP_MESSAGE = "This animation was made with a newer version of Sasha Slides, so it cannot be changed here.";
export const STEP_LIMIT_MESSAGE = `A slide holds at most ${ANIMATION_LIMITS.maximumStepsPerSlide} animations.`;
export const STEP_MISSING_MESSAGE = "That animation was removed.";

/** "Add animation": one step per selected element, in one envelope (see the header). */
export function addAnimation(state: EditorState, effect: AnimationEffect): EditorState {
  const refusal = editingRefusal(state);
  if (refusal !== null) return refuse(state, refusal);
  const selected = selectedElements(state);
  if (selected === null || selected.slide.id !== state.currentSlideId) return refuse(state, NOTHING_TO_ANIMATE_MESSAGE);
  const sequence = selected.slide.animations;
  if (sequence.length + selected.elements.length > ANIMATION_LIMITS.maximumStepsPerSlide) return refuse(state, STEP_LIMIT_MESSAGE);
  const minter = createIdMinter(state.idSeed);
  const steps: readonly AnimationStep[] = selected.elements.map((element, index) => ({
    id: minter.next("animationStep"),
    elementId: element.id,
    effect,
    trigger: index === 0 ? "onClick" : "withPrevious",
    durationMilliseconds: DEFAULT_ANIMATION_DURATION_MILLISECONDS,
    delayMilliseconds: 0,
    easing: "easeOut",
    unsupportedKeys: [],
  }));
  const chosen = state.chrome.selectedAnimationStepId;
  const after = chosen !== null && sequence.some((step) => step.id === chosen) ? chosen : (sequence.at(-1)?.id ?? null);
  const queued = queueCommands({ ...state, idSeed: minter.seed() }, [{ kind: "insertAnimationSteps", slideId: selected.slide.id, steps, after }]);
  return { ...queued, chrome: { ...queued.chrome, selectedAnimationStepId: steps[0]?.id ?? chosen } };
}

/** The row chosen in the sequence; a step that is not on the current slide is not choosable. */
export function chooseAnimationStep(state: EditorState, stepId: AnimationStepId | null): EditorState {
  if (stepId !== null && locateStep(state, stepId) === null) return state;
  return { ...state, chrome: { ...state.chrome, selectedAnimationStepId: stepId } };
}

export function patchAnimationStep(state: EditorState, options: Readonly<{ stepId: AnimationStepId; patch: AnimationStepPatch }>): EditorState {
  const located = locateStep(state, options.stepId);
  if (located === null) return refuse(state, STEP_MISSING_MESSAGE);
  if (located.step.unsupportedKeys.length > 0) return refuse(state, NEWER_VERSION_STEP_MESSAGE);
  return queueCommands(state, [{ kind: "updateAnimationSteps", slideId: located.slide.id, stepIds: [options.stepId], patch: options.patch }]);
}

/** Drag or keyboard reorder; nothing is queued when the order would not change. */
export function moveAnimationSteps(state: EditorState, options: Readonly<{ stepIds: readonly AnimationStepId[]; after: AnimationStepId | null }>): EditorState {
  const slide = currentSlide(state);
  if (slide === null) return state;
  const order = slide.animations.map((step) => step.id);
  const moving = options.stepIds.filter((stepId) => order.includes(stepId));
  if (moving.length === 0) return refuse(state, STEP_MISSING_MESSAGE);
  if (options.after !== null && (moving.includes(options.after) || !order.includes(options.after))) return state;
  if (orderUnchanged({ order, moving, after: options.after })) return state;
  return queueCommands(state, [{ kind: "moveAnimationSteps", slideId: slide.id, stepIds: moving, after: options.after }]);
}

/** Remove one step; when it was the chosen one, the next step (or else the one before) is chosen. */
export function removeAnimationStep(state: EditorState, stepId: AnimationStepId): EditorState {
  const located = locateStep(state, stepId);
  if (located === null) return refuse(state, STEP_MISSING_MESSAGE);
  const queued = queueCommands(state, [{ kind: "deleteAnimationSteps", slideId: located.slide.id, stepIds: [stepId] }]);
  if (queued.pendingEdits.length === state.pendingEdits.length || state.chrome.selectedAnimationStepId !== stepId) return queued;
  const sequence = located.slide.animations;
  const neighbour = sequence[located.index + 1] ?? sequence[located.index - 1] ?? null;
  return { ...queued, chrome: { ...queued.chrome, selectedAnimationStepId: neighbour?.id ?? null } };
}

/** "Preview": the slide's builds over the canvas; each request restarts it with a new generation. */
export function previewBuilds(state: EditorState, slideId: SlideId): EditorState {
  if (findSlide(state.document, slideId) === null) return state;
  const generation = (state.chrome.buildPreview?.generation ?? 0) + 1;
  return { ...state, chrome: { ...state.chrome, buildPreview: { slideId, generation } } };
}

export function endBuildPreview(state: EditorState): EditorState {
  return state.chrome.buildPreview === null ? state : { ...state, chrome: { ...state.chrome, buildPreview: null } };
}

/**
 * The Animate tab's chrome after any event (see the header): the chosen step and the preview are
 * dropped when the current slide changed or the step left the document.
 */
export function surviveAnimationChoice(options: Readonly<{ before: EditorState; after: EditorState }>): EditorState {
  const after = options.after;
  const chosen = after.chrome.selectedAnimationStepId;
  const preview = after.chrome.buildPreview;
  if (chosen === null && preview === null) return after;
  const slideChanged = after.currentSlideId !== options.before.currentSlideId;
  const documentChanged = after.document !== options.before.document;
  if (!slideChanged && !documentChanged) return after;
  const keepChosen = chosen !== null && !slideChanged && (locateStep(after, chosen) !== null || queuedForInsert(after.pendingEdits, chosen));
  const keepPreview = preview !== null && preview.slideId === after.currentSlideId && findSlide(after.document, preview.slideId) !== null;
  if (keepChosen === (chosen !== null) && keepPreview === (preview !== null)) return after;
  return { ...after, chrome: { ...after.chrome, selectedAnimationStepId: keepChosen ? chosen : null, buildPreview: keepPreview ? preview : null } };
}

type LocatedStep = Readonly<{ slide: SlideSnapshot; step: AnimationStep; index: number }>;

/** The step on the current slide, or null when it is not there (another slide's, or removed). */
function locateStep(state: EditorState, stepId: AnimationStepId): LocatedStep | null {
  const slide = currentSlide(state);
  if (slide === null) return null;
  const index = slide.animations.findIndex((step) => step.id === stepId);
  const step = slide.animations[index];
  return step === undefined ? null : { slide, step, index };
}

function currentSlide(state: EditorState): SlideSnapshot | null {
  return state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
}

function queuedForInsert(pendingEdits: readonly QueuedEdit[], stepId: AnimationStepId): boolean {
  return pendingEdits.some((edit) => {
    switch (edit.kind) {
      case "apply":
        return edit.envelope.commands.some((command) => commandOfKind(command, "insertAnimationSteps")?.steps.some((step) => step.id === stepId) ?? false);
      case "undo":
      case "redo":
        return false;
      default:
        return assertNever(edit);
    }
  });
}
