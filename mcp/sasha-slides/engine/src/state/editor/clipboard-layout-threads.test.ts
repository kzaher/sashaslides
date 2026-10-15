// Acceptance tests 11, 16 and 17: the clipboard selector and paste rules, layout remapping by role and
// index, and where comment threads show after their anchors move or vanish.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_TEXT_BODY,
  mintId,
  textTargetKey,
  type ClipboardPayload,
  type CommandEnvelope,
  type CommentThread,
  type DocumentCommand,
  type DocumentSnapshot,
  type EditorEvent,
  type EditorState,
  type ElementSnapshot,
  type TransitionScriptRecord,
} from "../../contracts/index.ts";
import { editorStateFor, elementId, layout, layoutId, ME, shape, slide, slideId, testDocument, textBody } from "../testing/document-fixtures.ts";
import { arrangeThreads } from "./arrange-threads.ts";
import { clipboardContentFor } from "./clipboard.ts";
import { reduceEditor } from "./reduce-editor.ts";

const SLIDE = slideId("slide_one");

function envelopes(state: EditorState): readonly CommandEnvelope[] {
  return state.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? [edit.envelope] : []));
}

function insertedElements(envelope: CommandEnvelope | undefined): readonly ElementSnapshot[] {
  return (envelope?.commands ?? []).flatMap((command) => (command.kind === "insertElements" ? command.elements : []));
}

function changedTo(document: DocumentSnapshot): EditorEvent {
  return {
    kind: "documentChanged",
    change: { snapshot: document, origin: { kind: "remote" }, changedSlideIds: [SLIDE], deckLevelChanged: false, textChanges: new Map(), history: { canUndo: true, canRedo: false } },
  };
}

const moved = shape({ id: "shape_moved", x: 100, y: 100, width: 200, height: 100, text: textBody("Hello") });
const document = testDocument({ slides: [slide({ id: "slide_one", elements: [moved] }), slide({ id: "slide_two", elements: [] })] });
const selected: EditorState = { ...editorStateFor(document), selection: { kind: "elements", slideId: SLIDE, elementIds: [moved.id] } };

