// THE PRESENTER'S STATE TREE: the contract's `PresenterState` (contracts/presenter.ts), and the pure
// functions that build a starting state and derive things from one (the playlist, the slide on
// screen).
//
// Key decisions:
//
//  * `PresenterSystemState` IS THE CONTRACT'S `PresenterState`, under the name the presenter's files
//    already use; every field the reducer needs -- reduced motion, the rejected message count, the
//    log count of the current run, the spare runner's retry backoff, the preview mode -- is in the
//    contract, so a diagnostics panel or a bug report reads the whole state.
//
//  * REDUCED MOTION IS STATE, read once by the composition root. The reducer resolves a slide's
//    transition (and substitutes the 150 millisecond fade under reduced motion), so the preference
//    must be in state for the reducer to stay pure and replayable.
//
//  * THE PLAYLIST IS DERIVED, then stored. `playlistOf` is the one definition (non-skipped slides in
//    deck order); the reducer stores its result so the view and the feedbacks never recompute it,
//    and recomputes it on every `documentChanged`.
//
//  * A PREVIEW IS A SHOW OF ONE TRANSITION. `TransitionPreview` runs the same reducer and hosts in
//    `mode: "preview"`, starting with the run already in place (the transition into the previewed
//    slide from the slide before it in deck order, skipped or not), and ignores navigation.

import type { DocumentSnapshot, SlideSnapshot } from "../contracts/document.ts";
import { assertNever } from "../contracts/assert-never.ts";
import type { IdSeed, SlideId } from "../contracts/ids.ts";
import type { PresenterMode, PresenterScreen, PresenterState, SpareRunnerRetry, TransitionRun } from "../contracts/presenter.ts";

export type { PresenterMode, SpareRunnerRetry };

export type PresenterSystemState = PresenterState;

export const MAXIMUM_DIAGNOSTICS = 20;
/** Controls hide after this long without pointer movement (SPEC.md section 10). */
export const CONTROLS_HIDE_AFTER_MILLISECONDS = 2500;

/** The state a show starts in: the start slide (or the nearest following one) on screen, no transition. */
export function initialShowState(
  options: Readonly<{ document: DocumentSnapshot; startSlideId: SlideId; idSeed: IdSeed; now: number; reducedMotion: boolean }>,
): PresenterSystemState {
  const playlist = playlistOf(options.document);
  const startSlideId = playlist.includes(options.startSlideId)
    ? options.startSlideId
    : nearestFollowingSlide({ playlist, order: options.document.slides, slideId: options.startSlideId });
  const screen: PresenterScreen =
    startSlideId === null ? { kind: "end", lastSlideId: options.startSlideId } : { kind: "slide", slideId: startSlideId };
  return baseState({ ...options, playlist, screen, mode: "show" });
}

/**
 * The state a preview starts in: the run into `slideId` from the slide before it in deck order
 * (null for the first slide) is built by `startPreviewRun` in the reducer module, which needs the
 * transition resolution; this is the state before that run.
 */
export function initialPreviewBaseState(
  options: Readonly<{ document: DocumentSnapshot; slideId: SlideId; idSeed: IdSeed; now: number; reducedMotion: boolean }>,
): PresenterSystemState {
  const playlist = options.document.slides.map((slide) => slide.id);
  return baseState({ ...options, playlist, screen: { kind: "slide", slideId: options.slideId }, mode: "preview" });
}

/** Non-skipped slides in deck order. */
export function playlistOf(document: DocumentSnapshot): readonly SlideId[] {
  return document.slides.filter((slide) => !slide.skipped).map((slide) => slide.id);
}

/**
 * The first slide after `slideId` in `order` that is in the playlist; null when there is none or
 * `slideId` is not in `order`.
 */
export function nearestFollowingSlide(
  options: Readonly<{ playlist: readonly SlideId[]; order: readonly SlideSnapshot[]; slideId: SlideId }>,
): SlideId | null {
  const index = options.order.findIndex((slide) => slide.id === options.slideId);
  if (index < 0) return null;
  for (const slide of options.order.slice(index + 1)) {
    if (options.playlist.includes(slide.id)) return slide.id;
  }
  return null;
}

/** The slide the audience is on: the one shown, the one a transition goes to, or the one a blank screen resumes. */
export function currentSlideOf(state: PresenterState): SlideId {
  const screen = state.screen;
  switch (screen.kind) {
    case "slide":
      return screen.slideId;
    case "transition":
      return screen.toSlideId;
    case "blank":
      return screen.resumeSlideId;
    case "end":
      return screen.lastSlideId;
    default:
      return assertNever(screen);
  }
}

export function slideById(document: DocumentSnapshot, slideId: SlideId): SlideSnapshot | null {
  return document.slides.find((slide) => slide.id === slideId) ?? null;
}

/** 1-based position in the deck (automatic slide numbers count skipped slides, as in Slides). */
export function deckSlideNumber(document: DocumentSnapshot, slideId: SlideId): number {
  return document.slides.findIndex((slide) => slide.id === slideId) + 1;
}

/** The run's declared length; the substituted fade has its own. */
export function runDurationMilliseconds(run: TransitionRun, substituteFadeMilliseconds: number): number {
  const transition = run.transition;
  switch (transition.kind) {
    case "builtin":
    case "scripted":
      return transition.durationMilliseconds;
    case "substitutedFade":
      return substituteFadeMilliseconds;
    default:
      return assertNever(transition);
  }
}

function baseState(
  options: Readonly<{
    document: DocumentSnapshot;
    idSeed: IdSeed;
    now: number;
    reducedMotion: boolean;
    playlist: readonly SlideId[];
    screen: PresenterScreen;
    mode: PresenterMode;
  }>,
): PresenterSystemState {
  return {
    idSeed: options.idSeed,
    document: options.document,
    playlist: options.playlist,
    screen: options.screen,
    spareRunner: { kind: "none" },
    run: null,
    startedAt: options.now,
    now: options.now,
    pageVisible: true,
    typedSlideNumber: "",
    controlsVisible: true,
    lastActivityAt: options.now,
    speakerViewOpen: false,
    diagnostics: [],
    exitRequested: false,
    mode: options.mode,
    reducedMotion: options.reducedMotion,
    rejectedMessageCount: 0,
    runLogCount: 0,
    spareRetry: { failures: 0, notBefore: options.now },
    previewEnded: false,
  };
}
