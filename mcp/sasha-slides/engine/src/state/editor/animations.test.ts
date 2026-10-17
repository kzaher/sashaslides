// The Animate tab's reducer (animations.ts), row by row. Each table varies the one cause it is
// about -- what is selected, which step is chosen, what the store did, which slide is current --
// and keeps a control row where that cause is absent, so a passing row shows the cause made the
// difference. The last tables run through the fake store (fake-stores.ts applies the four step
// commands), and through duplicate and paste, which mint fresh element ids and must carry the
// slide's sequence with them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCAL_COLLABORATION_STATUS,
  DEFAULT_ANIMATION_DURATION_MILLISECONDS,
  parseTransitionScriptId,
  type AnimationStep,
  type AnimationStepId,
  type ClipboardPayload,
  type CommandEnvelope,
  type DocumentCommand,
  type DocumentSnapshot,
  type EditorEvent,
  type EditorState,
  type ElementId,
  type Selection,
  type SlideSnapshot,
  type TransitionScriptRecord,
} from "../../contracts/index.ts";
import { createEditorHarness } from "../testing/editor-harness.ts";
import { requireParsed } from "../../contracts/testing/snapshot-builders.ts";
import { animationStep, editorStateFor, elementId, group, ME, shape, slide, slideId, testDocument } from "../testing/document-fixtures.ts";
import { NOTHING_TO_ANIMATE_MESSAGE } from "./animations.ts";
import { reduceEditor } from "./reduce-editor.ts";
import { NEW_ANIMATION_SCRIPT_TEMPLATE, NEW_SCRIPT_TEMPLATE } from "./transition-scripts.ts";

const SLIDE_ONE = slideId("slide_one");
const SLIDE_TWO = slideId("slide_two");
const title = shape({ id: "shape_title", x: 100, y: 60, width: 800, height: 100 });
const box = shape({ id: "shape_box", x: 100, y: 300, width: 200, height: 200 });
const leftLeaf = shape({ id: "shape_left", x: 500, y: 300, width: 100, height: 100 });
const rightLeaf = shape({ id: "shape_right", x: 650, y: 300, width: 100, height: 100 });
const pair = group({ id: "group_pair", children: [leftLeaf, rightLeaf] });
const other = shape({ id: "shape_other", x: 100, y: 100, width: 100, height: 100 });

const firstStep = animationStep({ id: "an_first", elementId: title.id });
const secondStep = animationStep({ id: "an_second", elementId: box.id, effect: { kind: "flyIn", from: "left" } });
const thirdStep = animationStep({ id: "an_third", elementId: title.id, effect: { kind: "fadeOut" }, trigger: "afterPrevious" });
const elsewhereStep = animationStep({ id: "an_elsewhere", elementId: other.id });

function deck(options: Readonly<{ steps?: readonly AnimationStep[] }> = {}): DocumentSnapshot {
  return testDocument({
    slides: [
      slide({ id: "slide_one", elements: [title, box, pair], animations: options.steps ?? [firstStep, secondStep, thirdStep] }),
      slide({ id: "slide_two", elements: [other], animations: [elsewhereStep] }),
    ],
  });
}

function stateWith(options: Readonly<{ document?: DocumentSnapshot; selection?: Selection; chosen?: AnimationStepId | null }>): EditorState {
  const state = editorStateFor(options.document ?? deck());
  return { ...state, selection: options.selection ?? { kind: "none" }, chrome: { ...state.chrome, propertiesTab: "animate", selectedAnimationStepId: options.chosen ?? null } };
}

function envelopes(state: EditorState): readonly CommandEnvelope[] {
  return state.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? [edit.envelope] : []));
}

function commandsOf(state: EditorState): readonly DocumentCommand[] {
  return envelopes(state).flatMap((envelope) => envelope.commands);
}

function insertedSteps(state: EditorState): Readonly<{ steps: readonly AnimationStep[]; after: AnimationStepId | null } | null> {
  for (const command of commandsOf(state)) {
    if (command.kind === "insertAnimationSteps") return { steps: command.steps, after: command.after };
  }
  return null;
}

function changedTo(document: DocumentSnapshot): EditorEvent {
  return {
    kind: "documentChanged",
    change: { snapshot: document, origin: { kind: "remote" }, changedSlideIds: [SLIDE_ONE], deckLevelChanged: false, textChanges: new Map(), history: { canUndo: true, canRedo: false } },
  };
}

