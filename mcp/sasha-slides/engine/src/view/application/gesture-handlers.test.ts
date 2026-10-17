// What must happen inside the user's gesture (acceptance 6), with fake browser capabilities that
// record the order of every call: copy and cut fill the event's DataTransfer from
// `clipboardContentFor` synchronously; Present enters full screen and opens the speaker window
// before it dispatches; in the add-on dialog Present opens a tab instead.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ClipboardContent, EditorEmbedding, EditorState } from "../../contracts/editor-state.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import { ENGINE_CLIPBOARD_MEDIA_TYPE, type BrowserCapabilities } from "../../contracts/editor-system.ts";
import { ASSET_ADDRESS_SCHEME, SLIDE_ROOT_CLASS } from "../../contracts/render.ts";
import { createPrefixedIdMinter, documentSnapshot, fixtureAssetId, fixtureDeckId, imageElement, plainBody, shapeElement, slideSnapshot } from "../../contracts/testing/snapshot-builders.ts";
import { createRecordingSystem, fixtureEditorState } from "../testing/editor-fixtures.ts";
import { handleShellKey } from "./editor-shell.tsx";
import { handleClipboardWrite, handlePaste, handlePresent, type ClipboardTransferEvent, type GestureContext } from "./gesture-handlers.ts";

const ids = createPrefixedIdMinter("Gesture1");
const element = shapeElement({ id: ids.next("element"), text: plainBody("Copied words") });
const slide = slideSnapshot({ ids, elements: [element] });
const document = documentSnapshot({ deckId: fixtureDeckId("deck_gesture"), title: "Gestures", slides: [slide] });
/** An image whose bytes the page holds, at the address the editor draws it from. */
const PHOTO = fixtureAssetId("copied-photo");
const PHOTO_ADDRESS = "blob:https://sashaslides.test/0b6f-photo";
const CONTENT: ClipboardContent = {
  payload: { format: "sasha-engine/elements@1", operation: "copy", sourceDeckId: document.deckId, slideId: slide.id, elements: [element], assets: [] },
  plainText: "Copied words",
};

