// The reducer at build positions (contracts/presenter.ts "A SLIDE IS SHOWN AT A BUILD POSITION"):
// Next runs the next segment and only leaves the slide at the end of its sequence; chained segments
// follow by themselves; Previous steps back to a click boundary without animating and arrives on the
// previous slide fully built; reduced motion and unplayable scripted steps show builds at once; jumps
// start at build 0; a document change clamps; a transition out of a built slide draws it fully built;
// the build preview plays every segment. Each table keeps a control row where the cause is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AnimationEffect, AnimationStep, AnimationTrigger } from "../contracts/animations.ts";
import { assertNever } from "../contracts/assert-never.ts";
import type { KeyChord } from "../contracts/editor-events.ts";
import type { PresenterEvent, TransitionRun } from "../contracts/presenter.ts";
import { slideOnSide } from "./builds/run-slides.ts";
import { initialBuildPreviewState, initialPreviewState, reducePresenter } from "./presenter-reducer.ts";
import { initialShowState, type PresenterSystemState } from "./presenter-state.ts";
import {
  animationStep,
  builtinTransition,
  fixtureDocument,
  scriptIdOf,
  scriptedTransition,
  slideIdOf,
  type FixtureElement,
  type FixtureScript,
  type FixtureSlide,
} from "./testing/document-fixture.ts";

const BOXES: readonly FixtureElement[] = ["box_a", "box_b", "box_c"].map((id, index) => ({ id, frame: { x: 100 + index * 300, y: 200, width: 200, height: 200 } }));
const ANIMATION_SCRIPT: FixtureScript = { id: "script_sparkle", script: "sashaTransition.define({ name: 'Sparkle', run() {} });", approved: true, purpose: "animation", defaultParameters: { colour: "gold", size: 3 } };
const SCRIPTED_ENTRANCE: AnimationEffect = { kind: "scripted", scriptId: scriptIdOf("script_sparkle"), category: "entrance", parameters: { size: 5 } };

