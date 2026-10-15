// THE SLIDESHOW'S REDUCER: pure `(state, event) -> state` for navigation, blank screens, the end
// screen, controls that fade, the speaker view flag, and the whole life of a transition run --
// including every deadline, which the reducer checks on `clockTicked` so a missed deadline is a
// state transition a test can replay, not a timer buried in an effect.
//
// Key decisions (the contract's header, presenter.ts, has the product rules):
//
//  * DEADLINES ARE VISIBLE TIME. `clockTicked` adds the time since the previous tick to the run's
//    `phaseVisibleMilliseconds` and to the outstanding ping's wait ONLY while `pageVisible`; a
//    background tab's throttled timers, or the speaker window covering the audience window, never
//    cut a healthy transition.
//  * EVERY ENDING IS ONE OF TWO FUNCTIONS: `completeRun` (the incoming slide on screen) and
//    `fallBack` (the same, plus a diagnostic naming the reason). Dropping the run from state is what
//    disposes its frame (the sandbox feedback's `reactSet`), so there is no third path that could
//    leave a frame behind.
//  * ANY NAVIGATION DURING A RUN FINISHES THE RUN and does nothing else; the next press navigates.
//  * ONLY NEXT AND PREVIOUS PLAY TRANSITIONS. Jumps (Home, End, a typed number, a link to a slide)
//    cut, as Keynote does: playing the target's transition after skipping ten slides would animate
//    from a slide the audience did not just see in the order the author designed.
//  * THE SPARE RUNNER is normalised after every event: one is minted (with an id from `idSeed`)
//    when the show has a scripted transition, no run is live and the backoff allows; one that never
//    becomes ready is dropped after `runnerReadyTimeoutMilliseconds` with exponential backoff, so a
//    broken runner site costs a frame every few seconds at most, never a loop.
//  * RUNNER MESSAGES ARE CHECKED AGAINST THE LIVE RUN: wrong runner, wrong `runId`, or a message
//    out of phase order is counted (`rejectedMessageCount`) or ends the run as `protocolViolation`;
//    nothing a runner says is trusted beyond moving its own run forward.
//  * A BUILD SEGMENT IS A RUN ON ONE SLIDE (`fromSlideId === toSlideId`, `toBuild = fromBuild + 1`),
//    hosted like a transition: in the page for built-in effects, in the sandbox for a scripted step,
//    with the same deadlines and the same two endings. Next runs the next segment and only leaves the
//    slide at the end of its sequence, the outgoing slide drawn at its final build; Previous steps
//    back to the last click boundary WITHOUT animating, and from the first one goes to the previous
//    slide, which arrives fully built.
//  * CHAINED SEGMENTS FOLLOW BY THEMSELVES, as a normalisation after every event (`continueBuilds`,
//    like the spare runner's): whenever no run is live and the slide rests on a segment that does
//    not wait for a click, it starts. So the arrival of a slide, the end of the previous segment, a
//    fallback, the start of the show and a jump all chain the same way, with nothing to forget.
//  * NAVIGATION DURING A RUN FINISHES IT TO THE NEXT CLICK BOUNDARY: the run's outcome is shown and
//    the chained segments after it appear at once, so the following press continues from where the
//    presenter would have been waiting anyway.
//  * A BUILD THAT CANNOT PLAY APPEARS AT ONCE (builds/build-resolution.ts): reduced motion silently,
//    an unapproved, missing or wrong-purpose script with a substitution diagnostic.

import { isRestingBuild, type BuildSegment } from "../contracts/animations.ts";
import { assertNever } from "../contracts/assert-never.ts";
import type { DocumentSnapshot } from "../contracts/document.ts";
import type { KeyChord } from "../contracts/editor-events.ts";
import { mintId, type RunnerId, type SlideId, type TransitionRunId } from "../contracts/ids.ts";
import type {
  PresenterEvent,
  PresenterNavigation,
  PresenterScreen,
  ResolvedTransition,
  RunnerSlot,
  TransitionDiagnostic,
  TransitionRun,
  TransitionRunHost,
  TransitionRunPhase,
} from "../contracts/presenter.ts";
import {
  TRANSITION_LIMITS,
  type RunnerToHostMessage,
  type TransitionDirection,
  type TransitionFallbackReason,
  type TransitionSubstitutionReason,
} from "../contracts/transition-protocol.ts";
import { BUILD_SUBSTITUTION_MESSAGES, resolveBuildSegment } from "./builds/build-resolution.ts";
import { clampBuild, finalBuildOf, slideBuildSegments } from "./builds/build-states.ts";
import { presenterKeyIntent, type PresenterKeyIntent } from "./navigation-keys.ts";
import { hostRunnerId, isBlankScreen, phaseDeadline, playlistUsesSandbox, slotRunnerId } from "./presenter-queries.ts";
import {
  CONTROLS_HIDE_AFTER_MILLISECONDS,
  MAXIMUM_DIAGNOSTICS,
  currentBuildOf,
  currentSlideOf,
  initialPreviewBaseState,
  nearestFollowingSlide,
  playlistOf,
  slideById,
  type PresenterSystemState,
} from "./presenter-state.ts";
import { resolveTransition } from "./transition-resolution.ts";