describe("adding an animation", () => {
  const elements = (ids: readonly ElementId[]): Selection => ({ kind: "elements", slideId: SLIDE_ONE, elementIds: ids });
  const rows: readonly Readonly<{
    name: string;
    selection: Selection;
    chosen: AnimationStepId | null;
    expected: Readonly<{ elementIds: readonly ElementId[]; triggers: readonly AnimationStep["trigger"][]; after: AnimationStepId | null }> | null;
  }>[] = [
    { name: "one shape selected: one step on it, on click, at the end", selection: elements([box.id]), chosen: null, expected: { elementIds: [box.id], triggers: ["onClick"], after: thirdStep.id } },
    {
      name: "two shapes selected: one step each, the second with the first",
      selection: elements([title.id, box.id]),
      chosen: null,
      expected: { elementIds: [title.id, box.id], triggers: ["onClick", "withPrevious"], after: thirdStep.id },
    },
    { name: "a group selected: one step on the group, not on its leaves", selection: elements([pair.id]), chosen: null, expected: { elementIds: [pair.id], triggers: ["onClick"], after: thirdStep.id } },
    { name: "a chosen step on this slide: inserted after it", selection: elements([box.id]), chosen: firstStep.id, expected: { elementIds: [box.id], triggers: ["onClick"], after: firstStep.id } },
    { name: "a chosen step on another slide: at the end", selection: elements([box.id]), chosen: elsewhereStep.id, expected: { elementIds: [box.id], triggers: ["onClick"], after: thirdStep.id } },
    { name: "control: nothing selected adds nothing", selection: { kind: "none" }, chosen: null, expected: null },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const before = stateWith({ selection: row.selection, chosen: row.chosen });
      const after = reduceEditor(before, { kind: "animationAddRequested", effect: { kind: "zoomIn" } });
      const inserted = insertedSteps(after);
      if (row.expected === null) {
        assert.equal(inserted, null);
        assert.equal(envelopes(after).length, 0);
        assert.deepEqual(after.notices.map((notice) => notice.message), [NOTHING_TO_ANIMATE_MESSAGE]);
        return;
      }
      assert.ok(inserted !== null);
      assert.equal(envelopes(after).length, 1, "one envelope, one undo step");
      assert.deepEqual(inserted.steps.map((step) => step.elementId), row.expected.elementIds);
      assert.deepEqual(inserted.steps.map((step) => step.trigger), row.expected.triggers);
      assert.equal(inserted.after, row.expected.after);
      for (const step of inserted.steps) {
        assert.deepEqual(step.effect, { kind: "zoomIn" });
        assert.equal(step.durationMilliseconds, DEFAULT_ANIMATION_DURATION_MILLISECONDS);
        assert.equal(step.delayMilliseconds, 0);
        assert.equal(step.easing, "easeOut");
        assert.deepEqual(step.unsupportedKeys, []);
      }
      assert.equal(new Set(inserted.steps.map((step) => step.id)).size, inserted.steps.length, "fresh, distinct ids");
      assert.equal(after.chrome.selectedAnimationStepId, inserted.steps[0]?.id, "the first new step is chosen");
      assert.deepEqual(after.selection, before.selection, "the element selection stays");
    });
  }

  it("is the same envelope on replay: ids come from the seed", () => {
    const before = stateWith({ selection: elements([box.id]) });
    const event: EditorEvent = { kind: "animationAddRequested", effect: { kind: "fadeIn" } };
    assert.deepEqual(insertedSteps(reduceEditor(before, event)), insertedSteps(reduceEditor(before, event)));
  });

  const roleRows = [
    { role: "viewer", adds: false },
    { role: "commenter", adds: false },
    { role: "control: editor", adds: true },
  ] as const;
  for (const row of roleRows) {
    it(`${row.role}: ${row.adds ? "adds the step" : "refused, nothing queued, nothing chosen"}`, () => {
      const role = row.role === "control: editor" ? "editor" : row.role;
      const before: EditorState = { ...stateWith({ selection: elements([box.id]) }), collaboration: { ...LOCAL_COLLABORATION_STATUS, role } };
      const after = reduceEditor(before, { kind: "animationAddRequested", effect: { kind: "fadeIn" } });
      assert.equal(insertedSteps(after) !== null, row.adds);
      assert.equal(after.chrome.selectedAnimationStepId !== null, row.adds);
      assert.equal(after.notices.length > 0, !row.adds);
    });
  }
});