describe("presenter builds: Next", () => {
  it("runs the next segment as a run on the same slide, then rests at the next position", () => {
    const state = show({ built: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" })] });
    const running = press(state, "ArrowRight");
    assert.deepEqual(runShape(running.run), { from: "slide_b", to: "slide_b", fromBuild: 0, toBuild: 1, kind: "build", host: "inPage" });
    const rested = endRun(running);
    assert.deepEqual(rested.screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 1 });
    assert.equal(rested.run, null);
  });

  it("leaves the slide only at the end of its sequence, the outgoing slide drawn at its final build", () => {
    const state = show({ built: [onClick("box_a", { kind: "fadeIn" })], nextTransition: builtinTransition({ effect: "morph" }) });
    const built = endRun(press(state, "ArrowRight"));
    const leaving = press(built, "ArrowRight");
    assert.deepEqual(runShape(leaving.run), { from: "slide_b", to: "slide_c", fromBuild: 1, toBuild: 0, kind: "builtin", host: "inPage" });
  });

  const drawn = [
    { label: "a morph out of a built slide draws it fully built: the element that entered is there to pair", fromBuild: null, expected: ["box_a", "box_b", "box_c"] },
    { label: "control: the same run drawn from build 0 lacks it", fromBuild: 0, expected: ["box_b", "box_c"] },
  ];
  for (const row of drawn) {
    it(row.label, () => {
      const slides: FixtureSlide[] = [
        { id: "slide_a", elements: BOXES, animations: [onClick("box_a", { kind: "fadeIn" })] },
        { id: "slide_b", elements: BOXES, transition: builtinTransition({ effect: "morph" }) },
      ];
      const built = endRun(press(stateOf({ slides, start: "slide_a" }), "ArrowRight"));
      const run = press(built, "ArrowRight").run;
      assert.ok(run !== null);
      assert.deepEqual(runShape(run), { from: "slide_a", to: "slide_b", fromBuild: 1, toBuild: 0, kind: "builtin", host: "inPage" });
      const drawnRun = row.fromBuild === null ? run : { ...run, fromBuild: row.fromBuild };
      assert.deepEqual(slideOnSide({ run: drawnRun, document: built.document, side: "outgoing" })?.elements.map((element) => element.id), row.expected);
    });
  }

  const chains: readonly Readonly<{ label: string; triggers: readonly AnimationTrigger[]; segments: number; restingAfterFirstClick: number }>[] = [
    { label: "with previous joins the click's segment", triggers: ["onClick", "withPrevious"], segments: 1, restingAfterFirstClick: 1 },
    { label: "after previous joins it too", triggers: ["onClick", "afterPrevious"], segments: 1, restingAfterFirstClick: 1 },
    { label: "control: a second click is its own segment", triggers: ["onClick", "onClick"], segments: 2, restingAfterFirstClick: 1 },
  ];
  for (const row of chains) {
    it(`chains: ${row.label}`, () => {
      const steps = row.triggers.map((trigger, index) => animationStep({ id: `step_${index}`, elementId: BOXES[index]?.id ?? "box_a", effect: { kind: "fadeIn" }, trigger }));
      const state = show({ built: steps });
      const afterClick = endRun(press(state, "ArrowRight"));
      assert.equal(buildOf(afterClick), row.restingAfterFirstClick);
      assert.equal(afterClick.run, null, "resting: nothing plays until the next click");
      const clicksToLeave = row.segments - row.restingAfterFirstClick;
      const atEnd = Array.from({ length: clicksToLeave }).reduce<PresenterSystemState>((current) => endRun(press(current, "ArrowRight")), afterClick);
      assert.equal(buildOf(atEnd), row.segments);
      assert.equal(onScreen(press(atEnd, "ArrowRight")), "slide_c");
    });
  }

  it("a segment that does not wait for a click follows the previous one by itself", () => {
    // The scripted step is a segment of its own; the in-page step after it is a third, chained.
    const state = show({
      built: [onClick("box_a", { kind: "fadeIn" }), chained("box_b", SCRIPTED_ENTRANCE), chained("box_c", { kind: "fadeIn" })],
      scripts: [ANIMATION_SCRIPT],
    });
    const first = press(state, "ArrowRight");
    assert.equal(first.run?.transition.kind, "build");
    const second = endRun(first);
    assert.deepEqual(runShape(second.run), { from: "slide_b", to: "slide_b", fromBuild: 1, toBuild: 2, kind: "scripted", host: "sandbox" });
    const third = endRun(second);
    assert.deepEqual(runShape(third.run), { from: "slide_b", to: "slide_b", fromBuild: 2, toBuild: 3, kind: "build", host: "inPage" });
    assert.equal(buildOf(endRun(third)), 3);
  });

  it("Next during a build run finishes it and the chained segments after it; the following press continues", () => {
    const state = show({
      built: [onClick("box_a", { kind: "fadeIn" }), chained("box_b", SCRIPTED_ENTRANCE), onClick("box_c", { kind: "fadeIn" })],
      scripts: [ANIMATION_SCRIPT],
    });
    const running = press(state, "ArrowRight");
    const finished = press(running, "ArrowRight");
    assert.equal(finished.run, null);
    assert.equal(buildOf(finished), 2, "the chained scripted segment is shown at once");
    assert.deepEqual(runShape(press(finished, "ArrowRight").run), { from: "slide_b", to: "slide_b", fromBuild: 2, toBuild: 3, kind: "build", host: "inPage" });
  });

  const arrivals = [
    { label: "a slide whose first segment does not wait for a click starts it on arrival", trigger: "afterPrevious" as const, expectedRun: true },
    { label: "control: a first segment on click waits", trigger: "onClick" as const, expectedRun: false },
  ];
  for (const row of arrivals) {
    it(row.label, () => {
      const state = show({ built: [animationStep({ id: "step_a", elementId: "box_a", effect: { kind: "fadeIn" }, trigger: row.trigger })], start: "slide_a" });
      const arrived = press(state, "ArrowRight");
      assert.equal(arrived.run !== null, row.expectedRun);
      if (arrived.run !== null) assert.equal(arrived.run.fromBuild, 0);
    });
  }
});

describe("presenter builds: Previous", () => {
  it("steps back to the last click boundary without animating", () => {
    const state = show({ built: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" }), chained("box_c", { kind: "fadeIn" })] });
    const fullyBuilt = endRun(press(endRun(press(state, "ArrowRight")), "ArrowRight"));
    assert.equal(buildOf(fullyBuilt), 2);
    const back = press(fullyBuilt, "ArrowLeft");
    assert.deepEqual(back.screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 1 });
    assert.equal(back.run, null);
    assert.deepEqual(press(back, "ArrowLeft").screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 0 });
  });

  const backwards = [
    { label: "from the first click boundary it goes to the previous slide, which arrives fully built", fromTransition: null, expectedRun: false },
    { label: "the transition back is drawn between the two build states", fromTransition: builtinTransition({ effect: "fade" }), expectedRun: true },
  ];
  for (const row of backwards) {
    it(row.label, () => {
      const slides: FixtureSlide[] = [
        { id: "slide_a", elements: BOXES, animations: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "zoomIn" })] },
        { id: "slide_b", elements: BOXES, transition: row.fromTransition, animations: [onClick("box_c", { kind: "fadeIn" })] },
      ];
      const back = press(stateOf({ slides, start: "slide_b" }), "ArrowLeft");
      if (row.expectedRun) {
        assert.deepEqual(runShape(back.run), { from: "slide_b", to: "slide_a", fromBuild: 0, toBuild: 2, kind: "builtin", host: "inPage" });
        assert.equal(back.run?.direction, "backward");
        assert.equal(buildOf(endRun(back)), 2);
        return;
      }
      assert.deepEqual(back.screen, { kind: "slide", slideId: slideIdOf("slide_a"), build: 2 });
    });
  }

  it("back from the end screen arrives on the last slide fully built", () => {
    const slides: FixtureSlide[] = [{ id: "slide_a" }, { id: "slide_b", elements: BOXES, animations: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" })] }];
    const end = press(stateOf({ slides, start: "slide_a" }), "End");
    assert.deepEqual(end.screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 0 }, "control: a jump arrives at build 0");
    const ended = press(endRun(press(endRun(press(end, "ArrowRight")), "ArrowRight")), "ArrowRight");
    assert.equal(ended.screen.kind, "end");
    assert.deepEqual(press(ended, "ArrowLeft").screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 2 });
  });
});