export function reducePresenter(state: PresenterSystemState, event: PresenterEvent): PresenterSystemState {
  return ensureSpareRunner(continueBuilds(reduceEvent(state, event)));
}

/**
 * A preview's starting state: the run into `slideId` already in place (presenter-state.ts header),
 * from the slide before it drawn fully built, as the audience would have left it.
 */
export function initialPreviewState(options: PreviewStartOptions): PresenterSystemState {
  const base = initialPreviewBaseState({ ...options, mode: "preview" });
  const index = options.document.slides.findIndex((slide) => slide.id === options.slideId);
  const fromSlide = index > 0 ? options.document.slides[index - 1] : undefined;
  const played = transitionTo(base, {
    fromSlideId: fromSlide?.id ?? null,
    toSlideId: options.slideId,
    direction: "forward",
    fromBuild: fromSlide === undefined ? 0 : finalBuildOf(fromSlide),
    toBuild: 0,
  });
  return played.run === null ? { ...played, previewEnded: true } : played;
}

/** `BuildPreview`'s starting state: the slide at build 0 with its first segment already playing (or ended at once). */
export function initialBuildPreviewState(options: PreviewStartOptions): PresenterSystemState {
  return continueBuilds(initialPreviewBaseState({ ...options, mode: "buildPreview" }));
}

type PreviewStartOptions = Omit<Parameters<typeof initialPreviewBaseState>[0], "mode">;