describe("editing the sequence", () => {
  it("choosing a step sets it; choosing none clears it", () => {
    const chosen = reduceEditor(stateWith({}), { kind: "animationStepSelected", stepId: secondStep.id });
    assert.equal(chosen.chrome.selectedAnimationStepId, secondStep.id);
    assert.equal(reduceEditor(chosen, { kind: "animationStepSelected", stepId: null }).chrome.selectedAnimationStepId, null);
  });

  const patchRows: readonly Readonly<{ name: string; steps: readonly AnimationStep[]; queued: boolean }>[] = [
    { name: "a patch on a known step becomes updateAnimationSteps", steps: [firstStep, secondStep, thirdStep], queued: true },
    { name: "control: a step made with a newer version is read-only", steps: [firstStep, { ...secondStep, unsupportedKeys: ["bounce"] }, thirdStep], queued: false },
  ];
  for (const row of patchRows) {
    it(row.name, () => {
      const after = reduceEditor(stateWith({ document: deck({ steps: row.steps }) }), { kind: "animationStepPatchRequested", stepId: secondStep.id, patch: { trigger: "afterPrevious", durationMilliseconds: 900 } });
      const expected: readonly DocumentCommand[] = row.queued ? [{ kind: "updateAnimationSteps", slideId: SLIDE_ONE, stepIds: [secondStep.id], patch: { trigger: "afterPrevious", durationMilliseconds: 900 } }] : [];
      assert.deepEqual(commandsOf(after), expected);
      assert.equal(after.notices.length > 0, !row.queued);
    });
  }

  const moveRows: readonly Readonly<{ name: string; stepIds: readonly AnimationStepId[]; after: AnimationStepId | null; queued: boolean }>[] = [
    { name: "the third step to the front", stepIds: [thirdStep.id], after: null, queued: true },
    { name: "the first step after the second", stepIds: [firstStep.id], after: secondStep.id, queued: true },
    { name: "control: the second step after the first, where it already is", stepIds: [secondStep.id], after: firstStep.id, queued: false },
    { name: "control: a step after itself", stepIds: [secondStep.id], after: secondStep.id, queued: false },
  ];
  for (const row of moveRows) {
    it(row.name, () => {
      const after = reduceEditor(stateWith({}), { kind: "animationStepsMoved", stepIds: row.stepIds, after: row.after });
      const expected: readonly DocumentCommand[] = row.queued ? [{ kind: "moveAnimationSteps", slideId: SLIDE_ONE, stepIds: row.stepIds, after: row.after }] : [];
      assert.deepEqual(commandsOf(after), expected);
    });
  }

  const removeRows: readonly Readonly<{ name: string; steps: readonly AnimationStep[]; removed: AnimationStepId; chosen: AnimationStepId | null; chosenAfter: AnimationStepId | null }>[] = [
    { name: "the chosen middle step: the next one is chosen", steps: [firstStep, secondStep, thirdStep], removed: secondStep.id, chosen: secondStep.id, chosenAfter: thirdStep.id },
    { name: "the chosen last step: the one before it is chosen", steps: [firstStep, secondStep, thirdStep], removed: thirdStep.id, chosen: thirdStep.id, chosenAfter: secondStep.id },
    { name: "the only step: nothing is chosen", steps: [firstStep], removed: firstStep.id, chosen: firstStep.id, chosenAfter: null },
    { name: "control: removing a step that is not chosen keeps the choice", steps: [firstStep, secondStep, thirdStep], removed: thirdStep.id, chosen: firstStep.id, chosenAfter: firstStep.id },
  ];
  for (const row of removeRows) {
    it(`removing ${row.name}`, () => {
      const after = reduceEditor(stateWith({ document: deck({ steps: row.steps }), chosen: row.chosen }), { kind: "animationStepRemoved", stepId: row.removed });
      assert.deepEqual(commandsOf(after), [{ kind: "deleteAnimationSteps", slideId: SLIDE_ONE, stepIds: [row.removed] }]);
      assert.equal(after.chrome.selectedAnimationStepId, row.chosenAfter);
    });
  }

  it("Preview counts generations; its end clears it", () => {
    const once = reduceEditor(stateWith({}), { kind: "buildPreviewRequested", slideId: SLIDE_ONE });
    const twice = reduceEditor(once, { kind: "buildPreviewRequested", slideId: SLIDE_ONE });
    assert.deepEqual(once.chrome.buildPreview, { slideId: SLIDE_ONE, generation: 1 });
    assert.deepEqual(twice.chrome.buildPreview, { slideId: SLIDE_ONE, generation: 2 });
    assert.equal(reduceEditor(twice, { kind: "buildPreviewEnded" }).chrome.buildPreview, null);
  });
});