describe("presenter builds: builds that appear at once", () => {
  it("reduced motion: no run, the slide jumps to the next click boundary", () => {
    const state = show({ built: [onClick("box_a", { kind: "fadeIn" }), chained("box_b", { kind: "flyIn", from: "left" }), chained("box_c", SCRIPTED_ENTRANCE), onClick("box_c", { kind: "spin", degrees: 90 })], scripts: [ANIMATION_SCRIPT], reducedMotion: true });
    const pressed = press(state, "ArrowRight");
    assert.equal(pressed.run, null);
    assert.equal(buildOf(pressed), 2);
    assert.equal(pressed.diagnostics.length, 0, "the viewer's own preference needs no notice");
  });

  const scripts: readonly Readonly<{ label: string; scripts: readonly FixtureScript[]; expected: "scriptNotApproved" | "scriptMissing" | null }>[] = [
    { label: "an unapproved script", scripts: [{ ...ANIMATION_SCRIPT, approved: false }], expected: "scriptNotApproved" },
    { label: "a missing script", scripts: [], expected: "scriptMissing" },
    { label: "a script written as a slide transition", scripts: [{ ...ANIMATION_SCRIPT, purpose: "transition" }], expected: "scriptMissing" },
    { label: "control: an approved animation script runs in the sandbox", scripts: [ANIMATION_SCRIPT], expected: null },
  ];
  for (const row of scripts) {
    it(`a scripted step with ${row.label}`, () => {
      const pressed = press(show({ built: [animationStep({ id: "step_a", elementId: "box_a", effect: SCRIPTED_ENTRANCE, durationMilliseconds: 800, delayMilliseconds: 300 })], scripts: row.scripts }), "ArrowRight");
      if (row.expected === null) {
        const transition = pressed.run?.transition;
        assert.ok(transition !== undefined && transition.kind === "scripted");
        assert.equal(transition.durationMilliseconds, 800, "the step's own duration");
        assert.deepEqual(transition.parameters, { colour: "gold", size: 5, targetElementId: "box_a", category: "entrance" });
        assert.equal(pressed.run?.host.kind, "sandbox");
        return;
      }
      assert.equal(pressed.run, null);
      assert.equal(buildOf(pressed), 1);
      assert.equal(pressed.diagnostics.at(-1)?.kind, "substitution");
      assert.equal(pressed.diagnostics.at(-1)?.reason, row.expected);
    });
  }

  it("a slide transition naming a script written as a build step is treated as missing", () => {
    const slides: FixtureSlide[] = [{ id: "slide_a" }, { id: "slide_b", transition: scriptedTransition("script_sparkle") }];
    const moved = press(stateOf({ slides, start: "slide_a", scripts: [ANIMATION_SCRIPT] }), "ArrowRight");
    assert.deepEqual(moved.run?.transition, { kind: "substitutedFade", reason: "scriptMissing" });
  });

  it("a show with an approved scripted build step warms a spare runner; control: built-in builds do not", () => {
    const scripted = show({ built: [onClick("box_a", SCRIPTED_ENTRANCE)], scripts: [ANIMATION_SCRIPT] });
    const builtIn = show({ built: [onClick("box_a", { kind: "fadeIn" })], scripts: [ANIMATION_SCRIPT] });
    assert.equal(scripted.spareRunner.kind, "loading");
    assert.equal(builtIn.spareRunner.kind, "none");
  });
});