function reduceEvent(state: PresenterSystemState, event: PresenterEvent): PresenterSystemState {
  switch (event.kind) {
    case "documentChanged":
      return documentChanged(state, event.document);
    case "keyPressed":
      return keyPressed(state, event.chord);
    case "navigationRequested":
      return navigate(state, event.navigation);
    case "stageClicked":
      return navigate(state, stageClickNavigation(event.button));
    case "blankToggled":
      return blankToggled(state, event.colour);
    case "pointerActivity":
      return pointerActivity(state);
    case "speakerViewChanged":
      return state.speakerViewOpen === event.open ? state : { ...state, speakerViewOpen: event.open };
    case "exitRequested":
      return requestExit(state);
    case "clockTicked":
      return clockTicked(state, event.now);
    case "visibilityChanged":
      return state.pageVisible === event.visible ? state : { ...state, pageVisible: event.visible };
    case "runnerCreated":
      // The frame exists; its readiness deadline already runs from the slot's `since` or the run's phase.
      return state;
    case "runnerLoaded":
      return runnerLoaded(state, event.runnerId);
    case "runnerReady":
      return runnerReady(state, event.runnerId);
    case "runnerMessage":
      return runnerMessage(state, { runnerId: event.runnerId, message: event.message });
    case "runnerMessageRejected":
      return { ...state, rejectedMessageCount: state.rejectedMessageCount + 1 };
    case "pingSent":
      return pingSent(state, { runId: event.runId, sequence: event.sequence });
    case "inPageRunEnded":
      return inPageRunEnded(state, { runId: event.runId, failure: event.failure });
    case "transitionFellBack":
      return liveRun(state, event.runId) === null ? state : fallBack(state, { reason: event.reason, message: event.message });
    default:
      return assertNever(event);
  }
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

function documentChanged(state: PresenterSystemState, document: DocumentSnapshot): PresenterSystemState {
  const playlist = playlistFor(state, document);
  const current = currentSlideOf(state);
  const updated: PresenterSystemState = { ...state, document, playlist };
  const lastSlideId = playlist[playlist.length - 1];
  if (lastSlideId === undefined) return { ...updated, run: null, screen: { kind: "end", lastSlideId: current }, previewEnded: true };
  if (playlist.includes(current)) return clampScreenBuild(keepCurrentSlide(updated));
  const target =
    nearestFollowingSlide({ playlist, order: state.document.slides, slideId: current }) ??
    nearestFollowingSlide({ playlist, order: document.slides, slideId: current });
  const moved: PresenterSystemState = { ...updated, run: null, previewEnded: !isShowMode(state) || state.previewEnded };
  const screen = state.screen;
  switch (screen.kind) {
    case "end":
      return { ...moved, screen: { kind: "end", lastSlideId } };
    case "blank":
      return target === null ? { ...moved, screen: { kind: "end", lastSlideId } } : { ...moved, screen: { ...screen, resumeSlideId: target, resumeBuild: 0 } };
    case "slide":
    case "transition":
      return target === null ? { ...moved, screen: { kind: "end", lastSlideId } } : { ...moved, screen: { kind: "slide", slideId: target, build: 0 } };
    default:
      return assertNever(screen);
  }
}

function playlistFor(state: PresenterSystemState, document: DocumentSnapshot): readonly SlideId[] {
  switch (state.mode) {
    case "show":
      return playlistOf(document);
    case "preview":
    case "buildPreview":
      return document.slides.map((slide) => slide.id);
    default:
      return assertNever(state.mode);
  }
}

/** The slide on screen (or a blank screen's) holds at most as many segments as it has now. */
function clampScreenBuild(state: PresenterSystemState): PresenterSystemState {
  const screen = state.screen;
  switch (screen.kind) {
    case "slide": {
      const build = buildOn({ state, slideId: screen.slideId, build: screen.build });
      return build === screen.build ? state : { ...state, screen: { ...screen, build } };
    }
    case "blank": {
      const resumeBuild = buildOn({ state, slideId: screen.resumeSlideId, build: screen.resumeBuild });
      return resumeBuild === screen.resumeBuild ? state : { ...state, screen: { ...screen, resumeBuild } };
    }
    case "transition":
    case "end":
      return state;
    default:
      return assertNever(screen);
  }
}

/** `build` clamped to the segments the slide has in the state's document. */
function buildOn(options: Readonly<{ state: PresenterSystemState; slideId: SlideId; build: number }>): number {
  return clampBuild({ build: options.build, segments: segmentsOf(options.state, options.slideId) });
}

function segmentsOf(state: PresenterSystemState, slideId: SlideId): readonly BuildSegment[] {
  const slide = slideById(state.document, slideId);
  return slide === null ? [] : slideBuildSegments(slide);
}

/** The current slide survived; a run whose outgoing slide was deleted cannot draw it, so it finishes. */
function keepCurrentSlide(state: PresenterSystemState): PresenterSystemState {
  const run = state.run;
  if (run === null || run.fromSlideId === null) return state;
  return slideById(state.document, run.fromSlideId) === null ? completeRun(state) : state;
}

// ---------------------------------------------------------------------------------------------
// Keys, clicks and navigation
// ---------------------------------------------------------------------------------------------

function keyPressed(state: PresenterSystemState, chord: KeyChord): PresenterSystemState {
  if (!acceptsInput(state)) return state;
  const intent = presenterKeyIntent(chord);
  if (isBlankScreen(state.screen) && !isExitIntent(intent)) return resumeFromBlank(state);
  switch (intent.kind) {
    case "navigate":
      return navigate(state, intent.navigation);
    case "enter":
      return state.typedSlideNumber === ""
        ? navigate(state, { kind: "next" })
        : navigate(state, { kind: "number", number: Number.parseInt(state.typedSlideNumber, 10) });
    case "typeDigit":
      return { ...state, typedSlideNumber: (state.typedSlideNumber + intent.digit).slice(-4) };
    case "blank":
      return blankToggled(state, intent.colour);
    case "exit":
      return requestExit(state);
    case "speakerView":
    case "notHandled":
      return state;
    default:
      return assertNever(intent);
  }
}

function isExitIntent(intent: PresenterKeyIntent): boolean {
  switch (intent.kind) {
    case "exit":
      return true;
    case "navigate":
    case "enter":
    case "typeDigit":
    case "blank":
    case "speakerView":
    case "notHandled":
      return false;
    default:
      return assertNever(intent);
  }
}

function stageClickNavigation(button: "primary" | "secondary"): PresenterNavigation {
  switch (button) {
    case "primary":
      return { kind: "next" };
    case "secondary":
      return { kind: "previous" };
    default:
      return assertNever(button);
  }
}

function acceptsInput(state: PresenterSystemState): boolean {
  return !state.exitRequested && isShowMode(state);
}

function isShowMode(state: PresenterSystemState): boolean {
  switch (state.mode) {
    case "show":
      return true;
    case "preview":
    case "buildPreview":
      return false;
    default:
      return assertNever(state.mode);
  }
}

function navigate(state: PresenterSystemState, navigation: PresenterNavigation): PresenterSystemState {
  if (!acceptsInput(state)) return state;
  const cleared: PresenterSystemState = state.typedSlideNumber === "" ? state : { ...state, typedSlideNumber: "" };
  if (cleared.run !== null) return finishRunToClickBoundary(cleared);
  const screen = cleared.screen;
  switch (screen.kind) {
    case "blank":
      return resumeFromBlank(cleared);
    case "end":
      return navigateFromEnd(cleared, { navigation, lastSlideId: screen.lastSlideId });
    case "slide":
      return navigateFromSlide(cleared, { navigation, slideId: screen.slideId, build: screen.build });
    case "transition":
      // A transition screen without a run cannot persist (completeRun replaces it); treat it as its target.
      return navigateFromSlide(cleared, { navigation, slideId: screen.toSlideId, build: 0 });
    default:
      return assertNever(screen);
  }
}

function navigateFromSlide(
  state: PresenterSystemState,
  options: Readonly<{ navigation: PresenterNavigation; slideId: SlideId; build: number }>,
): PresenterSystemState {
  const index = state.playlist.indexOf(options.slideId);
  const navigation = options.navigation;
  const segments = segmentsOf(state, options.slideId);
  switch (navigation.kind) {
    case "next": {
      const segment = segments[options.build];
      if (segment !== undefined) return playSegment(state, { slideId: options.slideId, build: options.build, segment });
      const following = state.playlist[index + 1];
      if (following === undefined) return { ...state, screen: { kind: "end", lastSlideId: options.slideId } };
      return transitionTo(state, { fromSlideId: options.slideId, toSlideId: following, direction: "forward", fromBuild: options.build, toBuild: 0 });
    }
    case "previous": {
      const resting = previousRestingBuild({ segments, build: options.build });
      if (resting !== null) return { ...state, screen: { kind: "slide", slideId: options.slideId, build: resting } };
      const preceding = index > 0 ? state.playlist[index - 1] : undefined;
      if (preceding === undefined) return state;
      return transitionTo(state, {
        fromSlideId: options.slideId,
        toSlideId: preceding,
        direction: "backward",
        fromBuild: options.build,
        toBuild: segmentsOf(state, preceding).length,
      });
    }
    case "first":
    case "last":
    case "slide":
    case "number":
      return cutTo(state, { slideId: jumpTarget(state, navigation), build: 0 });
    default:
      return assertNever(navigation);
  }
}

function navigateFromEnd(
  state: PresenterSystemState,
  options: Readonly<{ navigation: PresenterNavigation; lastSlideId: SlideId }>,
): PresenterSystemState {
  const navigation = options.navigation;
  switch (navigation.kind) {
    case "next":
      return requestExit(state);
    case "previous": {
      // Back from the end screen: the last slide, fully built, as going back always arrives.
      const slideId = state.playlist.includes(options.lastSlideId) ? options.lastSlideId : (state.playlist[state.playlist.length - 1] ?? null);
      return cutTo(state, { slideId, build: slideId === null ? 0 : segmentsOf(state, slideId).length });
    }
    case "first":
    case "last":
    case "slide":
    case "number":
      return cutTo(state, { slideId: jumpTarget(state, navigation), build: 0 });
    default:
      return assertNever(navigation);
  }
}

function jumpTarget(state: PresenterSystemState, navigation: Exclude<PresenterNavigation, Readonly<{ kind: "next" | "previous" }>>): SlideId | null {
  switch (navigation.kind) {
    case "first":
      return state.playlist[0] ?? null;
    case "last":
      return state.playlist[state.playlist.length - 1] ?? null;
    case "slide":
      return state.playlist.includes(navigation.slideId) ? navigation.slideId : null;
    case "number":
      return Number.isInteger(navigation.number) && navigation.number >= 1 ? (state.playlist[navigation.number - 1] ?? null) : null;
    default:
      return assertNever(navigation);
  }
}

function cutTo(state: PresenterSystemState, options: Readonly<{ slideId: SlideId | null; build: number }>): PresenterSystemState {
  if (options.slideId === null) return state;
  return { ...state, screen: { kind: "slide", slideId: options.slideId, build: options.build } };
}

function resumeFromBlank(state: PresenterSystemState): PresenterSystemState {
  const screen = state.screen;
  switch (screen.kind) {
    case "blank":
      return { ...state, typedSlideNumber: "", screen: { kind: "slide", slideId: screen.resumeSlideId, build: buildOn({ state, slideId: screen.resumeSlideId, build: screen.resumeBuild }) } };
    case "slide":
    case "transition":
    case "end":
      return state;
    default:
      return assertNever(screen);
  }
}

function blankToggled(state: PresenterSystemState, colour: "black" | "white"): PresenterSystemState {
  if (!acceptsInput(state)) return state;
  const settled = state.run === null ? state : completeRun(state);
  if (blankColourOf(settled.screen) === colour) return resumeFromBlank(settled);
  return { ...settled, typedSlideNumber: "", screen: { kind: "blank", colour, resumeSlideId: currentSlideOf(settled), resumeBuild: currentBuildOf(settled) } };
}

function blankColourOf(screen: PresenterScreen): "black" | "white" | null {
  switch (screen.kind) {
    case "blank":
      return screen.colour;
    case "slide":
    case "transition":
    case "end":
      return null;
    default:
      return assertNever(screen);
  }
}

function pointerActivity(state: PresenterSystemState): PresenterSystemState {
  if (state.controlsVisible && state.lastActivityAt === state.now) return state;
  return { ...state, controlsVisible: true, lastActivityAt: state.now };
}

function requestExit(state: PresenterSystemState): PresenterSystemState {
  if (state.exitRequested) return state;
  return { ...state, exitRequested: true, run: null, spareRunner: { kind: "none" } };
}

// ---------------------------------------------------------------------------------------------
// Starting and ending runs
// ---------------------------------------------------------------------------------------------

/** The last click boundary before `build`: the largest position below it whose segment waits for a click. */
function previousRestingBuild(options: Readonly<{ segments: readonly BuildSegment[]; build: number }>): number | null {
  for (let position = Math.min(options.build, options.segments.length) - 1; position >= 0; position -= 1) {
    if (options.segments[position]?.startsOnClick === true) return position;
  }
  return null;
}

/** The first click boundary at or after `build`. */
function nextRestingBuild(options: Readonly<{ segments: readonly BuildSegment[]; build: number }>): number {
  let position = clampBuild({ build: options.build, segments: options.segments });
  while (!isRestingBuild({ segments: options.segments, completed: position })) position += 1;
  return position;
}

/**
 * Leave `fromSlideId` for `toSlideId`. Forward plays the transition INTO the incoming slide;
 * backward plays the transition of the slide being LEFT, with direction "backward".
 */
function transitionTo(
  state: PresenterSystemState,
  options: Readonly<{ fromSlideId: SlideId | null; toSlideId: SlideId; direction: TransitionDirection; fromBuild: number; toBuild: number }>,
): PresenterSystemState {
  const owner = transitionOwner(options);
  const transition = owner === null ? null : (slideById(state.document, owner)?.transition ?? null);
  const resolution = resolveTransition({ transition, scripts: state.document.transitionScripts, reducedMotion: state.reducedMotion });
  switch (resolution.kind) {
    case "cut":
      return { ...state, run: null, screen: { kind: "slide", slideId: options.toSlideId, build: options.toBuild } };
    case "play":
      return startRun(state, { ...options, transition: resolution.transition });
    default:
      return assertNever(resolution);
  }
}

function transitionOwner(options: Readonly<{ fromSlideId: SlideId | null; toSlideId: SlideId; direction: TransitionDirection }>): SlideId | null {
  switch (options.direction) {
    case "forward":
      return options.toSlideId;
    case "backward":
      return options.fromSlideId;
    default:
      return assertNever(options.direction);
  }
}

/**
 * Play segment `build` of the slide on screen, or, when it cannot play (builds/build-resolution.ts),
 * show its outcome at once.
 */
function playSegment(state: PresenterSystemState, options: Readonly<{ slideId: SlideId; build: number; segment: BuildSegment }>): PresenterSystemState {
  const resolution = resolveBuildSegment({ segment: options.segment, scripts: state.document.transitionScripts, reducedMotion: state.reducedMotion });
  switch (resolution.kind) {
    case "play":
      return startRun(state, {
        fromSlideId: options.slideId,
        toSlideId: options.slideId,
        fromBuild: options.build,
        toBuild: options.build + 1,
        direction: "forward",
        transition: resolution.transition,
      });
    case "instant": {
      const shown: PresenterSystemState = { ...state, run: null, screen: { kind: "slide", slideId: options.slideId, build: options.build + 1 } };
      if (resolution.substitution === null) return shown;
      return appendDiagnostic(shown, {
        at: state.now,
        slideId: options.slideId,
        kind: "substitution",
        reason: resolution.substitution,
        message: BUILD_SUBSTITUTION_MESSAGES[resolution.substitution],
      });
    }
    default:
      return assertNever(resolution);
  }
}

/** Chained segments follow by themselves (see the header); a build preview plays every segment, then ends. */
function continueBuilds(state: PresenterSystemState): PresenterSystemState {
  if (state.exitRequested || state.run !== null) return state;
  const screen = state.screen;
  switch (screen.kind) {
    case "slide":
      break;
    case "transition":
    case "blank":
    case "end":
      return state;
    default:
      return assertNever(screen);
  }
  const segments = segmentsOf(state, screen.slideId);
  const segment = segments[screen.build];
  switch (state.mode) {
    case "preview":
      return state;
    case "show":
      if (segment === undefined || isRestingBuild({ segments, completed: screen.build })) return state;
      return continueBuilds(playSegment(state, { slideId: screen.slideId, build: screen.build, segment }));
    case "buildPreview":
      if (state.previewEnded) return state;
      if (segment === undefined) return { ...state, previewEnded: true };
      // Under reduced motion the preview shows the fully built slide and ends.
      if (state.reducedMotion) return { ...state, screen: { ...screen, build: segments.length }, previewEnded: true };
      return continueBuilds(playSegment(state, { slideId: screen.slideId, build: screen.build, segment }));
    default:
      return assertNever(state.mode);
  }
}

function startRun(
  state: PresenterSystemState,
  options: Readonly<{
    fromSlideId: SlideId | null;
    toSlideId: SlideId;
    fromBuild: number;
    toBuild: number;
    direction: TransitionDirection;
    transition: ResolvedTransition;
  }>,
): PresenterSystemState {
  const minted = mintId({ seed: state.idSeed, kind: "transitionRun" });
  const placement = placeRun({ state: { ...state, idSeed: minted.seed }, transition: options.transition });
  const run: TransitionRun = {
    runId: minted.id,
    host: placement.host,
    fromSlideId: options.fromSlideId,
    toSlideId: options.toSlideId,
    fromBuild: options.fromBuild,
    toBuild: options.toBuild,
    transition: options.transition,
    direction: options.direction,
    phase: placement.phase,
    phaseVisibleMilliseconds: 0,
    outstandingPing: null,
    nextPingSequence: 1,
    progress: 0,
  };
  const started: PresenterSystemState = {
    ...placement.state,
    run,
    runLogCount: 0,
    screen: { kind: "transition", fromSlideId: options.fromSlideId, toSlideId: options.toSlideId },
  };
  const substitution = substitutionOf(options.transition);
  if (substitution === null) return started;
  return appendDiagnostic(started, {
    at: state.now,
    slideId: options.toSlideId,
    kind: "substitution",
    reason: substitution,
    message: SUBSTITUTION_MESSAGES[substitution],
  });
}

/** Where a run is hosted: in-page for built-ins and the substituted fade, else a runner (the spare when there is one). */
function placeRun(
  options: Readonly<{ state: PresenterSystemState; transition: ResolvedTransition }>,
): Readonly<{ state: PresenterSystemState; host: TransitionRunHost; phase: TransitionRunPhase }> {
  const state = options.state;
  switch (options.transition.kind) {
    case "builtin":
    case "substitutedFade":
    case "build":
      return { state, host: { kind: "inPage" }, phase: "running" };
    case "scripted":
      break;
    default:
      return assertNever(options.transition);
  }
  const spare = state.spareRunner;
  switch (spare.kind) {
    case "ready":
      return {
        state: { ...state, spareRunner: { kind: "none" } },
        host: { kind: "sandbox", runnerId: spare.runnerId, loadCount: spare.loadCount },
        phase: "preparing",
      };
    case "loading":
      return {
        state: { ...state, spareRunner: { kind: "none" } },
        host: { kind: "sandbox", runnerId: spare.runnerId, loadCount: spare.loadCount },
        phase: "awaitingRunner",
      };
    case "none": {
      const runner = mintId({ seed: state.idSeed, kind: "runner" });
      return { state: { ...state, idSeed: runner.seed }, host: { kind: "sandbox", runnerId: runner.id, loadCount: 0 }, phase: "awaitingRunner" };
    }
    default:
      return assertNever(spare);
  }
}

function substitutionOf(transition: ResolvedTransition): TransitionSubstitutionReason | null {
  switch (transition.kind) {
    case "builtin":
    case "scripted":
    case "build":
      return null;
    case "substitutedFade":
      return transition.reason;
    default:
      return assertNever(transition);
  }
}

const SUBSTITUTION_MESSAGES: Readonly<Record<TransitionSubstitutionReason, string>> = {
  reducedMotion: "Played a short fade instead: the viewer prefers reduced motion.",
  scriptNotApproved: "Played a short fade instead: this transition script is waiting for a person to review and approve it.",
  scriptMissing: "Played a short fade instead: the transition script this slide names is not in the deck.",
};

/** The incoming slide on screen at the run's build position; the run (and so its frame) is gone. */
function completeRun(state: PresenterSystemState): PresenterSystemState {
  const run = state.run;
  if (run === null) return state;
  return {
    ...state,
    run: null,
    runLogCount: 0,
    screen: { kind: "slide", slideId: run.toSlideId, build: buildOn({ state, slideId: run.toSlideId, build: run.toBuild }) },
    previewEnded: endsWithOneRun(state) || state.previewEnded,
  };
}

/** A transition preview ends with its one run; a build preview plays segment after segment. */
function endsWithOneRun(state: PresenterSystemState): boolean {
  switch (state.mode) {
    case "preview":
      return true;
    case "show":
    case "buildPreview":
      return false;
    default:
      return assertNever(state.mode);
  }
}

/** Navigation during a run (see the header): the run's outcome, then every chained segment at once. */
function finishRunToClickBoundary(state: PresenterSystemState): PresenterSystemState {
  const completed = completeRun(state);
  const screen = completed.screen;
  switch (screen.kind) {
    case "slide":
      return { ...completed, screen: { ...screen, build: nextRestingBuild({ segments: segmentsOf(completed, screen.slideId), build: screen.build }) } };
    case "transition":
    case "blank":
    case "end":
      return completed;
    default:
      return assertNever(screen);
  }
}

/** Cut to the incoming slide and say why. */
function fallBack(state: PresenterSystemState, options: Readonly<{ reason: TransitionFallbackReason; message: string }>): PresenterSystemState {
  const run = state.run;
  if (run === null) return state;
  return appendDiagnostic(completeRun(state), {
    at: state.now,
    slideId: run.toSlideId,
    kind: "fallback",
    reason: options.reason,
    message: truncate(options.message),
  });
}

function appendDiagnostic(state: PresenterSystemState, diagnostic: TransitionDiagnostic): PresenterSystemState {
  return { ...state, diagnostics: [...state.diagnostics, diagnostic].slice(-MAXIMUM_DIAGNOSTICS) };
}

function truncate(message: string): string {
  return message.length <= TRANSITION_LIMITS.maximumLogMessageLength ? message : `${message.slice(0, TRANSITION_LIMITS.maximumLogMessageLength - 1)}…`;
}

function liveRun(state: PresenterSystemState, runId: TransitionRunId): TransitionRun | null {
  return state.run !== null && state.run.runId === runId ? state.run : null;
}

// ---------------------------------------------------------------------------------------------
// Time and deadlines
// ---------------------------------------------------------------------------------------------

function clockTicked(state: PresenterSystemState, now: number): PresenterSystemState {
  const elapsed = Math.max(0, now - state.now);
  const ticked: PresenterSystemState = {
    ...state,
    now,
    controlsVisible: now - state.lastActivityAt < CONTROLS_HIDE_AFTER_MILLISECONDS,
    run: state.run === null || !state.pageVisible ? state.run : accrueVisibleTime(state.run, elapsed),
  };
  return expireSpareRunner(checkDeadlines(ticked));
}

function accrueVisibleTime(run: TransitionRun, elapsed: number): TransitionRun {
  return {
    ...run,
    phaseVisibleMilliseconds: run.phaseVisibleMilliseconds + elapsed,
    outstandingPing: run.outstandingPing === null ? null : { ...run.outstandingPing, visibleMillisecondsWaiting: run.outstandingPing.visibleMillisecondsWaiting + elapsed },
  };
}

function checkDeadlines(state: PresenterSystemState): PresenterSystemState {
  const run = state.run;
  if (run === null) return state;
  if (run.outstandingPing !== null && run.outstandingPing.visibleMillisecondsWaiting >= TRANSITION_LIMITS.stallTimeoutMilliseconds) {
    return fallBack(state, {
      reason: "stalled",
      message: `The transition stopped answering: ping ${run.outstandingPing.sequence} waited ${Math.round(run.outstandingPing.visibleMillisecondsWaiting)} visible milliseconds.`,
    });
  }
  const deadline = phaseDeadline(run);
  if (deadline === null || run.phaseVisibleMilliseconds < deadline.milliseconds) return state;
  return fallBack(state, {
    reason: deadline.reason,
    message: `The transition spent ${Math.round(run.phaseVisibleMilliseconds)} visible milliseconds ${PHASE_DESCRIPTIONS[run.phase]} (limit ${deadline.milliseconds}).`,
  });
}

const PHASE_DESCRIPTIONS: Readonly<Record<TransitionRunPhase, string>> = {
  awaitingRunner: "waiting for its runner to load",
  preparing: "preparing",
  prepared: "waiting to start",
  running: "running",
};

function expireSpareRunner(state: PresenterSystemState): PresenterSystemState {
  const loadingSince = loadingSinceOf(state.spareRunner);
  if (loadingSince === null || state.now - loadingSince < TRANSITION_LIMITS.runnerReadyTimeoutMilliseconds) return state;
  const failures = state.spareRetry.failures + 1;
  return {
    ...state,
    spareRunner: { kind: "none" },
    spareRetry: { failures, notBefore: state.now + spareBackoffMilliseconds(failures) },
  };
}

function loadingSinceOf(slot: RunnerSlot): number | null {
  switch (slot.kind) {
    case "loading":
      return slot.since;
    case "none":
    case "ready":
      return null;
    default:
      return assertNever(slot);
  }
}

/** 1, 2, 4 ... seconds after consecutive failures, at most 30. */
function spareBackoffMilliseconds(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), 30_000);
}

