// The Animate tab as a person meets it: what each row of the sequence says, which effect a changed
// kind becomes, where a drag or Alt+Arrow puts a step, the badges on the canvas, and the tab's
// markup -- the picker, the list, the chosen step's fields, the scripted step's script controls --
// plus the script dialog's words for a build step, and the demo deck's builds and morph slides
// (accepted by the model, so the demo and the Chrome check can show them). Each table varies one cause and keeps a control
// row where that cause is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { asyncScheduler } from "rxjs";
import { Doc } from "yjs";
import { mintId, parseTransitionScriptId, plainText, scriptFingerprint, type AssetRecord, type AnimationEffect, type AnimationEffectKind, type AnimationStepId, type EditorState, type ElementSnapshot, type TransitionScriptRecord } from "../../contracts/index.ts";
import { animationStep, editorStateFor, group, ME, shape, slide, slideId, testDocument, textBody } from "../../state/testing/document-fixtures.ts";
import { createDocumentStore } from "../../model/index.ts";
import { EditorGestureContext, EditorServicesContext } from "../application/editor-services.tsx";
import { AnimationBadgeLayer, animateTabShowing } from "../canvas/build-overlays.tsx";
import { sampleSlides } from "../sample/sample-deck.ts";
import { fixtureAssetId, fixtureDeckId } from "../sample/snapshot-builders.ts";
import { createRecordingSystem, fixtureServices, recordingCapabilities } from "../testing/editor-fixtures.ts";
import { ADD_ANIMATION_LABEL, AnimateTab, NEWER_VERSION_EXPLANATION, NO_ANIMATIONS_YET, SELECT_TO_ANIMATE, UNAPPROVED_SCRIPT_NOTE, rowKeyIntent, scriptApproved } from "./animate-tab.tsx";
import { ELEMENT_REMOVED_LABEL, NEWER_VERSION_LABEL, animationBadges, animationRows, dropMoveFor, effectWithKind, elementLabel, stepMoveFor } from "./animate-values.ts";
import { DialogLayer } from "./dialogs.tsx";
import { PROPERTIES_TABS } from "./properties-panel.tsx";

const SLIDE = slideId("slide_builds");
const named: ElementSnapshot = { ...shape({ id: "shape_named", x: 100, y: 100, width: 200, height: 100 }), name: "Logo" };
const titled = shape({ id: "shape_titled", x: 100, y: 300, width: 600, height: 100, text: textBody("Quarterly review of the whole year so far") });
const left = shape({ id: "shape_left", x: 800, y: 300, width: 100, height: 100 });
const right = shape({ id: "shape_right", x: 950, y: 300, width: 100, height: 100 });
const pair = group({ id: "group_pair", children: [left, right] });
const ghost = shape({ id: "shape_ghost", x: 0, y: 0, width: 1, height: 1 });

const fadeTitle = animationStep({ id: "an_fade", elementId: titled.id });
const flyLogo = animationStep({ id: "an_fly", elementId: named.id, effect: { kind: "flyIn", from: "top" }, trigger: "withPrevious" });
const spinTitle = animationStep({ id: "an_spin", elementId: titled.id, effect: { kind: "spin", degrees: 720 }, trigger: "afterPrevious" });
const groupStep = animationStep({ id: "an_group", elementId: pair.id, effect: { kind: "zoomOut" } });
const gone = animationStep({ id: "an_gone", elementId: ghost.id });
const newer = { ...animationStep({ id: "an_newer", elementId: named.id }), unsupportedKeys: ["bounce"] };

const sparkle: TransitionScriptRecord = {
  id: scriptIdOf("ts_sparkle"),
  name: "Sparkle",
  description: "",
  purpose: "animation",
  author: { kind: "agent", name: "Claude", agentSessionId: "agent_session" },
  script: "sashaTransition.define({ name: 'Sparkle', run() {} });",
  stylesheet: "",
  markup: "",
  defaultParameters: {},
  approval: { kind: "unapproved" },
  updatedAt: 1,
};
const inkWipe: TransitionScriptRecord = { ...sparkle, id: scriptIdOf("ts_ink"), name: "Ink wipe", purpose: "transition" };
const scriptedStep = animationStep({ id: "an_scripted", elementId: named.id, effect: { kind: "scripted", scriptId: sparkle.id, category: "entrance", parameters: {} } });

