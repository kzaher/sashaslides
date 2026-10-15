// THE PRESENTER: slideshow state, events and dependencies. Its own small RxFeedback system,
// separate from the editor's, because presenting has a different lifetime (it can outlive editing
// in a second window) and its effects are timers, animations and a sandboxed frame, none of which
// the editor needs. The RxFeedback toolkit (`createSystem`, `react`, `reactSet`) is INJECTED: the
// state module owns the implementation, and the presenter codes against the contract
// (rxfeedback.ts), so the two modules are built in parallel without importing each other.
//
// Key decisions:
//
//  * THE PLAYLIST SKIPS SKIPPED SLIDES and is recomputed when the document changes mid-show
//    (a collaborator edits while you present): the current slide stays current if it still exists,
//    otherwise the show moves to the nearest following slide.
//
//  * A TRANSITION IS AN ENTITY WITH A DEADLINE. `TransitionRun.phase` walks awaitingRunner ->
//    preparing -> prepared -> running (in-page runs skip awaitingRunner); each phase has a deadline
//    from TRANSITION_LIMITS, counted only while the page is visible (`phaseVisibleMilliseconds`
//    grows on `clockTicked` only when `pageVisible`). A sandboxed run's frame is owned by a
//    `reactSet` feedback keyed by `runnerId`, so dropping the runner from state disposes the frame
//    -- the only way a runner ever goes away.
//
//  * BUILT-INS RUN IN-PAGE, SCRIPTS IN THE SANDBOX (transition-protocol.ts header). A spare runner
//    is warmed only while the playlist contains a scripted transition, so a show of fades never
//    loads the runner site at all.
//
//  * PRESSING NEXT DURING A TRANSITION FINISHES IT, it does not queue: the run is cancelled, the
//    incoming slide is shown, and the next press navigates.
//
//  * BACKWARD NAVIGATION plays the transition of the slide being LEFT with direction "backward"
//    (Keynote's behaviour), so a push from the right reverses into a push from the left.
//
//  * A SLIDE IS SHOWN AT A BUILD POSITION. `build` counts the slide's build segments already played
//    (animations.ts `buildSegmentsOf`): a click or Next runs the next segment, and the segments
//    chained to it follow by themselves; only at the end of the sequence does Next leave the slide.
//    Previous steps back to the last click boundary without animating, and from the first one it
//    goes to the previous slide, arriving FULLY BUILT, as PowerPoint and Keynote do. A slide entered
//    forward starts at build 0, its entrance elements hidden. What the slide looks like at a
//    position is derived from the steps' declared outcomes alone (presenter/builds/), so a jump, a
//    step back, reduced motion (builds appear at once) and the transition out of the slide -- a
//    morph included -- all draw the same slide. A build segment is a run like a transition's: in
//    the page for built-in effects, in the sandbox for a scripted step, with the same deadlines.
//
//  * THE SPEAKER VIEW IS THE SAME REACT TREE IN A SECOND WINDOW, rendered by portal into a window
//    the CALLER opened inside a click or key handler (popup blockers refuse `window.open` after an
//    asynchronous step): either the caller's own Present handler (`speakerWindow`), or the
//    presenter's speaker view button and S key, which call `onSpeakerViewRequested` synchronously.
//    Full screen is likewise entered by the caller's handler. The presenter never calls either
//    browser function itself.

import type { Observable, SchedulerLike } from "rxjs";
import type { AssetStore } from "./document-store.ts";
import type { BuildSegment } from "./animations.ts";
import type { BuiltinTransitionEffect, DocumentSnapshot, TransitionEasing } from "./document.ts";
import type { KeyChord } from "./editor-events.ts";
import type { IdSeed, RunnerId, SlideId, TransitionRunId, TransitionScriptId } from "./ids.ts";
import type { FontFaceRequest, RenderSlideMarkup, StaticSlideComponent } from "./render.ts";
import type { CreateReactFeedback, CreateReactSetFeedback, CreateSystem } from "./rxfeedback.ts";
import type { SerialisableObject } from "./serialisable.ts";
import type {
  RunnerToHostMessage,
  TransferredFont,
  TransitionDirection,
  TransitionFallbackReason,
  TransitionSubstitutionReason,
} from "./transition-protocol.ts";