// ---------------------------------------------------------------------------------------------
// The spare runner and the runner's messages
// ---------------------------------------------------------------------------------------------

function ensureSpareRunner(state: PresenterSystemState): PresenterSystemState {
  if (slotRunnerId(state.spareRunner) !== null || state.run !== null || state.exitRequested) return state;
  if (!isShowMode(state) || state.now < state.spareRetry.notBefore || !playlistUsesSandbox(state)) return state;
  const runner = mintId({ seed: state.idSeed, kind: "runner" });
  return { ...state, idSeed: runner.seed, spareRunner: { kind: "loading", runnerId: runner.id, since: state.now, loadCount: 0 } };
}



function runnerLoaded(state: PresenterSystemState, runnerId: RunnerId): PresenterSystemState {
  const spare = state.spareRunner;
  switch (spare.kind) {
    case "loading":
    case "ready":
      if (spare.runnerId !== runnerId) break;
      // A spare that navigated itself is simply replaced; nothing was playing on it.
      if (spare.loadCount + 1 >= 2) return { ...state, spareRunner: { kind: "none" } };
      return { ...state, spareRunner: { ...spare, loadCount: spare.loadCount + 1 } };
    case "none":
      break;
    default:
      return assertNever(spare);
  }
  const run = state.run;
  if (run === null) return state;
  const host = run.host;
  switch (host.kind) {
    case "inPage":
      return state;
    case "sandbox":
      if (host.runnerId !== runnerId) return state;
      if (host.loadCount + 1 >= 2) return fallBack(state, { reason: "runnerNavigated", message: "The transition's frame navigated itself away; the run was ended." });
      return { ...state, run: { ...run, host: { ...host, loadCount: host.loadCount + 1 } } };
    default:
      return assertNever(host);
  }
}

