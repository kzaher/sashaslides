// The diagram dialog's state machine, the candidates window's half of draw.io (an insert's diagrams
// under their deck ids, linked best effort, remembered by the conversion cache), and the new page's
// size budget.

import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import type { ConvertedDiagram } from "../../converter/convert-html-to-slide-requests.ts";
import { cachedConversion, rememberConversion } from "./conversion-cache.ts";
import type { ConversionResult } from "./converter-contract.ts";
import { BLANK_DIAGRAM_XML, diagramEntriesOf, normalisedXml, pngSizeOf } from "./diagram-flow.ts";
import { INITIAL_DIAGRAM_STATE, canSave, reduceDiagram, type DiagramEvent, type DiagramState } from "./diagram-state.ts";
import type { DiagramModel } from "./diagram-wire.ts";
import type { DiagramApi } from "./drive-api.ts";
import { conversionForInsert, linkInsertedDiagramsBestEffort } from "./insert-flow.ts";
import { SURFACE_BUDGET_BYTES } from "./surface-budget.ts";
import { parseDrawioSource, diagramIdForSource } from "../../converter/drawio-diagram.ts";

const MODEL: DiagramModel = {
  presentationId: "deckBBBBBBBBBBBBBBBB",
  pageSize: { width: 9_144_000, height: 5_143_500 },
  slideObjectIds: ["p1", "p2"],
  pictures: [
    { pageObjectId: "p1", objectId: "first", description: "drawio:dgfirst", linkUrl: null, slideNumber: 1, widthEmu: 1, heightEmu: 1 },
    { pageObjectId: "p2", objectId: "second", description: null, linkUrl: "https://drive.google.com/file/d/fileSecond0001/view", slideNumber: 2, widthEmu: 1, heightEmu: 1 },
    { pageObjectId: "p2", objectId: "photo", description: "a photo", linkUrl: null, slideNumber: 2, widthEmu: 1, heightEmu: 1 },
  ],
  selection: { pageObjectId: "p2", objectIds: ["second"] },
  folder: null,
};

test("the deck's diagrams: stamped or linked pictures only, the SELECTED one first", () => {
  const entries = diagramEntriesOf(MODEL);
  assert.deepEqual(entries.map((entry) => [entry.key, entry.selected]), [["file:fileSecond0001", true], ["diagram:dgfirst", false]]);
});

test("the dialog's states: open, save once at a time, saved keeps the editor on the saved file, close waits for a running save", () => {
  const run = (events: readonly DiagramEvent[]): DiagramState => events.reduce(reduceDiagram, INITIAL_DIAGRAM_STATE);
  const seeded = run([{ kind: "seeded", seed: { model: MODEL, selectedSource: { kind: "read", fileId: "fileSecond0001", name: "a.drawio", parentFolderIds: [], xml: "<mxfile/>" } } }]);
  assert.equal(seeded.sources.size, 1, "the seed's selected source is kept");
  const editing = run([
    { kind: "seeded", seed: { model: MODEL, selectedSource: null } },
    { kind: "edit-opened", target: { kind: "existing", entryKey: "file:fileSecond0001", editedObjectId: "second" }, seedXml: "<mxfile/>" },
    { kind: "editor-ready" },
  ]);
  assert.ok(editing.view.kind === "editing" && editing.view.status === "ready" && canSave(editing));
  const saving = reduceDiagram(editing, { kind: "save-started", exitAfterSave: false });
  assert.equal(canSave(saving), false);
  assert.equal(reduceDiagram(saving, { kind: "save-started", exitAfterSave: true }), saving, "a second Save while one runs is ignored");
  const closing = reduceDiagram(saving, { kind: "editor-closed" });
  assert.ok(closing.view.kind === "editing" && closing.view.exitAfterSave, "closing during a save waits for it");
  const target = { kind: "existing" as const, entryKey: "file:newFile000001", editedObjectId: "second" };
  const savedOpen = reduceDiagram(saving, { kind: "saved", model: MODEL, source: { kind: "read", fileId: "newFile000001", name: "x.drawio", parentFolderIds: [], xml: "<mxfile/>" }, target, text: "Saved" });
  assert.ok(savedOpen.view.kind === "editing" && savedOpen.view.status === "ready");
  assert.deepEqual(savedOpen.view.kind === "editing" ? savedOpen.view.target : null, target, "a copy-on-write save re-targets the editor to the new file");
  assert.ok(savedOpen.sources.has("newFile000001"));
  const savedClosed = reduceDiagram(closing, { kind: "saved", model: MODEL, source: { kind: "read", fileId: "newFile000001", name: "x.drawio", parentFolderIds: [], xml: "<mxfile/>" }, target, text: "Saved" });
  assert.equal(savedClosed.view.kind, "list");
  const failed = reduceDiagram(saving, { kind: "save-failed", text: "quota" });
  assert.ok(failed.view.kind === "editing" && failed.view.status === "ready" && failed.notice?.tone === "error");
});

