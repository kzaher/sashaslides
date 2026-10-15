// THE IN-PAGE HOST: built-ins and the substituted fade run in the presenter's own page with Web
// Animations on two rendered slides -- nothing serialised, no second site, nothing to wait for on
// each Next press (SPEC.md section 11).
//
// The stage is React's: the presentation renders the outgoing slide, the incoming slide and an
// overlay for the live run and registers the four elements under the run's id. This feedback waits
// for that registration, builds the `TransitionContext` (transition-context.ts) and runs the
// definition; when the run leaves state (finished, skipped, cut by a deadline) the subscription is
// dropped and the abort cancels every animation it started.
//
// BOTH SIDES ARE SLIDES AT BUILD POSITIONS (contracts/presenter.ts): the element records a run's
// definition sees come from `slideAtBuild` at the run's `fromBuild` and `toBuild` (builds/run-slides.ts), exactly what the
// stage draws, so a morph out of a built slide pairs the elements the audience last saw. A build
// segment's run plays the build player (builds/build-player.ts) on the same stage.

import { BehaviorSubject, EMPTY, Observable, filter, map, switchMap, take } from "rxjs";
import { assertNever } from "../../contracts/assert-never.ts";
import type { TransitionRunId } from "../../contracts/ids.ts";
import type { PresenterEvent, RxFeedbackToolkit, TransitionRun } from "../../contracts/presenter.ts";
import type { Feedback } from "../../contracts/rxfeedback.ts";
import type { SerialisableObject } from "../../contracts/serialisable.ts";
import { TRANSITION_LIMITS, type TransitionDefinition } from "../../contracts/transition-protocol.ts";
import type { DocumentSnapshot } from "../../contracts/document.ts";
import { BUILTIN_TRANSITIONS, SUBSTITUTED_FADE_PARAMETERS } from "../builtin/builtin-transitions.ts";
import { builtinParameters } from "../builtin/builtin-parameters.ts";
import { createBuildPlayer } from "../builds/build-player.ts";
import { buildSegmentTimeline } from "../builds/build-states.ts";
import { slideOnSide } from "../builds/run-slides.ts";
import { hostRunnerId } from "../presenter-queries.ts";
import { slideById, type PresenterSystemState } from "../presenter-state.ts";
import { stageElementRecordsOf } from "../stage-elements.ts";
import { buildTransitionContext, type AnimateNode, type StartTimer, type TransitionStage } from "../transition-context.ts";

/** Where React registers the stage of the live in-page run. */
export interface InPageStageRegistry {
  /** Emits the stage once it is registered for `runId` (immediately if it already is). */
  stageFor(runId: TransitionRunId): Observable<TransitionStage>;
  register(runId: TransitionRunId, stage: TransitionStage): Disposable;
}

export function createInPageStageRegistry(): InPageStageRegistry {
  const stages = new BehaviorSubject<ReadonlyMap<TransitionRunId, TransitionStage>>(new Map());
  return {
    stageFor(runId) {
      return stages.pipe(
        map((registered) => registered.get(runId)),
        filter((stage): stage is TransitionStage => stage !== undefined),
        take(1),
      );
    },
    register(runId, stage) {
      stages.next(new Map(stages.value).set(runId, stage));
      return {
        [Symbol.dispose]() {
          const remaining = new Map(stages.value);
          if (remaining.get(runId) !== stage) return;
          remaining.delete(runId);
          stages.next(remaining);
        },
      };
    },
  };
}

export function inPageRunFeedback(
  options: Readonly<{
    rxFeedback: RxFeedbackToolkit;
    stages: InPageStageRegistry;
    animateNode: AnimateNode;
    now: () => number;
    startTimer: StartTimer;
  }>,
): Feedback<PresenterSystemState, PresenterEvent> {
  return options.rxFeedback.react<PresenterSystemState, InPageRequest, PresenterEvent>({
    query: (state) => (state.run !== null && hostRunnerId(state.run.host) === null ? { run: state.run, state } : null),
    areEqual: (previous, next) => previous.run.runId === next.run.runId,
    effects: (request) => options.stages.stageFor(request.run.runId).pipe(switchMap((stage) => playInPage({ ...options, request, stage }))),
  });
}

type InPageRequest = Readonly<{ run: TransitionRun; state: PresenterSystemState }>;

/** The definition and parameters an in-page run plays; null for a run that does not belong in-page. */
export function inPagePlayback(
  options: Readonly<{ run: TransitionRun; document: DocumentSnapshot }>,
): Readonly<{ definition: TransitionDefinition; parameters: SerialisableObject; durationMilliseconds: number }> | null {
  const run = options.run;
  const transition = run.transition;
  switch (transition.kind) {
    case "builtin":
      return {
        definition: BUILTIN_TRANSITIONS[transition.effect.effect],
        parameters: builtinParameters({ effect: transition.effect, easing: transition.easing }),
        durationMilliseconds: transition.durationMilliseconds,
      };
    case "substitutedFade":
      return { definition: BUILTIN_TRANSITIONS.fade, parameters: SUBSTITUTED_FADE_PARAMETERS, durationMilliseconds: TRANSITION_LIMITS.substituteFadeMilliseconds };
    case "build": {
      const slide = slideById(options.document, run.toSlideId);
      const definition: TransitionDefinition =
        slide === null
          ? NOTHING_TO_PLAY
          : createBuildPlayer({ timeline: buildSegmentTimeline({ slide, completed: run.fromBuild, segment: transition.segment }), pageSize: options.document.pageSize });
      return { definition, parameters: {}, durationMilliseconds: transition.segment.durationMilliseconds };
    }
    case "scripted":
      return null;
    default:
      return assertNever(transition);
  }
}

/** A build run whose slide was deleted under it: it ends at once (the reducer then finishes it). */
const NOTHING_TO_PLAY: TransitionDefinition = { name: "Nothing", run: () => undefined };

function playInPage(
  options: Readonly<{ request: InPageRequest; stage: TransitionStage; animateNode: AnimateNode; now: () => number; startTimer: StartTimer }>,
): Observable<PresenterEvent> {
  const run = options.request.run;
  const document = options.request.state.document;
  const playback = inPagePlayback({ run, document });
  if (playback === null) return EMPTY;
  const outgoingSlide = slideOnSide({ run, document, side: "outgoing" });
  const incomingSlide = slideOnSide({ run, document, side: "incoming" });
  return new Observable<PresenterEvent>((subscriber) => {
    const controller = new AbortController();
    const context = buildTransitionContext({
      stage: options.stage,
      outgoingElements: outgoingSlide === null ? [] : stageElementRecordsOf(outgoingSlide),
      incomingElements: incomingSlide === null ? [] : stageElementRecordsOf(incomingSlide),
      durationMilliseconds: playback.durationMilliseconds,
      direction: run.direction,
      parameters: playback.parameters,
      reducedMotion: options.request.state.reducedMotion,
      signal: controller.signal,
      animateNode: options.animateNode,
      now: options.now,
      startTimer: options.startTimer,
    });
    Promise.resolve()
      .then(() => playback.definition.run(context))
      .then(
        () => {
          if (!controller.signal.aborted) subscriber.next({ kind: "inPageRunEnded", runId: run.runId, failure: null });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) subscriber.next({ kind: "inPageRunEnded", runId: run.runId, failure: String(error) });
        },
      );
    return () => controller.abort();
  });
}