function runnerReady(state: PresenterSystemState, runnerId: RunnerId): PresenterSystemState {
  const spare = state.spareRunner;
  if (loadingSinceOf(spare) !== null && slotRunnerId(spare) === runnerId) {
    return { ...state, spareRunner: { kind: "ready", runnerId, loadCount: spareLoadCount(spare) }, spareRetry: { failures: 0, notBefore: state.now } };
  }
  const run = state.run;
  if (run === null || hostRunnerId(run.host) !== runnerId || run.phase !== "awaitingRunner") return state;
  return { ...state, run: { ...run, phase: "preparing", phaseVisibleMilliseconds: 0 } };
}

function spareLoadCount(slot: RunnerSlot): number {
  switch (slot.kind) {
    case "none":
      return 0;
    case "loading":
    case "ready":
      return slot.loadCount;
    default:
      return assertNever(slot);
  }
}

function runnerMessage(state: PresenterSystemState, options: Readonly<{ runnerId: RunnerId; message: RunnerToHostMessage }>): PresenterSystemState {
  const run = state.run;
  const message = options.message;
  if (run === null || hostRunnerId(run.host) !== options.runnerId || message.runId !== run.runId) {
    return { ...state, rejectedMessageCount: state.rejectedMessageCount + 1 };
  }
  switch (message.kind) {
    case "prepared":
      return run.phase === "preparing" ? enterPhase(state, { run, phase: "prepared" }) : protocolViolation(state, "prepared", run.phase);
    case "started":
      return run.phase === "prepared" ? enterPhase(state, { run, phase: "running" }) : protocolViolation(state, "started", run.phase);
    case "pong":
      return pong(state, { run, sequence: message.sequence, progress: message.progress });
    case "finished":
      return run.phase === "running" ? completeRun(state) : protocolViolation(state, "finished", run.phase);
    case "failed":
      return fallBack(state, { reason: "scriptFailed", message: `The transition script failed while ${FAILURE_STAGES[message.stage]}: ${message.message}` });
    case "log":
      return runnerLog(state, { run, level: message.level, message: message.message });
    default:
      return assertNever(message);
  }
}

