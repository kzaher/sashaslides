// THE WHOLE PRESENTER SYSTEM ON A VIRTUAL CLOCK, for lifecycle tests: the real reducer and
// feedbacks, the stand-in RxFeedback toolkit, a fake runner site, a fake asset store and a
// fake renderer. A test describes the deck and the runner's behaviour, presses keys, moves time,
// and reads the state.

import { BehaviorSubject, NEVER } from "rxjs";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { AssetRecord } from "../../contracts/document.ts";
import type { KeyChord } from "../../contracts/editor-events.ts";
import type { AssetId, SlideId } from "../../contracts/ids.ts";
import type { PresenterDependencies, PresenterEvent } from "../../contracts/presenter.ts";
import type { FontFaceRequest, RenderSlideMarkup, StaticSlideComponent } from "../../contracts/render.ts";
import type { RunningSystem } from "../../contracts/rxfeedback.ts";
import type { TransferredFont } from "../../contracts/transition-protocol.ts";
import { createInPageStageRegistry } from "../in-page/in-page-run-feedback.ts";
import { initialShowState, type PresenterSystemState } from "../presenter-state.ts";
import { createPresenterSystem } from "../presenter-system.ts";
import { stageElementRecordsOf } from "../stage-elements.ts";
import { fixtureDocument, slideIdOf, type FixtureScript, type FixtureSlide } from "./document-fixture.ts";
import { COOPERATIVE_RUNNER, FakeRunnerSite, type FakeRunnerBehaviour } from "./fake-runner-site.ts";
import { testRxFeedbackToolkit } from "./rxfeedback-toolkit.ts";
import { VirtualTimeScheduler } from "./virtual-time-scheduler.ts";

export type PresenterHarness = Readonly<{
  scheduler: VirtualTimeScheduler;
  system: RunningSystem<PresenterSystemState, PresenterEvent>;
  site: FakeRunnerSite;
  visibility: BehaviorSubject<boolean>;
  exits: (SlideId | null)[];
  /** Everything passed to `reportError`. */
  errors: readonly string[];
  state: () => PresenterSystemState;
  press: (key: string) => void;
  advanceBy: (milliseconds: number) => Promise<void>;
}>;

export function presenterHarness(
  options: Readonly<{
    slides: readonly FixtureSlide[];
    scripts?: readonly FixtureScript[];
    start?: string;
    runner?: Partial<FakeRunnerBehaviour>;
    fontFiles?: PresenterDependencies["fontFiles"];
    renderSlideMarkup?: RenderSlideMarkup;
    assetStore?: AssetStore;
    assets?: readonly AssetRecord[];
    reducedMotion?: boolean;
  }>,
): PresenterHarness {
  const scheduler = new VirtualTimeScheduler(0);
  const visibility = new BehaviorSubject(true);
  const site = new FakeRunnerSite({ scheduler, behaviour: { ...COOPERATIVE_RUNNER, ...options.runner } });
  const exits: (SlideId | null)[] = [];
  const errors: string[] = [];
  const document = { ...fixtureDocument({ slides: options.slides, scripts: options.scripts ?? [] }), assets: options.assets ?? [] };
  const dependencies: PresenterDependencies = {
    rxFeedback: testRxFeedbackToolkit,
    StaticSlide: NO_STATIC_SLIDE,
    renderSlideMarkup: options.renderSlideMarkup ?? fakeRenderSlideMarkup(),
    assetStore: options.assetStore ?? emptyAssetStore(),
    fontFiles: options.fontFiles ?? noFonts,
    runnerAddress: "http://runner.test/index.html",
    scheduler,
    now: () => scheduler.now(),
    sessionPrefix: "Test0000",
    prefersReducedMotion: () => options.reducedMotion ?? false,
    pageVisibility: visibility.asObservable(),
    reportError: (error, context) => {
      errors.push(`${context}: ${String(error)}`);
    },
  };
  const initial = initialShowState({
    document,
    startSlideId: slideIdOf(options.start ?? options.slides[0]?.id ?? "slide_none"),
    idSeed: { sessionPrefix: dependencies.sessionPrefix, counter: 0 },
    now: scheduler.now(),
    reducedMotion: dependencies.prefersReducedMotion(),
  });
  const system = createPresenterSystem({
    dependencies,
    environment: {
      sandbox: site.environment,
      stages: createInPageStageRegistry(),
      animateNode: () => {
        throw new Error("The lifecycle harness renders no in-page stage.");
      },
      animationClock: () => scheduler.now(),
      startTimer: (callback, milliseconds) => {
        const scheduled = scheduler.schedule(callback, milliseconds);
        return () => scheduled.unsubscribe();
      },
      onExit: (lastSlideId) => exits.push(lastSlideId),
      onPreviewEnded: () => undefined,
    },
    initial,
  });
  return {
    scheduler,
    system,
    site,
    visibility,
    exits,
    errors,
    state: () => system.currentState(),
    press: (key) => system.dispatch({ kind: "keyPressed", chord: chordOf(key) }),
    advanceBy: (milliseconds) => scheduler.advanceBy(milliseconds),
  };
}

export function chordOf(key: string): KeyChord {
  return { key, code: key, modifiers: { shift: false, alt: false, primary: false } };
}

/** A renderer that lists the slide's leaves and, when asked, references assets and fonts. */
export function fakeRenderSlideMarkup(
  extras: Readonly<{ assetIds?: readonly AssetId[]; fontFaces?: readonly FontFaceRequest[]; markupBytes?: number }> = {},
): RenderSlideMarkup {
  return ({ slide }) => ({
    markup: `<div class="sasha-slide-root" data-sasha-slide-id="${slide.id}">${"x".repeat(extras.markupBytes ?? 0)}</div>`,
    elements: stageElementRecordsOf(slide),
    assetIds: extras.assetIds ?? [],
    fontFaces: extras.fontFaces ?? [],
  });
}

export function noFonts(): Promise<readonly TransferredFont[]> {
  return Promise.resolve([]);
}

function emptyAssetStore(): AssetStore {
  return {
    put: () => Promise.reject(new Error("not used")),
    addressFor: () => null,
    available: NEVER,
    copyBytesOf: () => Promise.resolve(null),
  };
}

const NO_STATIC_SLIDE: StaticSlideComponent = () => null;