describe("copy and cut", () => {
  const rows: readonly Readonly<{ operation: "copy" | "cut"; dispatched: EditorEvent }>[] = [
    { operation: "copy", dispatched: { kind: "copied" } },
    { operation: "cut", dispatched: { kind: "cutRequested" } },
  ];
  for (const row of rows) {
    it(`${row.operation} reads clipboardContentFor synchronously and fills the DataTransfer in the same event`, () => {
      const calls: string[] = [];
      const harness = gestureHarness({ calls, embedding: { kind: "webApplication" } });
      const written = new Map<string, string>();
      const event: ClipboardTransferEvent = {
        clipboardData: {
          setData: (format, data) => {
            calls.push(`setData ${format}`);
            written.set(format, data);
          },
          getData: () => "",
          types: [],
          files: [],
        },
        preventDefault: () => calls.push("preventDefault"),
      };
      const wrote = handleClipboardWrite({ context: harness.context, event, operation: row.operation });
      // Everything below was recorded before the handler returned: no await happened.
      assert.equal(wrote, true);
      assert.deepEqual(calls, ["clipboardContentFor", `setData ${ENGINE_CLIPBOARD_MEDIA_TYPE}`, "setData text/html", "setData text/plain", "preventDefault", `dispatch ${row.dispatched.kind}`]);
      assert.deepEqual(JSON.parse(written.get(ENGINE_CLIPBOARD_MEDIA_TYPE) ?? "null"), { ...CONTENT.payload, operation: row.operation }, "a cut writes a cut payload");
      assert.match(written.get("text/html") ?? "", new RegExp(`class="${SLIDE_ROOT_CLASS}"[\\s\\S]*Copied words`));
      assert.equal(written.get("text/plain"), "Copied words");
      assert.deepEqual(harness.dispatched, [row.dispatched]);
    });
  }

  it("the copied markup draws images from the page's own addresses, never the sandbox's tokens other applications cannot load", () => {
    const loaded = imageElement({ id: ids.next("element"), assetId: PHOTO, box: { x: 0, y: 0, width: 400, height: 300 } });
    const notYetHere = imageElement({ id: ids.next("element"), assetId: fixtureAssetId("not-here-yet"), box: { x: 400, y: 0, width: 400, height: 300 } });
    const content: ClipboardContent = {
      payload: { format: "sasha-engine/elements@1", operation: "copy", sourceDeckId: document.deckId, slideId: slide.id, elements: [loaded, notYetHere], assets: [] },
      plainText: "",
    };
    const written = new Map<string, string>();
    const harness = gestureHarness({ calls: [], embedding: { kind: "webApplication" }, content });
    const event: ClipboardTransferEvent = { clipboardData: { setData: (format, data) => written.set(format, data), getData: () => "", types: [], files: [] }, preventDefault: () => undefined };
    assert.equal(handleClipboardWrite({ context: harness.context, event, operation: "copy" }), true);
    const markup = written.get("text/html") ?? "";
    assert.ok(markup.includes(PHOTO_ADDRESS), "the loaded image is drawn from its address");
    assert.ok(!markup.includes(ASSET_ADDRESS_SCHEME), "no image refers to a sasha-asset token");
  });

  it("with nothing copyable, the browser's own copy runs and nothing is dispatched", () => {
    const calls: string[] = [];
    const harness = gestureHarness({ calls, embedding: { kind: "webApplication" }, content: null });
    const wrote = handleClipboardWrite({ context: harness.context, event: { clipboardData: null, preventDefault: () => calls.push("preventDefault") }, operation: "copy" });
    assert.equal(wrote, false);
    assert.deepEqual(calls, ["clipboardContentFor"]);
  });

  it("a paste of the engine's own payload arrives as engine content; plain text as text", () => {
    const harness = gestureHarness({ calls: [], embedding: { kind: "webApplication" } });
    const transfer = (types: Readonly<Record<string, string>>): ClipboardTransferEvent => ({ clipboardData: { setData: () => undefined, getData: (format) => types[format] ?? "", types: Object.keys(types), files: [] }, preventDefault: () => undefined });
    handlePaste({ context: harness.context, event: transfer({ [ENGINE_CLIPBOARD_MEDIA_TYPE]: JSON.stringify(CONTENT.payload), "text/plain": "Copied words" }), at: null, richTextFrom: () => null, readImageFile: () => Promise.resolve(null) });
    handlePaste({ context: harness.context, event: transfer({ "text/plain": "two\r\nlines" }), at: { x: 10, y: 20 }, richTextFrom: () => null, readImageFile: () => Promise.resolve(null) });
    assert.deepEqual(harness.dispatched, [
      { kind: "pasteReceived", content: { kind: "engine", payload: CONTENT.payload }, at: null },
      { kind: "pasteReceived", content: { kind: "text", text: { kind: "plain", text: "two\nlines" } }, at: { x: 10, y: 20 } },
    ]);
  });
});