describe("clipboard (acceptance 11)", () => {
  it("clipboardContentFor returns an elements payload with plain text", () => {
    const content = clipboardContentFor(selected, "copy");
    assert.ok(content !== null);
    assert.equal(content.payload.format, "sasha-engine/elements@1");
    assert.equal(content.plainText, "Hello");
    assert.deepEqual(content.payload.format === "sasha-engine/elements@1" ? content.payload.elements : [], [moved]);
  });

  it("clipboardContentFor returns a slides payload for a filmstrip selection, and null for nothing", () => {
    const content = clipboardContentFor({ ...selected, selection: { kind: "slides", slideIds: [SLIDE] } }, "copy");
    assert.equal(content?.payload.format, "sasha-engine/slides@1");
    assert.equal(content?.plainText, "Hello");
    assert.equal(clipboardContentFor({ ...selected, selection: { kind: "none" } }, "copy"), null);
  });

  const cutRows = [
    { name: "a cut pasted into the same deck keeps the free id", operation: "cut", sourceDeck: "deck_first", keepsId: true },
    { name: "a copy pasted into the same deck gets a new id (control)", operation: "copy", sourceDeck: "deck_first", keepsId: false },
    { name: "a cut pasted into another deck gets a new id", operation: "cut", sourceDeck: "deck_other", keepsId: false },
  ] as const;
  for (const row of cutRows) {
    it(row.name, () => {
      const content = clipboardContentFor(selected, row.operation);
      assert.ok(content !== null && content.payload.format === "sasha-engine/elements@1");
      assert.equal(content.payload.operation, row.operation, "the selector records the operation it was asked for");
      const payload: ClipboardPayload = { ...content.payload, sourceDeckId: testDocument({ slides: [], deckId: row.sourceDeck }).deckId };
      const cut = reduceEditor(selected, { kind: "cutRequested" });
      assert.deepEqual(envelopes(cut)[0]?.commands, [{ kind: "deleteElements", slideId: SLIDE, elementIds: [moved.id] }]);
      const afterCut = testDocument({ revision: 2, slides: [slide({ id: "slide_one", elements: [] }), slide({ id: "slide_two", elements: [] })] });
      const settled = reduceEditor({ ...cut, pendingEdits: [] }, changedTo(afterCut));
      const pasted = reduceEditor({ ...settled, currentSlideId: slideId("slide_two") }, { kind: "pasteReceived", content: { kind: "engine", payload }, at: null });
      const element = insertedElements(envelopes(pasted)[0])[0];
      assert.ok(element !== undefined);
      assert.equal(element.id === moved.id, row.keepsId);
      assert.equal(element.morphKey, moved.morphKey, "morph keys are kept either way");
    });
  }

  it("a kept id keeps the thread on the element", () => {
    const thread = threadOn({ elementId: "shape_moved", slide: "slide_two" });
    const afterPaste = testDocument({ slides: [slide({ id: "slide_one", elements: [] }), slide({ id: "slide_two", elements: [moved] })] });
    const placement = arrangeThreads({ discussion: { sequence: 1, threads: [thread] }, document: afterPaste, resolvedTextAnchors: new Map() })[0]?.placement;
    assert.equal(placement?.kind, "onElement");
  });

  it("consecutive pastes cascade by 10 units", () => {
    const content = clipboardContentFor(selected, "copy");
    assert.ok(content !== null);
    const paste: EditorEvent = { kind: "pasteReceived", content: { kind: "engine", payload: content.payload }, at: null };
    const once = reduceEditor(selected, paste);
    const twice = reduceEditor(once, paste);
    const first = insertedElements(envelopes(twice)[0])[0];
    const second = insertedElements(envelopes(twice)[1])[0];
    assert.ok(first !== undefined && second !== undefined);
    assert.deepEqual({ x: first.frame.x, y: first.frame.y }, { x: 110, y: 110 }, "a copy onto its own slide starts one step out");
    assert.deepEqual({ x: second.frame.x - first.frame.x, y: second.frame.y - first.frame.y }, { x: 10, y: 10 });
    assert.notEqual(first.id, second.id);
  });

  it("slides pasted into another deck are re-identified and their scripts arrive unapproved", () => {
    const scriptId = mintId({ seed: { sessionPrefix: "Script00", counter: 0 }, kind: "transitionScript" }).id;
    const script: TransitionScriptRecord = {
      id: scriptId,
      name: "Wipe",
      description: "",
      purpose: "transition",
      author: { kind: "person", personId: ME.id },
      script: "sashaTransition.define({ name: 'Wipe', async run() {} });",
      stylesheet: "",
      markup: "",
      defaultParameters: {},
      approval: { kind: "approved", approvedBy: ME.id, fingerprint: "0" },
      updatedAt: 5,
    };
    const scripted = { ...slide({ id: "slide_one", elements: [moved] }), transition: { kind: "scripted" as const, scriptId, durationMilliseconds: 800, parameters: {} } };
    const payload: ClipboardPayload = {
      format: "sasha-engine/slides@1",
      operation: "copy",
      sourceDeckId: testDocument({ slides: [], deckId: "deck_other" }).deckId,
      slides: [scripted],
      assets: [],
      transitionScripts: [script],
    };
    const pasted = reduceEditor(editorStateFor(document), { kind: "pasteReceived", content: { kind: "engine", payload }, at: null });
    const envelope = envelopes(pasted)[0];
    assert.ok(envelope !== undefined);
    assert.equal(envelope.author.kind, "person", "the person pasting stays the author");
    const upsert = envelope.commands.find((command): command is Extract<DocumentCommand, { kind: "upsertTransitionScript" }> => command.kind === "upsertTransitionScript");
    assert.equal(upsert?.approval, "unapproved", "a script carried from another deck is not reviewed by the paste");
    assert.equal(upsert?.script.script, script.script);
    const inserted = envelope.commands.find((command): command is Extract<DocumentCommand, { kind: "insertSlides" }> => command.kind === "insertSlides");
    const pastedSlide = inserted?.slides[0];
    assert.ok(pastedSlide !== undefined);
    assert.notEqual(pastedSlide.id, scripted.id);
    assert.notEqual(pastedSlide.elements[0]?.id, moved.id);
    assert.equal(pastedSlide.elements[0]?.morphKey, moved.morphKey);
  });
});

describe("layout remapping (acceptance 16)", () => {
  const slideTitle = shape({ id: "shape_title", x: 10, y: 10, width: 500, height: 80, text: textBody("Kept title"), placeholder: { role: "title", index: 0 } });
  const slideFooter = shape({ id: "shape_footer", x: 10, y: 600, width: 300, height: 40, text: textBody("Footer"), placeholder: { role: "footer", index: 0 } });
  const layoutTitle = shape({ id: "layout_title", x: 80, y: 40, width: 1120, height: 120, text: textBody("Click to add title"), placeholder: { role: "title", index: 0 } });
  const layoutSecondBody = shape({ id: "layout_body_two", x: 660, y: 200, width: 540, height: 400, text: textBody("Click to add text"), placeholder: { role: "body", index: 1 } });
  const twoColumns = layoutId("Columns2");
  const remapDocument = testDocument({
    layouts: [layout({ id: twoColumns, elements: [layoutTitle, layoutSecondBody] })],
    slides: [slide({ id: "slide_one", elements: [slideTitle, slideFooter] })],
  });

  it("is one envelope: matched keep text and take the layout frame, unmatched stay, missing are added empty", () => {
    const changed = reduceEditor(editorStateFor(remapDocument), { kind: "slideLayoutChosen", layoutId: twoColumns });
    const queued = envelopes(changed);
    assert.equal(queued.length, 1);
    const commands = queued[0]?.commands ?? [];
    assert.deepEqual(commands[0], { kind: "setSlideProperties", slideId: SLIDE, patch: { layoutId: twoColumns } });
    assert.deepEqual(commands[1], { kind: "setFrames", slideId: SLIDE, frames: [{ kind: "box", elementId: slideTitle.id, frame: layoutTitle.frame }] });
    const added = insertedElements(queued[0]);
    assert.equal(added.length, 1);
    const addedBody = added[0];
    assert.ok(addedBody !== undefined && addedBody.kind === "shape");
    assert.deepEqual(addedBody.placeholder, { role: "body", index: 1 });
    assert.deepEqual(addedBody.text, EMPTY_TEXT_BODY);
    assert.notEqual(addedBody.id, layoutSecondBody.id);
    assert.ok(!commands.some((command) => JSON.stringify(command).includes(slideFooter.id)), "the unmatched footer is left alone");
    assert.ok(!commands.some((command) => command.kind === "editText"), "matched text is kept");
  });
});

