// THE PRESENTER'S RxFeedback SYSTEM, assembled: the pure reducer plus one feedback per kind of
// effect, built with the INJECTED toolkit (the state module's implementation in production; the
// presenter never imports it).
//
//   clock        `clockTicked` every 100 milliseconds while a run or a loading runner needs its
//                deadlines watched, every 250 otherwise (controls fading, the speaker view's timer)
//   visibility   `pageVisibility` -> `visibilityChanged`, so deadlines count visible time only
//   sandbox      runner frames, the handshake, prepare, start and pings (sandbox/sandbox-feedback.ts)
//   in-page      built-ins and the substituted fade on the React stage (in-page/in-page-run-feedback.ts)
//   endings      `onExit` once the reducer asks to exit; `onPreviewEnded` once a preview has played
//
// The page-facing pieces arrive as a `PresenterEnvironment`, so the whole system runs in a test on
// a virtual clock with a fake runner and no browser.

import { distinctUntilChanged, ignoreElements, map, tap, timer } from "rxjs";
import { assertNever } from "../contracts/assert-never.ts";
import type { SlideId } from "../contracts/ids.ts";
import type { PresenterDependencies, PresenterEvent } from "../contracts/presenter.ts";
import type { Feedback, RunningSystem } from "../contracts/rxfeedback.ts";
import { inPageRunFeedback, type InPageStageRegistry } from "./in-page/in-page-run-feedback.ts";
import { reducePresenter } from "./presenter-reducer.ts";
import { currentSlideOf, type PresenterSystemState } from "./presenter-state.ts";
import { sandboxFeedback } from "./sandbox/sandbox-feedback.ts";
import type { SandboxEnvironment } from "./sandbox/sandbox-environment.ts";
import type { AnimateNode, StartTimer } from "./transition-context.ts";

export type PresenterEnvironment = Readonly<{
  sandbox: SandboxEnvironment;
  stages: InPageStageRegistry;
  animateNode: AnimateNode;
  /** High resolution clock for a transition's remaining time (`performance.now`). */
  animationClock: () => number;
  startTimer: StartTimer;
  onExit: (lastSlideId: SlideId | null) => void;
  onPreviewEnded: () => void;
}>;

export const FAST_TICK_MILLISECONDS = 100;
export const SLOW_TICK_MILLISECONDS = 250;

export function createPresenterSystem(
  options: Readonly<{ dependencies: PresenterDependencies; environment: PresenterEnvironment; initial: PresenterSystemState }>,
): RunningSystem<PresenterSystemState, PresenterEvent> {
  const dependencies = options.dependencies;
  const environment = options.environment;
  const toolkit = dependencies.rxFeedback;
  return toolkit.createSystem<PresenterSystemState, PresenterEvent>({
    initial: options.initial,
    reduce: reducePresenter,
    feedbacks: [
      clockFeedback(dependencies),
      visibilityFeedback(dependencies),
      sandboxFeedback({ dependencies, environment: environment.sandbox }),
      inPageRunFeedback({
        rxFeedback: toolkit,
        stages: environment.stages,
        animateNode: environment.animateNode,
        now: environment.animationClock,
        startTimer: environment.startTimer,
      }),
      endingFeedback({ dependencies, environment }),
    ],
    onReducerError: (error, event) => dependencies.reportError(error, `presenter reducer, event ${event.kind}`),
    onFeedbackError: (error, feedbackIndex) => dependencies.reportError(error, `presenter feedback ${feedbackIndex} stopped`),
    eventLogCapacity: 200,
    now: dependencies.now,
  });
}

/** How often the clock ticks for this state; null: no ticks needed. */
export function tickPeriodOf(state: PresenterSystemState): number | null {
  if (state.exitRequested || state.previewEnded) return null;
  const watchingDeadlines = state.run !== null || state.spareRunner.kind === "loading";
  return watchingDeadlines ? FAST_TICK_MILLISECONDS : SLOW_TICK_MILLISECONDS;
}

function clockFeedback(dependencies: PresenterDependencies): Feedback<PresenterSystemState, PresenterEvent> {
  return dependencies.rxFeedback.react<PresenterSystemState, number, PresenterEvent>({
    query: tickPeriodOf,
    areEqual: (previous, next) => previous === next,
    // A tick at once when the period changes, so a run started between slow ticks does not start
    // its deadline from a stale `now`; deadlines are then accurate to one fast tick.
    effects: (period) => timer(0, period, dependencies.scheduler).pipe(map((): PresenterEvent => ({ kind: "clockTicked", now: dependencies.now() }))),
  });
}

function visibilityFeedback(dependencies: PresenterDependencies): Feedback<PresenterSystemState, PresenterEvent> {
  return () => dependencies.pageVisibility.pipe(distinctUntilChanged(), map((visible): PresenterEvent => ({ kind: "visibilityChanged", visible })));
}

type Ending = Readonly<{ kind: "exit"; lastSlideId: SlideId }> | Readonly<{ kind: "previewEnded" }>;

function endingFeedback(options: Readonly<{ dependencies: PresenterDependencies; environment: PresenterEnvironment }>): Feedback<PresenterSystemState, PresenterEvent> {
  return options.dependencies.rxFeedback.react<PresenterSystemState, Ending, PresenterEvent>({
    query: (state) => (state.exitRequested ? { kind: "exit", lastSlideId: currentSlideOf(state) } : state.previewEnded ? { kind: "previewEnded" } : null),
    areEqual: (previous, next) => previous.kind === next.kind,
    // Called after the drain that asked for it, so a caller that unmounts the presentation in
    // response never disposes the system from inside its own reduce.
    effects: (ending) => timer(0, options.dependencies.scheduler).pipe(tap(() => announce({ ending, environment: options.environment })), ignoreElements()),
  });
}

function announce(options: Readonly<{ ending: Ending; environment: PresenterEnvironment }>): void {
  switch (options.ending.kind) {
    case "exit":
      options.environment.onExit(options.ending.lastSlideId);
      return;
    case "previewEnded":
      options.environment.onPreviewEnded();
      return;
    default:
      assertNever(options.ending);
  }
}