describe("Present", () => {
  const rows: readonly Readonly<{ label: string; embedding: EditorEmbedding; withSpeakerView: boolean; calls: readonly string[] }>[] = [
    { label: "with the speaker view: full screen, then the speaker window, then the dispatch", embedding: { kind: "webApplication" }, withSpeakerView: true, calls: ["requestFullScreen", "openSpeakerWindow", "dispatch presentRequested"] },
    { label: "without the speaker view: full screen, then the dispatch", embedding: { kind: "webApplication" }, withSpeakerView: false, calls: ["requestFullScreen", "dispatch presentRequested"] },
    { label: "in the add-on dialog: a top-level tab instead, and no presenter in the dialog", embedding: { kind: "addonDialog", webApplicationAddress: "https://sashaslides.com/deck/deck_gesture" }, withSpeakerView: true, calls: ["openTab"] },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const calls: string[] = [];
      const harness = gestureHarness({ calls, embedding: row.embedding });
      handlePresent({ context: harness.context, from: "currentSlide", withSpeakerView: row.withSpeakerView });
      assert.deepEqual(calls, row.calls);
    });
  }

  it("the add-on's tab opens the web application on the current slide", () => {
    const calls: string[] = [];
    const harness = gestureHarness({ calls, embedding: { kind: "addonDialog", webApplicationAddress: "https://sashaslides.com/deck/deck_gesture" } });
    handlePresent({ context: harness.context, from: "currentSlide", withSpeakerView: false });
    assert.deepEqual(harness.tabs, [`https://sashaslides.com/deck/deck_gesture?present=${slide.id}`]);
  });

  it("primary+Enter presents from the key event itself, before anything is dispatched", () => {
    const calls: string[] = [];
    const harness = gestureHarness({ calls, embedding: { kind: "webApplication" } });
    let prevented = false;
    handleShellKey({ event: { key: "Enter", code: "Enter", shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, target: null, defaultPrevented: false, preventDefault: () => (prevented = true) }, gesture: harness.context, primaryModifier: "control" });
    assert.equal(prevented, true);
    assert.deepEqual(calls, ["requestFullScreen", "dispatch presentRequested"]);
  });

  it("Enter, Space and Tab on a focused button stay the button's, while Delete still reaches the key map", () => {
    const harness = gestureHarness({ calls: [], embedding: { kind: "webApplication" } });
    const button = { closest: (selector: string) => (selector.includes("button") ? button : null) } as unknown as EventTarget;
    const prevented: string[] = [];
    for (const key of ["Enter", " ", "Tab", "Delete"]) {
      handleShellKey({ event: { key, code: key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: button, defaultPrevented: false, preventDefault: () => prevented.push(key) }, gesture: harness.context, primaryModifier: "control" });
    }
    assert.deepEqual(prevented, ["Delete"]);
    assert.deepEqual(harness.dispatched, [{ kind: "keyPressed", chord: { key: "Delete", code: "Delete", modifiers: { shift: false, alt: false, primary: false } } }]);
  });

  it("other keys go to the key map as chords", () => {
    const harness = gestureHarness({ calls: [], embedding: { kind: "webApplication" } });
    handleShellKey({ event: { key: "z", code: "KeyZ", shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, target: null, defaultPrevented: false, preventDefault: () => undefined }, gesture: harness.context, primaryModifier: "control" });
    assert.deepEqual(harness.dispatched, [{ kind: "keyPressed", chord: { key: "z", code: "KeyZ", modifiers: { shift: false, alt: false, primary: true } } }]);
  });
});

/** A gesture context whose capabilities, selector and dispatch all record into `calls`, in order. */
function gestureHarness(options: Readonly<{ calls: string[]; embedding: EditorEmbedding; content?: ClipboardContent | null }>): Readonly<{ context: GestureContext; dispatched: readonly EditorEvent[]; tabs: readonly string[] }> {
  const state: EditorState = { ...fixtureEditorState({ document, embedding: options.embedding }), currentSlideId: slide.id };
  const recording = createRecordingSystem({ initial: state });
  const tabs: string[] = [];
  const system = {
    ...recording,
    dispatch: (event: EditorEvent) => {
      options.calls.push(`dispatch ${event.kind}`);
      recording.dispatch(event);
    },
  };
  const browser: BrowserCapabilities = {
    writeClipboard: () => {
      options.calls.push("writeClipboard");
      return Promise.resolve();
    },
    requestFullScreen: () => {
      options.calls.push("requestFullScreen");
      return Promise.resolve();
    },
    exitFullScreen: () => {
      options.calls.push("exitFullScreen");
      return Promise.resolve();
    },
    openSpeakerWindow: () => {
      options.calls.push("openSpeakerWindow");
      // A speaker window object: only its identity matters to the handler under test.
      return {} as Window;
    },
    openTab: (address) => {
      options.calls.push("openTab");
      tabs.push(address);
    },
  };
  const content = options.content === undefined ? CONTENT : options.content;
  const context: GestureContext = {
    system,
    browser,
    clipboardContentFor: (_state, operation) => {
      options.calls.push("clipboardContentFor");
      return content === null ? null : { ...content, payload: { ...content.payload, operation } };
    },
    // Any element will do: the fake full-screen request only records that it was asked.
    presentationHost: () => ({}) as Element,
    speakerWindow: { current: null },
    assetAddress: (assetId) => (assetId === PHOTO ? PHOTO_ADDRESS : null),
  };
  return { context, dispatched: recording.dispatched, tabs };
}