const FAILURE_STAGES: Readonly<Record<Extract<RunnerToHostMessage, { kind: "failed" }>["stage"], string>> = {
  define: "defining itself",
  prepare: "preparing",
  run: "running",
};

function enterPhase(state: PresenterSystemState, options: Readonly<{ run: TransitionRun; phase: TransitionRunPhase }>): PresenterSystemState {
  return { ...state, run: { ...options.run, phase: options.phase, phaseVisibleMilliseconds: 0, outstandingPing: null } };
}

function protocolViolation(state: PresenterSystemState, kind: string, phase: TransitionRunPhase): PresenterSystemState {
  return fallBack(state, { reason: "protocolViolation", message: `The runner sent "${kind}" while the run was ${PHASE_DESCRIPTIONS[phase]}.` });
}

function pong(state: PresenterSystemState, options: Readonly<{ run: TransitionRun; sequence: number; progress: number }>): PresenterSystemState {
  if (options.run.phase !== "running") return { ...state, rejectedMessageCount: state.rejectedMessageCount + 1 };
  const outstanding = options.run.outstandingPing;
  const answered = outstanding !== null && options.sequence >= outstanding.sequence;
  const progress = Number.isFinite(options.progress) ? Math.min(Math.max(options.progress, 0), 1) : options.run.progress;
  return { ...state, run: { ...options.run, outstandingPing: answered ? null : outstanding, progress } };
}