const buildsSlide = slide({ id: "slide_builds", elements: [named, titled, pair], animations: [fadeTitle, flyLogo, spinTitle, groupStep, gone, newer] });

describe("the sequence's rows", () => {
  const rows = animationRows({ slide: buildsSlide, scripts: [] });
  const expected: readonly Readonly<{ name: string; number: number; element: string; effect: string; trigger: string; status: string }>[] = [
    { name: "an unnamed shape: its kind and the start of its text", number: 1, element: 'Shape "Quarterly review of the who…"', effect: "Fade in", trigger: "On click", status: "playable" },
    { name: "a named element: its name; the edge is in the effect", number: 2, element: "Logo", effect: "Fly in from the top", trigger: "With previous", status: "playable" },
    { name: "a second step on the same element", number: 3, element: 'Shape "Quarterly review of the who…"', effect: "Spin 720 degrees", trigger: "After previous", status: "playable" },
    { name: "a step on a group names the group", number: 4, element: "Group", effect: "Zoom out", trigger: "On click", status: "playable" },
    { name: "a step whose element is gone", number: 5, element: ELEMENT_REMOVED_LABEL, effect: "Fade in", trigger: "On click", status: "elementRemoved" },
    { name: "a step made with a newer version", number: 6, element: "Logo", effect: "Fade in", trigger: "On click", status: "newerVersion" },
  ];
  expected.forEach((row, index) => {
    it(row.name, () => {
      const actual = rows[index];
      assert.ok(actual !== undefined);
      assert.deepEqual({ number: actual.number, element: actual.elementLabel, effect: actual.effectLabel, trigger: actual.triggerLabel, status: actual.status }, { number: row.number, element: row.element, effect: row.effect, trigger: row.trigger, status: row.status });
    });
  });

  it("control: an element with neither name nor text is its kind alone", () => {
    assert.equal(elementLabel(left), "Shape");
  });
});

describe("changing a step's effect keeps what still applies", () => {
  const rows: readonly Readonly<{ name: string; kind: AnimationEffectKind; previous: AnimationEffect; scripts: readonly TransitionScriptRecord[]; expected: AnimationEffect | null }>[] = [
    { name: "fly in from the top becomes fly out to the top", kind: "flyOut", previous: { kind: "flyIn", from: "top" }, scripts: [], expected: { kind: "flyOut", to: "top" } },
    { name: "fly out to the bottom becomes a wipe from the bottom", kind: "wipe", previous: { kind: "flyOut", to: "bottom" }, scripts: [], expected: { kind: "wipe", from: "bottom" } },
    { name: "a spin becomes a scripted emphasis on the deck's build script", kind: "scripted", previous: { kind: "spin", degrees: 90 }, scripts: [sparkle], expected: { kind: "scripted", scriptId: sparkle.id, category: "emphasis", parameters: {} } },
    { name: "a motion path becomes a scripted emphasis (a script rests like an emphasis)", kind: "scripted", previous: { kind: "motionPath", offsetX: 10, offsetY: 0 }, scripts: [sparkle], expected: { kind: "scripted", scriptId: sparkle.id, category: "emphasis", parameters: {} } },
    { name: "scripted without a build script cannot exist yet", kind: "scripted", previous: { kind: "fadeIn" }, scripts: [], expected: null },
    { name: "the same kind keeps its options", kind: "spin", previous: { kind: "spin", degrees: 90 }, scripts: [], expected: { kind: "spin", degrees: 90 } },
    { name: "control: a fade becomes a zoom with the zoom's defaults", kind: "zoomIn", previous: { kind: "fadeIn" }, scripts: [], expected: { kind: "zoomIn" } },
    { name: "control: fly in with no previous edge starts from the left", kind: "flyIn", previous: { kind: "fadeIn" }, scripts: [], expected: { kind: "flyIn", from: "left" } },
  ];
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(effectWithKind({ kind: row.kind, previous: row.previous, scripts: row.scripts }), row.expected);
    });
  }
});