describe("the chosen step survives only while it exists on the current slide", () => {
  const rows: readonly Readonly<{ name: string; event: EditorEvent; kept: boolean }>[] = [
    { name: "a collaborator removes the chosen step", event: changedTo(deck({ steps: [firstStep, thirdStep] })), kept: false },
    { name: "control: a collaborator removes another step", event: changedTo(deck({ steps: [secondStep, thirdStep] })), kept: true },
    { name: "switching to another slide", event: { kind: "slideActivated", slideId: SLIDE_TWO }, kept: false },
    { name: "control: activating the same slide", event: { kind: "slideActivated", slideId: SLIDE_ONE }, kept: true },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const after = reduceEditor(stateWith({ chosen: secondStep.id }), row.event);
      assert.equal(after.chrome.selectedAnimationStepId, row.kept ? secondStep.id : null);
    });
  }

  it("a step still queued counts as existing when someone else's change arrives first", () => {
    const added = reduceEditor(stateWith({ selection: { kind: "elements", slideId: SLIDE_ONE, elementIds: [box.id] } }), { kind: "animationAddRequested", effect: { kind: "fadeIn" } });
    const chosen = added.chrome.selectedAnimationStepId;
    assert.ok(chosen !== null);
    assert.equal(reduceEditor(added, changedTo(deck())).chrome.selectedAnimationStepId, chosen);
  });
});

describe("through the store", () => {
  it("adds, reorders, edits and removes; deleting the element takes its steps and the choice", () => {
    using harness = createEditorHarness({ document: testDocument({ slides: [slide({ id: "slide_one", elements: [box] })] }) });
    harness.dispatch({ kind: "selectAllRequested" });
    harness.dispatch({ kind: "animationAddRequested", effect: { kind: "flyIn", from: "left" } });
    harness.dispatch({ kind: "animationAddRequested", effect: { kind: "spin", degrees: 360 } });
    const stored = (): readonly AnimationStep[] => harness.documentStore.snapshot().slides[0]?.animations ?? [];
    assert.deepEqual(stored().map((step) => step.effect.kind), ["flyIn", "spin"]);
    const [flyIn, spin] = stored();
    assert.ok(flyIn !== undefined && spin !== undefined);
    assert.equal(harness.state().chrome.selectedAnimationStepId, spin.id, "the new step stays chosen once the store has it");
    harness.dispatch({ kind: "animationStepsMoved", stepIds: [spin.id], after: null });
    assert.deepEqual(stored().map((step) => step.effect.kind), ["spin", "flyIn"]);
    harness.dispatch({ kind: "animationStepPatchRequested", stepId: flyIn.id, patch: { trigger: "afterPrevious" } });
    assert.equal(stored()[1]?.trigger, "afterPrevious");
    harness.dispatch({ kind: "deleteRequested" });
    assert.deepEqual(stored(), []);
    assert.equal(harness.state().chrome.selectedAnimationStepId, null);
  });
});