describe("presenter builds: jumps, blanks and document changes", () => {
  const jumps = [
    { label: "a typed number", keys: ["2", "Enter"] },
    { label: "Home, then Next into the slide", keys: ["Home", "ArrowRight"] },
  ];
  for (const row of jumps) {
    it(`${row.label} starts the slide at build 0`, () => {
      const state = show({ built: [onClick("box_a", { kind: "fadeIn" })], start: "slide_c" });
      const jumped = row.keys.reduce((current, key) => endRunIfAny(press(current, key)), state);
      assert.deepEqual(jumped.screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 0 });
    });
  }

  it("blanking keeps the build position and resuming returns to it", () => {
    const built = endRun(press(show({ built: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" })] }), "ArrowRight"));
    const blank = press(built, "b");
    assert.deepEqual(blank.screen, { kind: "blank", colour: "black", resumeSlideId: slideIdOf("slide_b"), resumeBuild: 1 });
    assert.deepEqual(press(blank, "x").screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 1 });
  });

  const changes = [
    { label: "fewer segments clamp the position", remaining: 1, expected: 1 },
    { label: "no segments: build 0", remaining: 0, expected: 0 },
    { label: "control: the same segments keep it", remaining: 3, expected: 2 },
  ];
  for (const row of changes) {
    it(`documentChanged: ${row.label}`, () => {
      const steps = [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" }), onClick("box_c", { kind: "fadeIn" })];
      const built = endRun(press(endRun(press(show({ built: steps }), "ArrowRight")), "ArrowRight"));
      assert.equal(buildOf(built), 2);
      const document = deckDocument({ built: steps.slice(0, row.remaining) });
      assert.equal(buildOf(reducePresenter(built, { kind: "documentChanged", document })), row.expected);
    });
  }
});

describe("presenter builds: previews", () => {
  it("a build preview plays every segment, clicks taken as given, then ends", () => {
    const document = deckDocument({ built: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" })] });
    const preview = initialBuildPreviewState({ document, slideId: slideIdOf("slide_b"), idSeed: SEED, now: 0, reducedMotion: false });
    assert.deepEqual(runShape(preview.run), { from: "slide_b", to: "slide_b", fromBuild: 0, toBuild: 1, kind: "build", host: "inPage" });
    const second = endRun(preview);
    assert.equal(second.run?.fromBuild, 1);
    assert.equal(second.previewEnded, false);
    const ended = endRun(second);
    assert.equal(ended.previewEnded, true);
    assert.equal(buildOf(ended), 2);
    assert.equal(reducePresenter(ended, { kind: "keyPressed", chord: chord("ArrowLeft") }), ended, "navigation is ignored");
  });

  const endsAtOnce = [
    { label: "no segments: ends at once at build 0", built: [] as readonly AnimationStep[], reducedMotion: false, expectedBuild: 0 },
    { label: "reduced motion: the fully built slide, ended", built: [onClick("box_a", { kind: "fadeIn" }), onClick("box_b", { kind: "fadeIn" })], reducedMotion: true, expectedBuild: 2 },
  ];
  for (const row of endsAtOnce) {
    it(`a build preview with ${row.label}`, () => {
      const preview = initialBuildPreviewState({ document: deckDocument({ built: row.built }), slideId: slideIdOf("slide_b"), idSeed: SEED, now: 0, reducedMotion: row.reducedMotion });
      assert.equal(preview.run, null);
      assert.equal(preview.previewEnded, true);
      assert.equal(buildOf(preview), row.expectedBuild);
    });
  }

  it("a transition preview draws the slide before fully built and does not play the target's builds", () => {
    const slides: FixtureSlide[] = [
      { id: "slide_a", elements: BOXES, animations: [onClick("box_a", { kind: "fadeIn" })] },
      { id: "slide_b", elements: BOXES, transition: builtinTransition({ effect: "morph" }), animations: [chained("box_b", { kind: "fadeIn" })] },
    ];
    const preview = initialPreviewState({ document: fixtureDocument({ slides }), slideId: slideIdOf("slide_b"), idSeed: SEED, now: 0, reducedMotion: false });
    assert.deepEqual(runShape(preview.run), { from: "slide_a", to: "slide_b", fromBuild: 1, toBuild: 0, kind: "builtin", host: "inPage" });
    const ended = endRun(preview);
    assert.equal(ended.previewEnded, true);
    assert.equal(ended.run, null);
  });
});

const SEED = { sessionPrefix: "Test0000", counter: 0 };

function onClick(elementId: string, effect: AnimationEffect): AnimationStep {
  return animationStep({ id: `step_${elementId}_${effect.kind}`, elementId, effect });
}

function chained(elementId: string, effect: AnimationEffect): AnimationStep {
  return animationStep({ id: `step_${elementId}_${effect.kind}_after`, elementId, effect, trigger: "afterPrevious" });
}

/** slide_a (plain), slide_b (the builds under test, `nextTransition` into slide_c), slide_c (plain). */
function deckDocument(options: Readonly<{ built: readonly AnimationStep[]; scripts?: readonly FixtureScript[]; nextTransition?: FixtureSlide["transition"] }>) {
  return fixtureDocument({
    slides: [{ id: "slide_a" }, { id: "slide_b", elements: BOXES, animations: options.built }, { id: "slide_c", transition: options.nextTransition ?? null }],
    scripts: options.scripts ?? [],
  });
}

function show(
  options: Readonly<{ built: readonly AnimationStep[]; scripts?: readonly FixtureScript[]; start?: string; reducedMotion?: boolean; nextTransition?: FixtureSlide["transition"] }>,
): PresenterSystemState {
  const document = deckDocument(options);
  const initial = initialShowState({ document, startSlideId: slideIdOf(options.start ?? "slide_b"), idSeed: SEED, now: 0, reducedMotion: options.reducedMotion ?? false });
  // The system normalises after every event; a no-op event applies the same normalisation to the start.
  return reducePresenter(initial, { kind: "visibilityChanged", visible: true } satisfies PresenterEvent);
}

function stateOf(options: Readonly<{ slides: readonly FixtureSlide[]; start: string; scripts?: readonly FixtureScript[] }>): PresenterSystemState {
  const document = fixtureDocument({ slides: options.slides, scripts: options.scripts ?? [] });
  const initial = initialShowState({ document, startSlideId: slideIdOf(options.start), idSeed: SEED, now: 0, reducedMotion: false });
  return reducePresenter(initial, { kind: "visibilityChanged", visible: true });
}

function press(state: PresenterSystemState, key: string): PresenterSystemState {
  return reducePresenter(state, { kind: "keyPressed", chord: chord(key) });
}

function chord(key: string): KeyChord {
  return { key, code: key, modifiers: { shift: false, alt: false, primary: false } };
}

/** The live run ends as its host reports it: in-page ended, or the sandbox's run falls back (a cut to its outcome). */
function endRun(state: PresenterSystemState): PresenterSystemState {
  const run = state.run;
  assert.ok(run !== null, "a run is live");
  switch (run.host.kind) {
    case "inPage":
      return reducePresenter(state, { kind: "inPageRunEnded", runId: run.runId, failure: null });
    case "sandbox":
      return reducePresenter(state, { kind: "transitionFellBack", runId: run.runId, reason: "stalled", message: "ended by the test" });
    default:
      return assertNever(run.host);
  }
}

function endRunIfAny(state: PresenterSystemState): PresenterSystemState {
  return state.run === null ? state : endRun(state);
}

function runShape(run: TransitionRun | null): Readonly<Record<string, unknown>> | null {
  if (run === null) return null;
  return { from: run.fromSlideId, to: run.toSlideId, fromBuild: run.fromBuild, toBuild: run.toBuild, kind: run.transition.kind, host: run.host.kind };
}

function buildOf(state: PresenterSystemState): number | string {
  const screen = state.screen;
  switch (screen.kind) {
    case "slide":
      return screen.build;
    case "transition":
    case "blank":
    case "end":
      return screen.kind;
    default:
      return assertNever(screen);
  }
}

function onScreen(state: PresenterSystemState): string {
  const screen = state.screen;
  switch (screen.kind) {
    case "slide":
      return screen.slideId;
    case "transition":
      return `transition to ${screen.toSlideId}`;
    case "blank":
      return `blank ${screen.colour}`;
    case "end":
      return "end";
    default:
      return assertNever(screen);
  }
}
