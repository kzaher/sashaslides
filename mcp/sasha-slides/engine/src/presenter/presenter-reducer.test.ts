// Acceptance tests 1, 2 and 4 (the reducer): the playlist and document changes mid-show, every key
// of SPEC.md section 10, transitions during navigation, and the host's substituted fade. Each table
// varies the input under test and keeps a control row where it is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertNever } from "../contracts/assert-never.ts";
import type { KeyChord } from "../contracts/editor-events.ts";
import type { PresenterEvent } from "../contracts/presenter.ts";
import { TRANSITION_LIMITS } from "../contracts/transition-protocol.ts";
import { initialShowState, runDurationMilliseconds, type PresenterSystemState } from "./presenter-state.ts";
import { initialPreviewState, reducePresenter } from "./presenter-reducer.ts";
import { builtinTransition, fixtureDocument, scriptedTransition, slideIdOf, type FixtureScript, type FixtureSlide } from "./testing/document-fixture.ts";

describe("presenter reducer: the playlist", () => {
  it("omits skipped slides and next steps over them", () => {
    const state = showState({ slides: [{ id: "slide_a" }, { id: "slide_b", skipped: true }, { id: "slide_c" }], start: "slide_a" });
    assert.deepEqual(state.playlist, [slideIdOf("slide_a"), slideIdOf("slide_c")]);
    assert.equal(onScreen(press(state, "ArrowRight")), "slide_c");
  });

  it("starts on the nearest following slide when the start slide is skipped", () => {
    const state = showState({ slides: [{ id: "slide_a" }, { id: "slide_b", skipped: true }, { id: "slide_c" }], start: "slide_b" });
    assert.equal(onScreen(state), "slide_c");
  });

  const deletions = [
    { deleted: ["slide_b"], expected: "slide_c", label: "the current slide moves to the nearest following one" },
    { deleted: ["slide_b", "slide_c"], expected: "slide_d", label: "several deleted: the first survivor after it" },
    { deleted: ["slide_d"], expected: "slide_b", label: "control: another slide deleted, the current one stays" },
    { deleted: [], expected: "slide_b", label: "control: nothing deleted" },
  ];
  for (const row of deletions) {
    it(`documentChanged deleting ${row.deleted.join(", ") || "nothing"}: ${row.label}`, () => {
      const slides = ["slide_a", "slide_b", "slide_c", "slide_d"].map((id) => ({ id }));
      const state = showState({ slides, start: "slide_b" });
      const document = fixtureDocument({ slides: slides.filter((slide) => !row.deleted.includes(slide.id)), revision: 2 });
      assert.equal(onScreen(reducePresenter(state, { kind: "documentChanged", document })), row.expected);
    });
  }

  it("documentChanged deleting the last slide while on it shows the end screen", () => {
    const state = showState({ slides: [{ id: "slide_a" }, { id: "slide_b" }], start: "slide_b" });
    const changed = reducePresenter(state, { kind: "documentChanged", document: fixtureDocument({ slides: [{ id: "slide_a" }] }) });
    assert.deepEqual(changed.screen, { kind: "end", lastSlideId: slideIdOf("slide_a") });
  });

  const skippedMidShow = [
    { skippedNow: "slide_c", current: "slide_a", expectedPlaylist: ["slide_a", "slide_b", "slide_d"], expectedScreen: "slide_a" },
    { skippedNow: "slide_a", current: "slide_a", expectedPlaylist: ["slide_b", "slide_c", "slide_d"], expectedScreen: "slide_b" },
    { skippedNow: null, current: "slide_a", expectedPlaylist: ["slide_a", "slide_b", "slide_c", "slide_d"], expectedScreen: "slide_a" },
  ];
  for (const row of skippedMidShow) {
    it(`a new skipped flag on ${row.skippedNow ?? "nothing (control)"} mid-show updates the playlist`, () => {
      const ids = ["slide_a", "slide_b", "slide_c", "slide_d"];
      const state = showState({ slides: ids.map((id) => ({ id })), start: row.current });
      const document = fixtureDocument({ slides: ids.map((id) => ({ id, skipped: id === row.skippedNow })), revision: 2 });
      const changed = reducePresenter(state, { kind: "documentChanged", document });
      assert.deepEqual(changed.playlist, row.expectedPlaylist.map(slideIdOf));
      assert.equal(onScreen(changed), row.expectedScreen);
      assert.equal(onScreen(press(changed, "ArrowRight")), row.expectedPlaylist[row.expectedPlaylist.indexOf(row.expectedScreen) + 1]);
    });
  }
});