describe("duplicating and pasting slides carries the sequence", () => {
  const scripted = animationStep({ id: "an_scripted", elementId: rightLeaf.id, effect: { kind: "scripted", scriptId: scriptId("ts_sparkle"), category: "emphasis", parameters: {} } });
  const dangling = animationStep({ id: "an_dangling", elementId: elementId("shape_gone") });
  const source: SlideSnapshot = slide({ id: "slide_one", elements: [title, box, pair], animations: [firstStep, secondStep, scripted, dangling] });

  function checkCopy(copy: SlideSnapshot | undefined): void {
    assert.ok(copy !== undefined);
    const copiedIds = copy.elements.flatMap((element) => (element.kind === "group" ? [element.id, ...element.children.map((child) => child.id)] : [element.id]));
    assert.deepEqual(
      copy.animations.map((step) => copiedIds.indexOf(step.elementId)),
      [0, 1, 4],
      "each step names the copy's element in the same place; the dangling step is dropped",
    );
    for (const step of copy.animations) assert.ok(![firstStep.id, secondStep.id, scripted.id].includes(step.id), "fresh step ids");
    assert.deepEqual(copy.animations.map((step) => step.effect.kind), ["fadeIn", "flyIn", "scripted"]);
  }

  it("Duplicate", () => {
    const before = { ...editorStateFor(testDocument({ slides: [source] })), selection: { kind: "slides", slideIds: [SLIDE_ONE] } } satisfies EditorState;
    const after = reduceEditor(before, { kind: "duplicateRequested" });
    checkCopy(commandsOf(after).flatMap((command) => (command.kind === "insertSlides" ? command.slides : []))[0]);
  });

  const sparkle: TransitionScriptRecord = {
    id: scriptId("ts_sparkle"),
    name: "Sparkle",
    description: "",
    purpose: "animation",
    author: { kind: "agent", name: "Claude", agentSessionId: "agent_session" },
    script: "",
    stylesheet: "",
    markup: "",
    defaultParameters: {},
    approval: { kind: "unapproved" },
    updatedAt: 1,
  };
  const pasteRows: readonly Readonly<{ name: string; sourceDeck: string; scriptTaken: boolean; keepsScriptId: boolean }>[] = [
    { name: "from another deck whose script id is taken here: the step follows the renamed script", sourceDeck: "deck_other", scriptTaken: true, keepsScriptId: false },
    { name: "from another deck, script id free: the step keeps its script id", sourceDeck: "deck_other", scriptTaken: false, keepsScriptId: true },
    { name: "control: from the same deck the script is this deck's own", sourceDeck: "deck_first", scriptTaken: true, keepsScriptId: true },
  ];
  for (const row of pasteRows) {
    it(`Paste ${row.name}`, () => {
      const target = { ...testDocument({ slides: [slide({ id: "slide_target", elements: [] })] }), transitionScripts: row.scriptTaken ? [{ ...sparkle, name: "Theirs" }] : [] };
      const payload: ClipboardPayload = { format: "sasha-engine/slides@1", operation: "copy", sourceDeckId: testDocument({ slides: [], deckId: row.sourceDeck }).deckId, slides: [source], assets: [], transitionScripts: [sparkle] };
      const after = reduceEditor(editorStateFor(target), { kind: "pasteReceived", content: { kind: "engine", payload }, at: null });
      const pasted = commandsOf(after).flatMap((command) => (command.kind === "insertSlides" ? command.slides : []))[0];
      checkCopy(pasted);
      const effect = pasted?.animations[2]?.effect;
      assert.equal(effect?.kind === "scripted" && effect.scriptId === sparkle.id, row.keepsScriptId);
      const upserted = commandsOf(after).flatMap((command) => (command.kind === "upsertTransitionScript" ? [command.script.id] : []));
      if (row.sourceDeck !== "deck_first") assert.deepEqual(upserted, [effect?.kind === "scripted" ? effect.scriptId : null], "the step names the script the paste stores");
    });
  }
});

describe("a new script takes the purpose it was opened for", () => {
  const animationScript: TransitionScriptRecord = {
    id: scriptId("ts_existing"),
    name: "Existing build",
    description: "",
    purpose: "animation",
    author: { kind: "person", personId: ME.id },
    script: "x",
    stylesheet: "",
    markup: "",
    defaultParameters: {},
    approval: { kind: "unapproved" },
    updatedAt: 1,
  };
  const rows: readonly Readonly<{ name: string; scriptId: TransitionScriptRecord["id"] | null; purpose: "transition" | "animation"; expectedPurpose: "transition" | "animation"; template: string | null }>[] = [
    { name: "New script from the Animate tab: an animation, from the build template", scriptId: null, purpose: "animation", expectedPurpose: "animation", template: NEW_ANIMATION_SCRIPT_TEMPLATE },
    { name: "control: New script from the Transition tab: a transition", scriptId: null, purpose: "transition", expectedPurpose: "transition", template: NEW_SCRIPT_TEMPLATE },
    { name: "an existing animation script opened as a transition keeps its own purpose", scriptId: animationScript.id, purpose: "transition", expectedPurpose: "animation", template: null },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const document = { ...deck(), transitionScripts: [animationScript] };
      const after = reduceEditor(editorStateFor(document), { kind: "transitionScriptEditorOpened", scriptId: row.scriptId, purpose: row.purpose });
      const dialog = after.chrome.dialog;
      assert.equal(dialog.kind, "transitionScriptEditor");
      if (dialog.kind !== "transitionScriptEditor") return;
      assert.equal(dialog.editor.draft.purpose, row.expectedPurpose);
      if (row.template !== null) assert.equal(dialog.editor.draft.script, row.template);
    });
  }

  it("the build template animates the incoming target named by the parameters", () => {
    assert.match(NEW_ANIMATION_SCRIPT_TEMPLATE, /context\.elements\("incoming"\)/);
    assert.match(NEW_ANIMATION_SCRIPT_TEMPLATE, /context\.parameters\.targetElementId/);
  });
});

function scriptId(text: string): TransitionScriptRecord["id"] {
  return requireParsed(parseTransitionScriptId, text);
}