export type PresenterState = Readonly<{
  idSeed: IdSeed;
  document: DocumentSnapshot;
  /** Non-skipped slides in order. */
  playlist: readonly SlideId[];
  screen: PresenterScreen;
  /** A pre-loaded runner, kept only while the playlist has a scripted transition. */
  spareRunner: RunnerSlot;
  /** At most one live run. */
  run: TransitionRun | null;
  startedAt: number;
  /** From `clockTicked`; the reducer's only notion of time. */
  now: number;
  pageVisible: boolean;
  /** Digits typed for "number + Enter goes to slide". */
  typedSlideNumber: string;
  /** Pointer moved recently: controls shown; hidden after 2.5 seconds of stillness. */
  controlsVisible: boolean;
  lastActivityAt: number;
  speakerViewOpen: boolean;
  /** The most recent fallbacks, substitutions and runner logs, newest last, at most 20. */
  diagnostics: readonly TransitionDiagnostic[];
  exitRequested: boolean;
  /** A show, or `TransitionPreview`'s show of one transition (which ignores navigation). */
  mode: PresenterMode;
  /**
   * The viewer prefers reduced motion, read once by the composition root: the reducer substitutes
   * the short fade, so the preference is state for the reducer to stay pure and replayable.
   */
  reducedMotion: boolean;
  /** Runner messages that failed validation or named another run; counted, never trusted. */
  rejectedMessageCount: number;
  /** Runner log messages accepted for the current run (at most `maximumLogMessagesPerRun`). */
  runLogCount: number;
  /** Backoff for spare runners that never became ready, so a broken runner site is not reloaded in a loop. */
  spareRetry: SpareRunnerRetry;
  /** Preview only: the transition finished, fell back, or there was nothing to play. */
  previewEnded: boolean;
}>;

/**
 * A show; `TransitionPreview`'s show of one transition; or `BuildPreview`'s play-through of one
 * slide's builds (every segment in turn, clicks included, then ended). Both previews ignore navigation.
 */
export type PresenterMode = "show" | "preview" | "buildPreview";

export type SpareRunnerRetry = Readonly<{
  /** Consecutive spare runners that never became ready. */
  failures: number;
  /** No new spare is created before this time (exponential backoff). */
  notBefore: number;
}>;

export type PresenterScreen =
  /** `build`: how many of the slide's build segments have played (see the header). */
  | Readonly<{ kind: "slide"; slideId: SlideId; build: number }>
  /** Drawing the run's stage over the outgoing slide. */
  | Readonly<{ kind: "transition"; fromSlideId: SlideId | null; toSlideId: SlideId }>
  /** `resumeBuild`: the build position the slide is resumed at, so blanking never replays or loses builds. */
  | Readonly<{ kind: "blank"; colour: "black" | "white"; resumeSlideId: SlideId; resumeBuild: number }>
  /** "End of presentation" after the last slide; next exits. */
  | Readonly<{ kind: "end"; lastSlideId: SlideId }>;

export type RunnerSlot =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loading"; runnerId: RunnerId; since: number; loadCount: number }>
  | Readonly<{ kind: "ready"; runnerId: RunnerId; loadCount: number }>;

/** What the host actually plays, after substitution. */
export type ResolvedTransition =
  | Readonly<{ kind: "builtin"; effect: BuiltinTransitionEffect; durationMilliseconds: number; easing: TransitionEasing }>
  | Readonly<{ kind: "scripted"; scriptId: TransitionScriptId; fingerprint: string; durationMilliseconds: number; parameters: SerialisableObject }>
  | Readonly<{ kind: "substitutedFade"; reason: TransitionSubstitutionReason }>
  /** A segment of built-in build steps, played in the page on one slide (a scripted step is `scripted`). */
  | Readonly<{ kind: "build"; segment: BuildSegment }>;

export type TransitionRunHost =
  | Readonly<{ kind: "inPage" }>
  | Readonly<{ kind: "sandbox"; runnerId: RunnerId; loadCount: number }>;

export type TransitionRunPhase = "awaitingRunner" | "preparing" | "prepared" | "running";

export type TransitionRun = Readonly<{
  runId: TransitionRunId;
  host: TransitionRunHost;
  fromSlideId: SlideId | null;
  toSlideId: SlideId;
  /**
   * The build positions the two sides are drawn at: the outgoing slide as the audience last saw it,
   * the incoming slide as it arrives. A build segment's run has `fromSlideId === toSlideId` and
   * `toBuild === fromBuild + 1`.
   */
  fromBuild: number;
  toBuild: number;
  transition: ResolvedTransition;
  direction: TransitionDirection;
  phase: TransitionRunPhase;
  /** Visible time spent in the current phase (see the header). */
  phaseVisibleMilliseconds: number;
  /** The oldest unanswered ping and the visible time it has waited; sandbox runs only. */
  outstandingPing: Readonly<{ sequence: number; visibleMillisecondsWaiting: number }> | null;
  nextPingSequence: number;
  progress: number;
}>;

export type TransitionDiagnostic = Readonly<{
  at: number;
  slideId: SlideId;
  kind: "fallback" | "substitution" | "log";
  reason: TransitionFallbackReason | TransitionSubstitutionReason | null;
  message: string;
}>;

export type PresenterNavigation =
  | Readonly<{ kind: "next" }>
  | Readonly<{ kind: "previous" }>
  | Readonly<{ kind: "first" }>
  | Readonly<{ kind: "last" }>
  | Readonly<{ kind: "slide"; slideId: SlideId }>
  /** 1-based position in the playlist, from typed digits. */
  | Readonly<{ kind: "number"; number: number }>;