describe("reordering", () => {
  const order: readonly AnimationStepId[] = [fadeTitle.id, flyLogo.id, spinTitle.id];
  const keyRows: readonly Readonly<{ name: string; stepId: AnimationStepId; direction: "up" | "down"; expected: Readonly<{ after: AnimationStepId | null }> | null }>[] = [
    { name: "the second up goes first", stepId: flyLogo.id, direction: "up", expected: { after: null } },
    { name: "the third up goes after the first", stepId: spinTitle.id, direction: "up", expected: { after: fadeTitle.id } },
    { name: "the first down goes after the second", stepId: fadeTitle.id, direction: "down", expected: { after: flyLogo.id } },
    { name: "control: the first cannot go up", stepId: fadeTitle.id, direction: "up", expected: null },
    { name: "control: the last cannot go down", stepId: spinTitle.id, direction: "down", expected: null },
  ];
  for (const row of keyRows) {
    it(`keys: ${row.name}`, () => assert.deepEqual(stepMoveFor({ order, stepId: row.stepId, direction: row.direction }), row.expected));
  }
  const dropRows: readonly Readonly<{ name: string; stepId: AnimationStepId; targetId: AnimationStepId; expected: Readonly<{ after: AnimationStepId | null }> | null }>[] = [
    { name: "the first dropped on the third lands after it", stepId: fadeTitle.id, targetId: spinTitle.id, expected: { after: spinTitle.id } },
    { name: "the third dropped on the first lands before it", stepId: spinTitle.id, targetId: fadeTitle.id, expected: { after: null } },
    { name: "the third dropped on the second lands between the first and the second", stepId: spinTitle.id, targetId: flyLogo.id, expected: { after: fadeTitle.id } },
    { name: "control: dropped on itself stays", stepId: flyLogo.id, targetId: flyLogo.id, expected: null },
  ];
  for (const row of dropRows) {
    it(`drag: ${row.name}`, () => assert.deepEqual(dropMoveFor({ order, stepId: row.stepId, targetId: row.targetId }), row.expected));
  }
  const intentRows = [
    { key: "ArrowUp", alt: true, expected: "moveUp" },
    { key: "ArrowDown", alt: true, expected: "moveDown" },
    { key: "ArrowUp", alt: false, expected: "choosePrevious" },
    { key: "ArrowDown", alt: false, expected: "chooseNext" },
    { key: "Delete", alt: false, expected: "remove" },
    { key: "a", alt: false, expected: null },
    { key: "ArrowLeft", alt: true, expected: null },
  ] as const;
  for (const row of intentRows) {
    it(`a focused row: ${row.alt ? "Alt+" : ""}${row.key} is ${row.expected ?? "left to the shell"}`, () => assert.equal(rowKeyIntent({ key: row.key, alt: row.alt }), row.expected));
  }
});

describe("badges on the canvas", () => {
  it("each animated element shows every position it holds; a gone element shows none", () => {
    assert.deepEqual([...animationBadges(buildsSlide)], [
      [titled.id, "1, 3"],
      [named.id, "2, 6"],
      [pair.id, "4"],
    ]);
  });

  it("the layer draws one badge per element at its top-left corner, scaled", () => {
    const markup = renderToStaticMarkup(createElement(AnimationBadgeLayer, { slide: buildsSlide, scale: 0.5 }));
    assert.match(markup, new RegExp(`aria-label="Animation 1, 3"[^>]*data-badge-element="${titled.id}"[^>]*style="left:50px;top:150px"`));
    assert.equal([...markup.matchAll(/data-badge-element=/g)].length, 3);
  });

  const showingRows = [
    { name: "the Animate tab in an open panel", tab: "animate", panel: true, comments: false, shows: true },
    { name: "control: another tab", tab: "transition", panel: true, comments: false, shows: false },
    { name: "control: the panel closed", tab: "animate", panel: false, comments: false, shows: false },
    { name: "control: the comment rail replaces the panel", tab: "animate", panel: true, comments: true, shows: false },
  ] as const;
  for (const row of showingRows) {
    it(`badges show for ${row.name}: ${row.shows}`, () => assert.equal(animateTabShowing({ propertiesTab: row.tab, propertiesPanelOpen: row.panel, commentsOpen: row.comments }), row.shows));
  }
});