describe("presenter reducer: navigation keys", () => {
  const fourSlides: readonly FixtureSlide[] = ["slide_a", "slide_b", "slide_c", "slide_d"].map((id) => ({ id }));
  const keyTable = [
    ...["ArrowRight", "ArrowDown", " ", "PageDown", "Enter", "n", "N"].map((key) => ({ keys: [key], expected: "slide_c" })),
    ...["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].map((key) => ({ keys: [key], expected: "slide_a" })),
    { keys: ["Home"], expected: "slide_a" },
    { keys: ["End"], expected: "slide_d" },
    { keys: ["4", "Enter"], expected: "slide_d" },
    { keys: ["1", "Enter"], expected: "slide_a" },
    { keys: ["9", "Enter"], expected: "slide_b" },
    { keys: ["x"], expected: "slide_b" },
    { keys: ["s"], expected: "slide_b" },
  ];
  for (const row of keyTable) {
    it(`${row.keys.map((key) => JSON.stringify(key)).join(" then ")} from the second slide shows ${row.expected}`, () => {
      assert.equal(onScreen(press(showState({ slides: fourSlides, start: "slide_b" }), ...row.keys)), row.expected);
    });
  }

  it("a chord with Ctrl or Alt is not the presenter's", () => {
    const state = showState({ slides: fourSlides, start: "slide_b" });
    for (const modifiers of [{ shift: false, alt: false, primary: true }, { shift: false, alt: true, primary: false }]) {
      assert.equal(onScreen(reducePresenter(state, { kind: "keyPressed", chord: { key: "ArrowRight", code: "ArrowRight", modifiers } })), "slide_b");
    }
  });

  it("Escape requests the exit; control: Enter does not", () => {
    const state = showState({ slides: fourSlides, start: "slide_b" });
    assert.equal(press(state, "Escape").exitRequested, true);
    assert.equal(press(state, "Enter").exitRequested, false);
  });

  const blanks = [
    { key: "b", colour: "black" },
    { key: "B", colour: "black" },
    { key: "W", colour: "white" },
    { key: "w", colour: "white" },
  ] as const;
  for (const row of blanks) {
    it(`${row.key} blanks the screen ${row.colour} and any key resumes on the same slide`, () => {
      const blank = press(showState({ slides: fourSlides, start: "slide_b" }), row.key);
      assert.deepEqual(blank.screen, { kind: "blank", colour: row.colour, resumeSlideId: slideIdOf("slide_b"), resumeBuild: 0 });
      for (const resumeKey of ["x", "ArrowRight", row.key]) assert.deepEqual(press(blank, resumeKey).screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 0 });
    });
  }

  it("clicks: primary is next, secondary is previous", () => {
    const state = showState({ slides: fourSlides, start: "slide_b" });
    assert.equal(onScreen(reducePresenter(state, { kind: "stageClicked", button: "primary" })), "slide_c");
    assert.equal(onScreen(reducePresenter(state, { kind: "stageClicked", button: "secondary" })), "slide_a");
  });

  it("after the last slide the end screen, then next exits and previous returns", () => {
    const end = press(showState({ slides: fourSlides, start: "slide_d" }), "ArrowRight");
    assert.deepEqual(end.screen, { kind: "end", lastSlideId: slideIdOf("slide_d") });
    assert.equal(press(end, "ArrowRight").exitRequested, true);
    assert.equal(onScreen(press(end, "ArrowLeft")), "slide_d");
  });

  it("next during a transition finishes it; the following next navigates", () => {
    const slides: FixtureSlide[] = [{ id: "slide_a" }, { id: "slide_b", transition: builtinTransition({ effect: "fade" }) }, { id: "slide_c" }];
    const inTransition = press(showState({ slides, start: "slide_a" }), "ArrowRight");
    assert.equal(inTransition.screen.kind, "transition");
    assert.notEqual(inTransition.run, null);
    const finished = press(inTransition, "ArrowRight");
    assert.deepEqual(finished.screen, { kind: "slide", slideId: slideIdOf("slide_b"), build: 0 });
    assert.equal(finished.run, null);
    assert.equal(onScreen(press(finished, "ArrowRight")), "slide_c");
  });

  const backward = [
    { from: "slide_c", expectedEffect: "push", expectedDirection: "backward", label: "leaving a slide with a push plays it backward" },
    { from: "slide_d", expectedEffect: null, expectedDirection: null, label: "control: leaving a slide with no transition cuts, though the incoming slide has one" },
  ];
  for (const row of backward) {
    it(`previous: ${row.label}`, () => {
      const slides: FixtureSlide[] = [
        { id: "slide_a" },
        { id: "slide_b" },
        { id: "slide_c", transition: builtinTransition({ effect: "push", direction: "fromRight" }) },
        { id: "slide_d" },
      ];
      const moved = press(showState({ slides, start: row.from }), "ArrowLeft");
      const transition = moved.run?.transition;
      assert.equal(transition?.kind === "builtin" ? transition.effect.effect : null, row.expectedEffect);
      assert.equal(moved.run?.direction ?? null, row.expectedDirection);
    });
  }

  it("going forward plays the incoming slide's transition with direction forward", () => {
    const slides: FixtureSlide[] = [{ id: "slide_a" }, { id: "slide_b", transition: builtinTransition({ effect: "zoom", mode: "in" }) }];
    const run = press(showState({ slides, start: "slide_a" }), "ArrowRight").run;
    assert.equal(run?.direction, "forward");
    assert.deepEqual(run?.host, { kind: "inPage" });
    assert.equal(run?.phase, "running");
  });

  it("controls hide after 2.5 seconds without pointer movement and come back on movement", () => {
    const state = showState({ slides: fourSlides, start: "slide_a" });
    const at2499 = reducePresenter(state, { kind: "clockTicked", now: 2499 });
    const at2500 = reducePresenter(at2499, { kind: "clockTicked", now: 2500 });
    assert.equal(at2499.controlsVisible, true);
    assert.equal(at2500.controlsVisible, false);
    assert.equal(reducePresenter(at2500, { kind: "pointerActivity" }).controlsVisible, true);
  });

  it("a preview ignores navigation", () => {
    const document = fixtureDocument({ slides: [{ id: "slide_a" }, { id: "slide_b", transition: builtinTransition({ effect: "fade" }) }] });
    const preview = initialPreviewState({ document, slideId: slideIdOf("slide_b"), idSeed: SEED, now: 0, reducedMotion: false });
    assert.equal(preview.run?.fromSlideId, slideIdOf("slide_a"));
    assert.equal(reducePresenter(preview, { kind: "keyPressed", chord: chord("ArrowRight") }), preview);
  });
});