function threadOn(options: Readonly<{ elementId: string | null; slide: string; region?: CommentThread["anchor"]["region"] }>): CommentThread {
  const threadId = mintId({ seed: { sessionPrefix: "Thread00", counter: 0 }, kind: "thread" }).id;
  return {
    id: threadId,
    anchor: {
      slideId: slideId(options.slide),
      target: options.elementId === null ? { kind: "slide" } : { kind: "element", elementId: elementId(options.elementId) },
      region: options.region === undefined ? { x: 0.5, y: 0.5, width: 0.25, height: 0.5 } : options.region,
      elementFrameAtCreation: { x: 100, y: 100, width: 200, height: 100 },
    },
    status: { kind: "open" },
    createdBy: ME,
    createdAt: 1,
    messages: [],
    markings: [],
  };
}

describe("arrangeThreads (acceptance 17)", () => {
  const thread = threadOn({ elementId: "shape_moved", slide: "slide_one" });
  const discussion = { sequence: 1, threads: [thread] };

  it("on the element, the box follows the element when it moves", () => {
    const here = arrangeThreads({ discussion, document, resolvedTextAnchors: new Map() })[0]?.placement;
    assert.deepEqual(here, { kind: "onElement", slideId: SLIDE, elementId: moved.id, box: { x: 200, y: 150, width: 50, height: 50 }, textRange: null });
    const movedDocument = testDocument({ slides: [slide({ id: "slide_one", elements: [{ ...moved, frame: { ...moved.frame, x: 400, y: 300 } }] })] });
    const there = arrangeThreads({ discussion, document: movedDocument, resolvedTextAnchors: new Map() })[0]?.placement;
    assert.deepEqual(there, { kind: "onElement", slideId: SLIDE, elementId: moved.id, box: { x: 500, y: 350, width: 50, height: 50 }, textRange: null });
  });

  it("deleting the anchored element falls back to its frame at creation", () => {
    const withoutElement = testDocument({ slides: [slide({ id: "slide_one", elements: [] })] });
    const placement = arrangeThreads({ discussion, document: withoutElement, resolvedTextAnchors: new Map() })[0]?.placement;
    assert.deepEqual(placement, { kind: "elementRemoved", slideId: SLIDE, box: { x: 200, y: 150, width: 50, height: 50 } });
  });

  it("deleting the slide lists it under deleted slides, after every slide's threads", () => {
    const other = { ...threadOn({ elementId: null, slide: "slide_two", region: null }), id: mintId({ seed: { sessionPrefix: "Thread00", counter: 1 }, kind: "thread" }).id, createdAt: 9 };
    const withoutFirst = testDocument({ slides: [slide({ id: "slide_two", elements: [] })] });
    const arranged = arrangeThreads({ discussion: { sequence: 2, threads: [thread, other] }, document: withoutFirst, resolvedTextAnchors: new Map() });
    assert.deepEqual(arranged.map((entry) => entry.placement.kind), ["onSlide", "slideRemoved"]);
    assert.deepEqual(arranged[0]?.placement, { kind: "onSlide", slideId: slideId("slide_two"), box: { x: 1280, y: 0, width: 0, height: 0 } });
  });

  it("a text-anchored thread carries its resolved range", () => {
    const target = { kind: "element" as const, slideId: SLIDE, elementId: moved.id };
    const textThread: CommentThread = { ...thread, anchor: { ...thread.anchor, target: { kind: "text", elementId: moved.id, anchor: { target, start: "1", end: "3" }, quotedText: "el" } } };
    const range = { target, start: 1, end: 3 };
    const placement = arrangeThreads({ discussion: { sequence: 1, threads: [textThread] }, document, resolvedTextAnchors: new Map([[textThread.id, range]]) })[0]?.placement;
    assert.equal(placement?.kind === "onElement" ? textTargetKey(placement.textRange?.target ?? target) : null, textTargetKey(target));
    assert.deepEqual(placement?.kind === "onElement" ? placement.textRange : null, range);
  });
});