describe("the Animate tab", () => {
  it("is listed with the other properties tabs", () => {
    assert.deepEqual(PROPERTIES_TABS.at(-1), { tab: "animate", label: "Animate" });
  });

  const document = { ...testDocument({ slides: [buildsSlide] }), transitionScripts: [inkWipe] };
  const base = (overrides: Partial<EditorState["chrome"]> = {}, selection: EditorState["selection"] = { kind: "none" }, scripts: readonly TransitionScriptRecord[] = [inkWipe]): EditorState => {
    const state = editorStateFor({ ...document, transitionScripts: scripts });
    return { ...state, currentSlideId: SLIDE, selection, chrome: { ...state.chrome, propertiesTab: "animate", ...overrides } };
  };

  const pickerRows = [
    { name: "nothing selected: the picker is disabled and says why", selection: { kind: "none" }, enabled: false },
    { name: "control: an element selected: the picker is enabled", selection: { kind: "elements", slideId: SLIDE, elementIds: [named.id] }, enabled: true },
  ] as const;
  for (const row of pickerRows) {
    it(row.name, () => {
      const markup = renderTab(base({}, row.selection));
      const select = markup.match(new RegExp(`<select[^>]*aria-label="${ADD_ANIMATION_LABEL}"[^>]*>`))?.[0] ?? "";
      assert.notEqual(select, "");
      assert.equal(select.includes("disabled"), !row.enabled);
      assert.equal(markup.includes(SELECT_TO_ANIMATE), !row.enabled);
      for (const group of ["Entrance", "Emphasis", "Exit", "Motion"]) assert.match(markup, new RegExp(`<optgroup label="${group}">`));
    });
  }

  const scriptedOptionRows = [
    { name: "a deck with a build step script offers Scripted", scripts: [inkWipe, sparkle], offered: true },
    { name: "control: a deck with only a transition script does not", scripts: [inkWipe], offered: false },
  ] as const;
  for (const row of scriptedOptionRows) {
    it(row.name, () => assert.equal(renderTab(base({}, { kind: "none" }, row.scripts)).includes('<option value="scripted">'), row.offered));
  }

  it("lists the sequence in order with the chosen row selected and the gone and newer rows explained", () => {
    const markup = renderTab(base({ selectedAnimationStepId: flyLogo.id }));
    assert.match(markup, /role="listbox" aria-label="Animation sequence"/);
    const options = [...markup.matchAll(/<li role="option"[^>]*aria-selected="(true|false)"[^>]*aria-label="([^"]+)"/g)].map((match) => ({ selected: match[1] === "true", label: match[2] }));
    assert.equal(options.length, 6);
    assert.deepEqual(options.map((option) => option.selected), [false, true, false, false, false, false]);
    assert.equal(options[1]?.label, "2. Logo, Fly in from the top, With previous");
    assert.match(options[4]?.label ?? "", new RegExp(`, ${ELEMENT_REMOVED_LABEL}$`));
    assert.match(options[5]?.label ?? "", new RegExp(`, ${NEWER_VERSION_LABEL}$`));
    assert.match(markup, /aria-label="Move animation 2 up"/);
    assert.match(markup, /aria-label="Move animation 2 down"/);
  });

  it("control: an empty sequence says so, with Preview disabled", () => {
    const empty = editorStateFor(testDocument({ slides: [slide({ id: "slide_builds", elements: [named] })] }));
    const markup = renderTab({ ...empty, currentSlideId: SLIDE, chrome: { ...empty.chrome, propertiesTab: "animate" } });
    assert.ok(markup.includes(NO_ANIMATIONS_YET));
    assert.match(markup, /<button type="button" class="[^"]*" disabled="">.*Preview<\/button>/);
  });

  const fieldRows: readonly Readonly<{ name: string; chosen: AnimationStepId; labels: readonly string[]; absent: readonly string[] }>[] = [
    { name: "a fly in: timing, easing and the edge it comes from", chosen: flyLogo.id, labels: ["Effect", "Start", "Duration", "Delay", "Easing", "From"], absent: ["Turn", "Script"] },
    { name: "a spin: the turn in degrees", chosen: spinTitle.id, labels: ["Effect", "Turn"], absent: ["From", "Script"] },
    { name: "control: a zoom out has no options of its own", chosen: groupStep.id, labels: ["Effect", "Start"], absent: ["From", "Turn", "Scale", "Script"] },
  ];
  for (const row of fieldRows) {
    it(`the chosen step's fields for ${row.name}`, () => {
      const markup = renderTab(base({ selectedAnimationStepId: row.chosen }));
      for (const label of row.labels) assert.match(markup, new RegExp(`aria-label="${label}"`), label);
      for (const label of row.absent) assert.doesNotMatch(markup, new RegExp(`aria-label="${label}"`), label);
      assert.match(markup, /aria-label="Remove animation \d+"/);
    });
  }

  it("a step made with a newer version is read-only and says why", () => {
    const markup = renderTab(base({ selectedAnimationStepId: newer.id }));
    assert.ok(markup.includes(NEWER_VERSION_EXPLANATION));
    assert.match(markup, /<select[^>]*disabled=""[^>]*aria-label="Effect"/);
  });

  const approvedSparkle: TransitionScriptRecord = { ...sparkle, approval: { kind: "approved", approvedBy: ME.id, fingerprint: scriptFingerprint(sparkle) } };
  const scriptRows = [
    { name: "an unapproved build script: the note says the element appears without animation", script: sparkle, note: true },
    { name: "control: an approved build script: no note", script: approvedSparkle, note: false },
  ] as const;
  for (const row of scriptRows) {
    it(`a scripted step with ${row.name}`, () => {
      const withScript = editorStateFor({ ...testDocument({ slides: [slide({ id: "slide_builds", elements: [named], animations: [scriptedStep] })] }), transitionScripts: [inkWipe, row.script] });
      const state: EditorState = { ...withScript, currentSlideId: SLIDE, chrome: { ...withScript.chrome, propertiesTab: "animate", selectedAnimationStepId: scriptedStep.id } };
      const markup = renderTab(state);
      assert.equal(scriptApproved(row.script), !row.note);
      assert.equal(markup.includes(UNAPPROVED_SCRIPT_NOTE), row.note);
      const scriptOptions = markup.match(/<select[^>]*aria-label="Script"[^>]*>(.*?)<\/select>/)?.[1] ?? "";
      assert.ok(scriptOptions.includes("Sparkle") && !scriptOptions.includes("Ink wipe"), "only build step scripts are offered");
      assert.match(markup, /aria-label="Category"/);
      assert.match(markup, />Edit script<\/button>/);
      assert.match(markup, />New script<\/button>/);
    });
  }

  it("every control has an accessible name", () => {
    const markup = renderTab(base({ selectedAnimationStepId: flyLogo.id }, { kind: "elements", slideId: SLIDE, elementIds: [named.id] }));
    const unnamedButtons = [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].filter((match) => !/aria-label="[^"]+"/.test(match[1] ?? "") && (match[2] ?? "").replace(/<[^>]+>/g, "").trim().length === 0);
    assert.deepEqual(unnamedButtons.map((match) => match[0]), []);
    const unnamedFields = [...markup.matchAll(/<(select|input)([^>]*)>/g)].filter((match) => !/aria-label="[^"]+"/.test(match[2] ?? ""));
    assert.deepEqual(unnamedFields.map((match) => match[0]), []);
  });
});

