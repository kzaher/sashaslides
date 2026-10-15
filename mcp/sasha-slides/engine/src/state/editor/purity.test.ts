// Acceptance test 5: the reducer is pure. A recorded session -- typing, a drag, a paste, a comment, a
// measurement, a nudge, an undo, with every feedback event the stores caused -- replayed from the same
// initial state gives a deeply equal state, every minted id included. And the reducer's sources reach
// for no clock and no random source, so the test harness never has to provide one.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMPTY_DISCUSSION, type EditorEvent, type Modifiers } from "../../contracts/index.ts";
import { elementId, ME, shape, slide, slideId, testDocument, textBody } from "../testing/document-fixtures.ts";
import { createEditorHarness } from "../testing/editor-harness.ts";
import { clipboardContentFor } from "./clipboard.ts";
import { initialEditorState } from "./initial-editor-state.ts";
import { reduceEditor } from "./reduce-editor.ts";

const NONE: Modifiers = { shift: false, alt: false, primary: false };
const document = testDocument({
  slides: [
    slide({
      id: "slide_one",
      elements: [
        shape({ id: "shape_text", x: 100, y: 100, width: 400, height: 80, preset: "textBox", text: textBody("") }),
        shape({ id: "shape_box", x: 600, y: 300, width: 200, height: 200 }),
      ],
    }),
  ],
});

describe("purity (acceptance 5)", () => {
  it("replaying the recorded event log reproduces the state, ids included", () => {
    using harness = createEditorHarness({ document });
    const pointer = (kind: "canvasPointerDown" | "canvasPointerMove" | "canvasPointerUp", x: number, y: number): EditorEvent => {
      const sample = { slidePoint: { x, y }, clientPoint: { x, y } };
      switch (kind) {
        case "canvasPointerDown":
          return { kind, sample, target: { kind: "element", elementPath: [elementId("shape_box")] }, modifiers: NONE, button: "primary", clickCount: 1 };
        case "canvasPointerMove":
        case "canvasPointerUp":
          return { kind, sample, modifiers: NONE };
        default:
          return kind satisfies never;
      }
    };
    const session: readonly EditorEvent[] = [
      { kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId("shape_text") }, at: "end" },
      { kind: "textInput", input: { kind: "insertText", text: "H" } },
      { kind: "textInput", input: { kind: "insertText", text: "i" } },
      { kind: "layoutMeasured", slideId: slideId("slide_one"), elementId: elementId("shape_text"), measurement: { kind: "text", contentHeight: 96 } },
      { kind: "textEditingEnded" },
      pointer("canvasPointerDown", 700, 400),
      pointer("canvasPointerMove", 760, 420),
      pointer("canvasPointerUp", 760, 420),
      { kind: "keyPressed", chord: { key: "ArrowRight", code: "ArrowRight", modifiers: { ...NONE, shift: true } } },
      { kind: "commentComposerOpened", slideId: slideId("slide_one"), elementId: elementId("shape_box"), textRange: null, region: null },
      { kind: "commentDraftChanged", draft: "Bigger?" },
      { kind: "commentSubmitted" },
      { kind: "undoRequested" },
    ];
    for (const event of session) harness.dispatch(event);
    const content = clipboardContentFor(harness.state(), "copy");
    assert.ok(content !== null);
    harness.dispatch({ kind: "copied" });
    harness.dispatch({ kind: "pasteReceived", content: { kind: "engine", payload: content.payload }, at: null });

    const logged = harness.system.recentEvents();
    assert.ok(logged.some((entry) => entry.source === "feedback"), "the log holds the stores' answers too");
    const initial = initialEditorState({
      me: ME,
      sessionPrefix: "Test0000",
      embedding: { kind: "webApplication" },
      document,
      discussion: EMPTY_DISCUSSION,
      containerSize: { width: 0, height: 0 },
    });
    const replayed = logged.map((entry) => entry.event).reduce(reduceEditor, initial);
    assert.deepStrictEqual(replayed, harness.state());
    assert.ok(replayed.idSeed.counter > 5, "the session minted ids");
    assert.deepEqual(harness.reportedErrors(), []);
  });

  it("the reducer's sources call no clock, random source or timer", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    assert.ok(sources.length > 10);
    const forbidden = [/Date\.now/u, /new Date\(/u, /Math\.random/u, /performance\.now/u, /setTimeout/u, /setInterval/u, /crypto\./u];
    for (const name of sources) {
      const text = readFileSync(join(directory, name), "utf8");
      for (const pattern of forbidden) assert.ok(!pattern.test(text), `${name} uses ${pattern.source}`);
    }
  });
});