test("ids and versions hash the NORMALISED source, the connector's form", () => {
  const model = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';
  const parsed = parseDrawioSource(model);
  assert.ok(parsed.kind === "ok");
  assert.equal(normalisedXml(model), parsed.xml);
  assert.equal(normalisedXml(`  ${BLANK_DIAGRAM_XML}\n`), BLANK_DIAGRAM_XML);
  assert.equal(diagramIdForSource(normalisedXml(model)), diagramIdForSource(parsed.xml));
});

test("a PNG's size is read from its header; anything else is not a PNG", () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, 1280);
  new DataView(bytes.buffer).setUint32(20, 720);
  assert.deepEqual(pngSizeOf(bytes), { width: 1280, height: 720 });
  assert.equal(pngSizeOf(new TextEncoder().encode("<svg/>")), null);
});

const DIAGRAM: ConvertedDiagram = { objectId: "p_1_2_picture", diagramId: "dgabc", version: "0123abcd", xml: "<mxfile/>" };
const PREVIEW: ConversionResult = {
  requests: [
    { createShape: { objectId: "p_1_2_shape", elementProperties: { pageObjectId: "sashaprev_2_p_1_2" } } },
    { createImage: { objectId: "p_1_2_picture", url: "https://example.com/a.png", elementProperties: { pageObjectId: "sashaprev_2_p_1_2" } } },
  ],
  unsupported: [],
  drawioDiagrams: [DIAGRAM, { ...DIAGRAM, objectId: "not_in_requests" }],
};

test("AN INSERT REUSING THE PREVIEW reports its diagrams under the ids they get in the deck", async () => {
  const chosen = await conversionForInsert({ preview: PREVIEW, previewPageObjectId: "sashaprev_2_p_1_2", pageObjectId: "sasha_new", convert: () => Promise.reject(new Error("not converted again")) });
  const renamedPicture = (chosen.requests[1]?.["createImage"] as Readonly<{ objectId: string }> | undefined)?.objectId;
  assert.equal(chosen.reused, true);
  assert.deepEqual(chosen.diagrams, [{ ...DIAGRAM, objectId: renamedPicture }], "renamed with the picture, and a diagram with no picture is dropped");
  const fresh = await conversionForInsert({ preview: null, previewPageObjectId: "x", pageObjectId: "sasha_new", convert: () => Promise.resolve({ ...PREVIEW, drawioDiagrams: [DIAGRAM] }) });
  assert.deepEqual(fresh.diagrams, [DIAGRAM]);
});

test("LINKING AN INSERT'S DIAGRAMS NEVER FAILS THE INSERT: a refusal or a throw is a warning", async () => {
  const warnings: string[] = [];
  const api = (linkInserted: DiagramApi["linkInserted"]): DiagramApi => ({ save: () => Promise.reject(new Error("unused")), readSources: () => Promise.reject(new Error("unused")), linkInserted });
  const spec = { presentationId: "deck", folderPath: [], fileMimeType: "x", entries: [], requests: [], fileAddress: { prefix: "", suffix: "" } };
  assert.equal(await linkInsertedDiagramsBestEffort({ diagramsApi: api(() => Promise.resolve({ kind: "failed", message: "quota" })), spec, warn: (message) => warnings.push(message) }), null);
  assert.equal(await linkInsertedDiagramsBestEffort({ diagramsApi: api(() => Promise.reject(new Error("boom"))), spec, warn: (message) => warnings.push(message) }), null);
  let called = false;
  assert.equal(await linkInsertedDiagramsBestEffort({ diagramsApi: api(() => { called = true; return Promise.resolve({ kind: "ok", value: { folderId: "f", links: [] } }); }), spec: null, warn: (message) => warnings.push(message) }), null);
  assert.equal(called, false, "no diagrams, no server call");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /quota/);
});

test("the conversion cache keeps an insert's diagrams", () => {
  const items = new Map<string, string>();
  const store = {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  } satisfies Storage;
  rememberConversion("sashaSlides.conversion.k", PREVIEW, store);
  assert.deepEqual(cachedConversion("sashaSlides.conversion.k", store)?.drawioDiagrams, PREVIEW.drawioDiagrams);
  rememberConversion("sashaSlides.conversion.none", { requests: [], unsupported: [] }, store);
  assert.equal(cachedConversion("sashaSlides.conversion.none", store)?.drawioDiagrams, undefined);
});

test("Diagram.html stays inside the HtmlService page budget and carries no converter", async () => {
  const bundled = await build({
    entryPoints: [new URL("./diagram.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react-dom/client": "preact/compat/client", "react/jsx-runtime": "preact/jsx-runtime" },
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', __SASHA_EDITOR_ORIGIN__: '"https://sashaslides.com"' },
  });
  const script = bundled.outputFiles[0]?.text ?? "";
  assert.ok(script.length + 1024 < SURFACE_BUDGET_BYTES, `Diagram.html would be about ${script.length + 1024} bytes`);
  assert.ok(script.length < 120 * 1024, `the dialog is a list and a frame; ${script.length} bytes means something heavy was pulled in`);
  assert.doesNotMatch(script, /extractSlideLayout|__SASHA_EXTRACTOR_JS_B64__/, "the converter is not bundled");
});