function runnerLog(
  state: PresenterSystemState,
  options: Readonly<{ run: TransitionRun; level: "information" | "warning" | "error"; message: string }>,
): PresenterSystemState {
  if (state.runLogCount >= TRANSITION_LIMITS.maximumLogMessagesPerRun) return state;
  return {
    ...appendDiagnostic(state, { at: state.now, slideId: options.run.toSlideId, kind: "log", reason: null, message: truncate(`${options.level}: ${options.message}`) }),
    runLogCount: state.runLogCount + 1,
  };
}

function pingSent(state: PresenterSystemState, options: Readonly<{ runId: TransitionRunId; sequence: number }>): PresenterSystemState {
  const run = liveRun(state, options.runId);
  if (run === null || hostRunnerId(run.host) === null || run.phase !== "running") return state;
  return {
    ...state,
    run: {
      ...run,
      nextPingSequence: Math.max(run.nextPingSequence, options.sequence + 1),
      outstandingPing: run.outstandingPing ?? { sequence: options.sequence, visibleMillisecondsWaiting: 0 },
    },
  };
}

function inPageRunEnded(state: PresenterSystemState, options: Readonly<{ runId: TransitionRunId; failure: string | null }>): PresenterSystemState {
  const run = liveRun(state, options.runId);
  if (run === null || hostRunnerId(run.host) !== null) return state;
  if (options.failure === null) return completeRun(state);
  return fallBack(state, { reason: "scriptFailed", message: `The transition failed: ${options.failure}` });
}