describe("presenter reducer: substitutions", () => {
  const approved: FixtureScript = { id: "script_ink", script: "sashaTransition.define({ name: 'x', run() {} });", approved: true };
  const unapproved: FixtureScript = { ...approved, approved: false };
  const rows = [
    { label: "reduced motion replaces an approved script", scripts: [approved], reducedMotion: true, expected: "reducedMotion" },
    { label: "reduced motion replaces a built-in too", scripts: [approved], reducedMotion: true, expected: "reducedMotion", builtin: true },
    { label: "an unapproved script", scripts: [unapproved], reducedMotion: false, expected: "scriptNotApproved" },
    { label: "a missing script", scripts: [], reducedMotion: false, expected: "scriptMissing" },
    { label: "control: an approved script without reduced motion runs in the sandbox", scripts: [approved], reducedMotion: false, expected: null },
  ] as const;
  for (const row of rows) {
    it(row.label, () => {
      const transition = "builtin" in row ? builtinTransition({ effect: "push", direction: "fromRight" }) : scriptedTransition("script_ink");
      const slides: FixtureSlide[] = [{ id: "slide_a" }, { id: "slide_b", transition }];
      const moved = press(showState({ slides, start: "slide_a", scripts: row.scripts, reducedMotion: row.reducedMotion }), "ArrowRight");
      const run = moved.run;
      assert.ok(run !== null);
      if (row.expected === null) {
        assert.equal(run.transition.kind, "scripted");
        assert.equal(run.host.kind, "sandbox");
        assert.equal(moved.diagnostics.length, 0);
        return;
      }
      assert.deepEqual(run.transition, { kind: "substitutedFade", reason: row.expected });
      assert.deepEqual(run.host, { kind: "inPage" });
      assert.equal(runDurationMilliseconds(run, TRANSITION_LIMITS.substituteFadeMilliseconds), 150);
      assert.equal(moved.diagnostics.at(-1)?.kind, "substitution");
      assert.equal(moved.diagnostics.at(-1)?.reason, row.expected);
    });
  }

  it("an approval stops counting once the text changes", () => {
    const document = fixtureDocument({ slides: [{ id: "slide_a" }, { id: "slide_b", transition: scriptedTransition("script_ink") }], scripts: [approved] });
    const record = document.transitionScripts[0];
    assert.ok(record !== undefined);
    const edited = { ...document, transitionScripts: [{ ...record, script: `${record.script}\n// edited` }] };
    const state = initialShowState({ document: edited, startSlideId: slideIdOf("slide_a"), idSeed: SEED, now: 0, reducedMotion: false });
    assert.deepEqual(press(state, "ArrowRight").run?.transition, { kind: "substitutedFade", reason: "scriptNotApproved" });
  });

  it("a show with an approved script warms a spare runner; control: a show of built-ins does not", () => {
    const scripted = showState({ slides: [{ id: "slide_a" }, { id: "slide_b", transition: scriptedTransition("script_ink") }], start: "slide_a", scripts: [approved] });
    const builtins = showState({ slides: [{ id: "slide_a" }, { id: "slide_b", transition: builtinTransition({ effect: "fade" }) }], start: "slide_a" });
    assert.equal(scripted.spareRunner.kind, "loading");
    assert.equal(builtins.spareRunner.kind, "none");
  });
});

const SEED = { sessionPrefix: "Test0000", counter: 0 };

function showState(
  options: Readonly<{ slides: readonly FixtureSlide[]; start: string; scripts?: readonly FixtureScript[]; reducedMotion?: boolean }>,
): PresenterSystemState {
  const document = fixtureDocument({ slides: options.slides, scripts: options.scripts ?? [] });
  const initial = initialShowState({ document, startSlideId: slideIdOf(options.start), idSeed: SEED, now: 0, reducedMotion: options.reducedMotion ?? false });
  // The system normalises after every event; a no-op event applies the same normalisation to the start.
  return reducePresenter(initial, { kind: "visibilityChanged", visible: true } satisfies PresenterEvent);
}

function press(state: PresenterSystemState, ...keys: readonly string[]): PresenterSystemState {
  return keys.reduce((current, key) => reducePresenter(current, { kind: "keyPressed", chord: chord(key) }), state);
}

function chord(key: string): KeyChord {
  return { key, code: key, modifiers: { shift: key.length === 1 && key !== key.toLowerCase(), alt: false, primary: false } };
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