export type PresenterEvent =
  | Readonly<{ kind: "documentChanged"; document: DocumentSnapshot }>
  | Readonly<{ kind: "keyPressed"; chord: KeyChord }>
  | Readonly<{ kind: "navigationRequested"; navigation: PresenterNavigation }>
  | Readonly<{ kind: "stageClicked"; button: "primary" | "secondary" }>
  | Readonly<{ kind: "blankToggled"; colour: "black" | "white" }>
  | Readonly<{ kind: "pointerActivity" }>
  /** The caller's handler opened (or failed to open) the speaker window. */
  | Readonly<{ kind: "speakerViewChanged"; open: boolean }>
  | Readonly<{ kind: "exitRequested" }>
  | Readonly<{ kind: "clockTicked"; now: number }>
  | Readonly<{ kind: "visibilityChanged"; visible: boolean }>
  | Readonly<{ kind: "runnerCreated"; runnerId: RunnerId }>
  /** The runner frame fired `load`; a second load is a self-navigation (`runnerNavigated`). */
  | Readonly<{ kind: "runnerLoaded"; runnerId: RunnerId }>
  | Readonly<{ kind: "runnerReady"; runnerId: RunnerId }>
  | Readonly<{ kind: "runnerMessage"; runnerId: RunnerId; message: RunnerToHostMessage }>
  /** A message that failed validation; counted, never trusted. */
  | Readonly<{ kind: "runnerMessageRejected"; runnerId: RunnerId; problem: string }>
  | Readonly<{ kind: "pingSent"; runId: TransitionRunId; sequence: number }>
  /** An in-page (built-in or substituted) run finished or failed. */
  | Readonly<{ kind: "inPageRunEnded"; runId: TransitionRunId; failure: string | null }>
  | Readonly<{ kind: "transitionFellBack"; runId: TransitionRunId; reason: TransitionFallbackReason; message: string }>;

/** The RxFeedback implementation, injected (see the header). */
export type RxFeedbackToolkit = Readonly<{
  createSystem: CreateSystem;
  react: CreateReactFeedback;
  reactSet: CreateReactSetFeedback;
}>;

export type PresenterDependencies = Readonly<{
  rxFeedback: RxFeedbackToolkit;
  StaticSlide: StaticSlideComponent;
  renderSlideMarkup: RenderSlideMarkup;
  assetStore: AssetStore;
  /** Font bytes for the runner (it has no network); counted inside the prepare deadline. Empty: system fonts. */
  fontFiles: (faces: readonly FontFaceRequest[]) => Promise<readonly TransferredFont[]>;
  /** The runner page, on a different site than the editor (transition-protocol.ts header). */
  runnerAddress: string;
  scheduler: SchedulerLike;
  now: () => number;
  /** 8 random characters drawn once by the composition root, for run and runner ids. */
  sessionPrefix: string;
  /** Whether the viewer prefers reduced motion (matchMedia in production). */
  prefersReducedMotion: () => boolean;
  /** `document.visibilityState === "visible"`, now and on every change. */
  pageVisibility: Observable<boolean>;
  reportError: (error: unknown, context: string) => void;
}>;

/** src/presenter/index.ts exports `Presentation`, a React component with these properties. */
export type PresentationProperties = Readonly<{
  dependencies: PresenterDependencies;
  /** The latest document; the presenter re-derives its playlist when this changes. */
  document: DocumentSnapshot;
  startSlideId: SlideId;
  /** Opened by the caller's handler; null for no speaker view. */
  speakerWindow: Window | null;
  /**
   * The control bar's "Speaker view" button or the S key asked for the speaker view. Called
   * synchronously INSIDE that click or key handler, so the caller may open a window there (popup
   * blockers refuse it after any asynchronous step); it returns the window, or null when it was
   * refused. The presenter never opens one itself.
   */
  onSpeakerViewRequested: () => Window | null;
  onExit: (lastSlideId: SlideId | null) => void;
}>;

/**
 * src/presenter/index.ts exports `BuildPreview`: every build segment of `slideId` played in turn in a
 * box laid over the editor's canvas (the Animate tab's "Preview"), clicks taken as given, then
 * `onEnded`. Same hosts and rules as a show (a scripted step runs only once approved); under reduced
 * motion the builds appear at once. `generation` restarts it.
 */
export type BuildPreviewProperties = Readonly<{
  dependencies: PresenterDependencies;
  document: DocumentSnapshot;
  slideId: SlideId;
  generation: number;
  /** Width of the preview box in client pixels; the height follows the page. */
  width: number;
  onEnded: () => void;
}>;

/**
 * src/presenter/index.ts exports `TransitionPreview`: the transition INTO `slideId` from the slide
 * before it, played once in a box (the properties panel's "Preview", the script dialog's "Run").
 * Same hosts and rules as a show; `generation` restarts it.
 */
export type TransitionPreviewProperties = Readonly<{
  dependencies: PresenterDependencies;
  document: DocumentSnapshot;
  slideId: SlideId;
  generation: number;
  /** Width of the preview box in client pixels; the height follows the page. */
  width: number;
  onEnded: () => void;
}>;