describe("the script dialog for a build step", () => {
  const rows = [
    { name: "a new build step script is called one", purpose: "animation", title: "New build step script" },
    { name: "control: a new transition script", purpose: "transition", title: "New transition script" },
  ] as const;
  for (const row of rows) {
    it(row.name, () => {
      const state = editorStateFor(testDocument({ slides: [buildsSlide] }));
      const draft = { id: sparkle.id, name: "Draft", description: "", purpose: row.purpose, script: "", stylesheet: "", markup: "", defaultParameters: {} };
      const opened: EditorState = { ...state, chrome: { ...state.chrome, dialog: { kind: "transitionScriptEditor", editor: { draft, basedOnUpdatedAt: null, conflict: false, previewGeneration: 0 } } } };
      const markup = withServices(opened, createElement(DialogLayer));
      assert.ok(markup.includes(row.title), row.title);
    });
  }
});

describe("the sample deck's builds and morph slides", () => {
  const photo: AssetRecord = { id: fixtureAssetId("photo"), mediaType: "image/svg+xml", pixelWidth: 440, pixelHeight: 360, name: "Sample photograph", byteLength: 10 };
  const slides = sampleSlides({ deckId: fixtureDeckId("deck_sample"), imageAssetId: photo.id, extraSlideCount: 2 });
  const builds = slides.find((candidate) => candidate.animations.length > 0);
  const morphing = slides.findIndex((candidate) => candidate.transition?.kind === "builtin" && candidate.transition.effect.effect === "morph");

  it("a builds slide: the title fades in, a shape flies in from the left and spins, another flies out", () => {
    assert.ok(builds !== undefined);
    const effects: readonly AnimationEffect[] = [{ kind: "fadeIn" }, { kind: "flyIn", from: "left" }, { kind: "spin", degrees: 360 }, { kind: "flyOut", to: "right" }];
    assert.deepEqual(builds.animations.map((step) => step.effect), effects);
    assert.deepEqual(builds.animations.map((step) => step.trigger), ["onClick", "onClick", "afterPrevious", "onClick"]);
  });

  it("a pair of slides that morph: same morph keys, every frame, colour and corner radius different, and a text change", () => {
    const before = slides[morphing - 1];
    const after = slides[morphing];
    assert.ok(before !== undefined && after !== undefined);
    const keyed = (elements: readonly ElementSnapshot[]) => new Map(elements.map((element) => [element.morphKey, element]));
    const first = keyed(before.elements);
    const second = keyed(after.elements);
    assert.deepEqual([...first.keys()].sort(), [...second.keys()].sort());
    const card = [first.get("morph_card"), second.get("morph_card")];
    assert.ok(card.every((element) => element?.kind === "shape"));
    assert.notDeepEqual(card[0]?.frame, card[1]?.frame);
    assert.notEqual(card[0]?.frame.rotation, card[1]?.frame.rotation);
    const caption = [first.get("morph_caption"), second.get("morph_caption")].map((element) => (element?.kind === "shape" ? plainText({ body: element.text, slideNumber: null }) : ""));
    assert.notEqual(caption[0], caption[1]);
  });

  it("the model accepts the sample slides, builds included", () => {
    const store = createDocumentStore({ sharedDocument: new Doc(), seed: { kind: "blankDeck", deckId: "deck_sample" }, now: () => 1, random: () => 0.5, scheduler: asyncScheduler, repairPolicy: "reportOnly", typingMergeWindowMilliseconds: 500 });
    const outcome = store.apply({
      commandId: mintId({ seed: { sessionPrefix: "Sample00", counter: 0 }, kind: "command" }).id,
      author: { kind: "person", personId: ME.id },
      commands: [
        { kind: "registerAsset", asset: photo },
        { kind: "insertSlides", slides, after: null },
      ],
      selectionBefore: { kind: "none" },
      selectionAfter: { kind: "none" },
      mergeWithPrevious: false,
    });
    assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    assert.deepEqual(store.snapshot().slides.find((candidate) => candidate.id === builds?.id)?.animations.length, 4);
  });
});

function renderTab(state: EditorState): string {
  return withServices(state, createElement(AnimateTab, { state, dispatch: () => undefined }));
}

function withServices(state: EditorState, child: ReactElement): string {
  const system = createRecordingSystem({ initial: state });
  const services = fixtureServices({ system });
  const gesture = { system, browser: recordingCapabilities([]), clipboardContentFor: services.clipboardContentFor, presentationHost: () => null, speakerWindow: { current: null }, assetAddress: services.assetAddress };
  return renderToStaticMarkup(createElement(EditorServicesContext.Provider, { value: services }, createElement(EditorGestureContext.Provider, { value: gesture }, child)));
}

function scriptIdOf(text: string): TransitionScriptRecord["id"] {
  const parsed = parseTransitionScriptId(text);
  if (parsed === null) throw new Error(`Not a script id: ${text}`);
  return parsed;
}
