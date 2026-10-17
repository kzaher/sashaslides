// DRAW.IO DIAGRAMS through the connector: a diagram as a propose_slides candidate, its source
// pre-written to the person's Drive, and deck_diagrams list / read / write with copy-on-write.
// Everything runs against the in-memory Drive and Slides fakes, and the tools are also driven
// through a real MCP Client so the registration and the wire payloads are what is asserted.
//
//   cd mcp/sasha-slides && npx tsx --test test/diagram-tools.test.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  DRAWIO_FILE_MEDIA_TYPE,
  diagramIdForSource,
  diagramVersionOf,
  drawioAltText,
  driveFileAddress,
  editableSvg,
} from "../converter/drawio-diagram.ts";
import {
  diagramRequestFrom,
  diagramSourcesInHtml,
  ensureFolderPath,
  listDeckDiagrams,
  presentationIdOf,
  readDeckDiagram,
  writeDeckDiagram,
  writeDiagramSources,
  type DiagramDeckEnvironment,
} from "../diagram-tools.ts";
import type { SlidePicture } from "../feedback/feedback-channel";
import type { ProposalEnvironment } from "../proposal";
import { createSashaSlidesServer, diagramFilesFor, slideSourcesFrom } from "../server";
import { createFakeComments, type FakeComments } from "./fake-comments";
import { createFakeDrive, type FakeDrive } from "./fake-drive";

const DECK = "deckAAAAAAAAAAAA";
const OTHER_DECK = "deckBBBBBBBBBBBB";
const XML_A = '<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
const XML_B = '<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
const MODEL_ONLY = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';

/** A PNG draw.io exported with "Include a copy of my diagram": the source in a `tEXt` chunk keyed `mxfile`. */
function drawioPng(xml: string): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out; // the reader never checks the CRC, so it is left zero
  };
  const text = new TextEncoder().encode(`mxfile\0${encodeURIComponent(xml)}`);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", new Uint8Array(13)), chunk("tEXt", text), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function filesOnDisk(files: Readonly<Record<string, Uint8Array | string>>): (path: string) => Uint8Array | null {
  return (path) => {
    const body = files[path];
    if (body === undefined) return null;
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
  };
}

describe("a draw.io diagram as a propose_slides candidate", () => {
  test("drawio XML becomes a whole candidate slide with a pending placeholder and the source script", () => {
    const parsed = slideSourcesFrom({ slides: [{ drawio: XML_A, title: "Pipeline", label: "diagram" }], remote: true });
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const [source] = parsed.sources;
    assert.ok(source !== undefined && "html" in source);
    if (source === undefined || !("html" in source)) return;
    assert.match(source.html, /data-drawio-render="pending"/);
    assert.match(source.html, /<script type="application\/vnd\.drawio\+xml" id="drawio-source">/);
    assert.match(source.html, /Pipeline/);
    assert.equal(source.label, "diagram");
    assert.deepEqual(parsed.diagrams, [XML_A]);
  });

  test("a bare <mxGraphModel> is wrapped into an <mxfile>", () => {
    const parsed = slideSourcesFrom({ slides: [{ drawio: MODEL_ONLY }], remote: false });
    assert.equal(parsed.kind === "ok" ? parsed.diagrams[0]?.startsWith("<mxfile>") : parsed.kind, true);
  });

  test("drawioPath reads .drawio, .drawio.svg and .drawio.png files to the same source", () => {
    const readBytes = filesOnDisk({
      "/d/a.drawio": XML_A,
      "/d/a.drawio.svg": editableSvg({ xml: XML_A, baseSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' }),
      "/d/a.drawio.png": drawioPng(XML_A),
      "/d/a.xml": MODEL_ONLY,
    });
    for (const path of ["/d/a.drawio", "/d/a.drawio.svg", "/d/a.drawio.png"]) {
      const parsed = slideSourcesFrom({ slides: [{ drawioPath: path }], remote: false, readBytes });
      assert.deepEqual(parsed.kind === "ok" ? parsed.diagrams : parsed, [XML_A], path);
    }
    assert.equal(slideSourcesFrom({ slides: [{ drawioPath: "/d/a.xml" }], remote: false, readBytes }).kind, "ok");
  });

  test("invalid input is refused with the slide's number and why", () => {
    const readBytes = filesOnDisk({ "/d/plain.png": drawioPng("").slice(0, 33), "/d/x.drawio": "<html></html>" });
    const cases: readonly Readonly<{ slide: Parameters<typeof slideSourcesFrom>[0]["slides"][number]; remote: boolean; pattern: RegExp }>[] = [
      { slide: { drawio: "<html><body>no</body></html>" }, remote: false, pattern: /slide 1: not draw\.io XML/ },
      { slide: { drawio: "<mxfile><diagram>" }, remote: false, pattern: /not closed/ },
      { slide: { drawioPath: "/d/x.drawio" }, remote: false, pattern: /not draw\.io XML/ },
      { slide: { drawioPath: "/d/missing.drawio" }, remote: false, pattern: /not a readable file/ },
      { slide: { drawioPath: "/d/plain.png" }, remote: false, pattern: /carries no draw\.io source/ },
      { slide: { drawioPath: "/d/a.pdf" }, remote: false, pattern: /must end in/ },
      { slide: { drawioPath: "/d/a.drawio" }, remote: true, pattern: /runs remotely/ },
      { slide: { drawio: XML_A, html: "<html></html>" }, remote: false, pattern: /exactly one of/ },
      { slide: { drawio: XML_A, path: "/a.html" }, remote: false, pattern: /exactly one of/ },
      { slide: { html: "<html></html>", title: "T" }, remote: false, pattern: /title.*drawio slide/ },
    ];
    for (const { slide, remote, pattern } of cases) {
      const parsed = slideSourcesFrom({ slides: [slide], remote, readBytes });
      assert.equal(parsed.kind, "error", JSON.stringify(slide));
      assert.match(parsed.kind === "error" ? parsed.message : "", pattern);
    }
  });

  test("an inline HTML candidate's #drawio-source script is found and normalised; a path is never opened", () => {
    const html = `<html><body><svg data-drawio></svg><script id="drawio-source" type="application/vnd.drawio+xml">${MODEL_ONLY}</script></body></html>`;
    const parsed = slideSourcesFrom({
      slides: [{ html }, { path: "/never/opened.html" }],
      remote: false,
      readBytes: () => assert.fail("a slide path must never be read"),
    });
    assert.equal(parsed.kind, "ok");
    assert.equal(parsed.kind === "ok" ? parsed.diagrams.length : 0, 1);
    assert.deepEqual(diagramSourcesInHtml("<script type=\"application/json\">{}</script>"), []);
  });
});

describe("pre-writing diagram sources to the person's Drive", () => {
  test("creates sasha_slides/slide/<deck>/drawio/<id>.drawio, then reuses folders and the file", async () => {
    const fake = createFakeDrive({ idPrefix: "driveFile-" });
    const first = await writeDiagramSources({ drive: fake.channel, presentationId: DECK, sources: [XML_A, XML_A] });
    assert.deepEqual(first.warnings, []);
    assert.equal(first.files.length, 1, "the same diagram twice is one file");
    assert.equal(first.files[0]?.file, "created");
    const name = `${diagramIdForSource(XML_A)}.drawio`;
    const file = fake.find({ name });
    assert.equal(file?.text, XML_A);
    assert.equal(file?.mimeType, DRAWIO_FILE_MEDIA_TYPE);
    assert.deepEqual(folderPathOf({ fake, fileId: file?.id ?? "" }), ["sasha_slides", "slide", DECK, "drawio"]);

    const second = await writeDiagramSources({ drive: fake.channel, presentationId: DECK, sources: [XML_A] });
    assert.equal(second.files[0]?.file, "unchanged");
    assert.equal(fake.files().filter((candidate) => candidate.name === "sasha_slides").length, 1, "no duplicate folder tree");
  });

  test("an edited file of the same name is never overwritten", async () => {
    const fake = createFakeDrive({ idPrefix: "driveFile-" });
    const written = await writeDiagramSources({ drive: fake.channel, presentationId: DECK, sources: [XML_A] });
    const fileId = written.files[0]?.fileId ?? "";
    fake.editAsAnotherApp({ fileId, name: `${diagramIdForSource(XML_A)}.drawio`, text: XML_B });
    const again = await writeDiagramSources({ drive: fake.channel, presentationId: DECK, sources: [XML_A] });
    assert.equal(again.files[0]?.file, "kept");
    assert.match(again.warnings.join(), /edited version/);
    assert.equal(fake.files().find((candidate) => candidate.id === fileId)?.text, XML_B);
  });

  test("best-effort: no deck id, or a Drive failure, is a warning and never a throw", async () => {
    const fake = createFakeDrive({ idPrefix: "driveFile-" });
    const noDeck = await diagramFilesFor({ drive: fake.channel, presentationId: null, sources: [XML_A] });
    assert.match(noDeck.diagramWarnings.join(), /no presentationId/);
    const failing = await diagramFilesFor({
      drive: { ...fake.channel, createFolder: () => Promise.reject(new Error("503 from Drive")) },
      presentationId: DECK,
      sources: [XML_A],
    });
    assert.match(failing.diagramWarnings.join(), /503 from Drive/);
    assert.deepEqual(failing.diagrams, []);
  });

  test("through propose_slides: the proposal is staged AND the diagram file is written", async () => {
    const harness = await connect({});
    try {
      const answer = await harness.call("propose_slides", { slides: [{ drawio: XML_A, label: "flow" }], presentationId: DECK });
      assert.equal(answer.isError, undefined, answer.text);
      const payload = JSON.parse(answer.text) as { count: number; diagrams: { diagramId: string; file: string }[] };
      assert.equal(payload.count, 1);
      assert.deepEqual(payload.diagrams.map((diagram) => [diagram.diagramId, diagram.file]), [[diagramIdForSource(XML_A), "created"]]);
      assert.ok(harness.drive.find({ name: "01.html" }) !== null || harness.drive.files().some((file) => file.name.endsWith(".html")));
    } finally {
      await harness.close();
    }
  });
});

describe("deck_diagrams", () => {
  test("list: slide, ids, readability, the deck folder and staleness", async () => {
    const world = await deckWorld();
    const listed = await listDeckDiagrams({ env: world.env, presentationId: DECK });
    assert.equal(listed.kind, "payload");
    if (listed.kind !== "payload") return;
    const byObject = new Map(listed.payload.diagrams.map((entry) => [entry.objectId, entry]));
    assert.deepEqual(pick(byObject.get("pic_fresh")), { slideNumber: 1, diagramId: world.idA, readable: true, inThisDeckFolder: true, stale: false });
    assert.deepEqual(pick(byObject.get("pic_stale")), { slideNumber: 2, diagramId: world.idA, readable: true, inThisDeckFolder: true, stale: true });
    assert.deepEqual(pick(byObject.get("pic_addon")), { slideNumber: 2, diagramId: "dgaddon01", readable: false, inThisDeckFolder: false, stale: null });
    assert.equal(byObject.has("pic_photo"), false, "a picture with no stamp and no diagram link is not a diagram");
    assert.equal(listed.payload.folder, `sasha_slides/slide/${DECK}/drawio`);
  });

  test("read: the local connector gets a PATH, the remote one inline XML", async () => {
    const world = await deckWorld();
    const local = await readDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "object-id", objectId: "pic_fresh" } });
    assert.equal(local.kind === "payload" ? local.payload.status : local.kind, "ok");
    if (local.kind !== "payload" || local.payload.status !== "ok") return;
    assert.equal(local.payload.xml, undefined, "no XML crosses into the conversation locally");
    assert.equal(world.saved.get(local.payload.path ?? ""), XML_A);
    const remote = await readDeckDiagram({ env: { ...world.env, remote: true }, presentationId: DECK, target: { kind: "diagram-id", diagramId: world.idA } });
    assert.equal(remote.kind === "payload" && remote.payload.status === "ok" ? remote.payload.xml : null, XML_A);
  });

  test("read: a source the add-on created is not-readable, with why and what to do", async () => {
    const world = await deckWorld();
    const read = await readDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "diagram-id", diagramId: "dgaddon01" } });
    assert.equal(read.kind, "payload");
    if (read.kind !== "payload" || read.payload.status === "ok") return assert.fail("expected not-readable");
    assert.equal(read.payload.status, "not-readable");
    assert.match(read.payload.reason, /drive\.file/);
    assert.match(read.payload.whatToDo, /Edit diagram/);
    const unknown = await readDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "object-id", objectId: "nope" } });
    assert.equal(unknown.kind, "error");
  });

  test("write in this deck's own folder: updated in place, links untouched, version stamps NOT changed", async () => {
    const world = await deckWorld();
    const written = await writeDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "diagram-id", diagramId: world.idA }, xml: XML_B });
    assert.equal(written.kind, "payload");
    if (written.kind !== "payload") return;
    assert.equal(written.payload.file, "updated-in-place");
    assert.equal(written.payload.fileId, world.fileA);
    assert.deepEqual([...written.payload.pictures.map((picture) => picture.objectId)].sort(), ["pic_fresh", "pic_stale"]);
    assert.equal(written.payload.stale, true);
    assert.match(written.payload.next, /Edit diagram/);
    assert.equal(world.drive.files().find((file) => file.id === world.fileA)?.text, XML_B);
    assert.deepEqual(world.slides.presentationUpdates(), [], "nothing to re-link: every picture already points at the file");
  });

  test("COPY-ON-WRITE across documents: a copy in THIS deck's folder, references re-pointed, the other deck's file untouched", async () => {
    const world = await deckWorld();
    const written = await writeDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "object-id", objectId: "pic_copied" }, xml: XML_B });
    assert.equal(written.kind, "payload");
    if (written.kind !== "payload") return;
    assert.equal(written.payload.file, "copied-into-this-deck");
    assert.equal(written.payload.copiedFromFileId, world.otherDeckFile);
    assert.notEqual(written.payload.fileId, world.otherDeckFile);
    // The copy is in THIS deck's folder; the source keeps its body and its folder.
    assert.deepEqual(folderPathOf({ fake: world.drive, fileId: written.payload.fileId }), ["sasha_slides", "slide", DECK, "drawio"]);
    assert.equal(world.drive.files().find((file) => file.id === written.payload.fileId)?.text, XML_B);
    assert.equal(world.drive.files().find((file) => file.id === world.otherDeckFile)?.text, XML_A);
    assert.deepEqual(folderPathOf({ fake: world.drive, fileId: world.otherDeckFile }), ["sasha_slides", "slide", OTHER_DECK, "drawio"]);
    // EVERY picture here that showed the other deck's file now links to the copy; the stamp keeps its version.
    const pictures = new Map(world.slides.deckPictures().map((picture) => [picture.objectId, picture]));
    for (const objectId of ["pic_copied", "pic_copied_twin"]) {
      assert.equal(pictures.get(objectId)?.linkUrl, driveFileAddress(written.payload.fileId), objectId);
      assert.match(pictures.get(objectId)?.description ?? "", new RegExp(`;v=${diagramVersionOf(XML_A)}`), "the picture still shows the old version");
    }
    assert.equal(pictures.get("pic_fresh")?.linkUrl, driveFileAddress(world.fileA), "other diagrams are untouched");
  });

  test("a copy never takes the name of a different diagram already in this deck's folder", async () => {
    const world = await deckWorld();
    // The other deck's diagram has the SAME id as this deck's own diagram A (it was copied from here once).
    const written = await writeDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "object-id", objectId: "pic_same_id" }, xml: XML_B });
    assert.equal(written.kind === "payload" ? written.payload.diagramId : written.kind, `${world.idA}-2`);
    const picture = world.slides.deckPictures().find((candidate) => candidate.objectId === "pic_same_id");
    assert.match(picture?.description ?? "", new RegExp(`^drawio:${world.idA}-2;v=`));
    assert.equal(world.drive.files().find((file) => file.id === world.fileA)?.text, XML_A, "this deck's own diagram A is untouched");
  });

  test("a source the connector cannot read is copied, never written in place", async () => {
    const world = await deckWorld();
    const written = await writeDeckDiagram({ env: world.env, presentationId: DECK, target: { kind: "diagram-id", diagramId: "dgaddon01" }, xml: XML_B });
    assert.equal(written.kind === "payload" ? written.payload.file : written.kind, "copied-into-this-deck");
    assert.equal(world.drive.files().find((file) => file.id === world.addonFile)?.text, XML_A);
  });

  test("a Slides refusal is an error naming Google's reason", async () => {
    const world = await deckWorld();
    world.slides.setDeckPictures({ pictures: null });
    const listed = await listDeckDiagrams({ env: world.env, presentationId: DECK });
    assert.match(listed.kind === "error" ? listed.message : "", /would not return that deck/);
  });

  test("argument validation: each action takes exactly what it needs", () => {
    const readBytes = filesOnDisk({ "/d/a.drawio": XML_A });
    const ok = (args: Parameters<typeof diagramRequestFrom>[0]["args"], remote = false) => diagramRequestFrom({ args, remote, readBytes }).kind;
    assert.equal(ok({ action: "list", presentationId: DECK }), "ok");
    assert.equal(ok({ action: "list", presentationId: `https://docs.google.com/presentation/d/${DECK}/edit` }), "ok");
    assert.equal(ok({ action: "list", presentationId: "bad id!" }), "error");
    assert.equal(ok({ action: "list", presentationId: DECK, diagramId: "dg1" }), "error");
    assert.equal(ok({ action: "read", presentationId: DECK }), "error");
    assert.equal(ok({ action: "read", presentationId: DECK, diagramId: "dg1", objectId: "o" }), "error");
    assert.equal(ok({ action: "read", presentationId: DECK, diagramId: "../etc" }), "error");
    assert.equal(ok({ action: "read", presentationId: DECK, objectId: "o", xml: XML_A }), "error");
    assert.equal(ok({ action: "write", presentationId: DECK, objectId: "o" }), "error");
    assert.equal(ok({ action: "write", presentationId: DECK, objectId: "o", xml: "<nope/>" }), "error");
    assert.equal(ok({ action: "write", presentationId: DECK, objectId: "o", xml: XML_A }), "ok");
    assert.equal(ok({ action: "write", presentationId: DECK, objectId: "o", path: "/d/a.drawio" }), "ok");
    assert.equal(ok({ action: "write", presentationId: DECK, objectId: "o", path: "/d/a.drawio" }, true), "error");
    assert.equal(presentationIdOf(DECK), DECK);
  });

  test("through MCP: deck_diagrams is registered and answers list, read and write", async () => {
    const world = await deckWorld();
    const harness = await connect({ drive: world.drive, slides: world.slides });
    try {
      const tools = await harness.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "deck_diagrams"));
      const listed = await harness.call("deck_diagrams", { action: "list", presentationId: DECK });
      assert.equal((JSON.parse(listed.text) as { diagrams: unknown[] }).diagrams.length, 6);
      const read = await harness.call("deck_diagrams", { action: "read", presentationId: DECK, objectId: "pic_fresh" });
      const path = (JSON.parse(read.text) as { path: string }).path;
      assert.equal(readFileSync(path, "utf8"), XML_A, "the local connector wrote the XML to a file");
      const written = await harness.call("deck_diagrams", { action: "write", presentationId: DECK, objectId: "pic_copied", xml: XML_B });
      assert.equal((JSON.parse(written.text) as { file: string }).file, "copied-into-this-deck");
      const refused = await harness.call("deck_diagrams", { action: "read", presentationId: DECK });
      assert.equal(refused.isError, true);
    } finally {
      await harness.close();
    }
  });
});

/* ------------------------------------------------------------------ fixtures */

type DeckWorld = Readonly<{
  env: DiagramDeckEnvironment;
  drive: FakeDrive;
  slides: FakeComments;
  saved: Map<string, string>;
  idA: string;
  fileA: string;
  otherDeckFile: string;
  addonFile: string;
}>;

/**
 * This deck holds: diagram A (its own folder; one fresh picture and one older one), a picture copied
 * from OTHER_DECK (twice) whose source sits in that deck's folder, a picture copied from OTHER_DECK
 * whose diagram id collides with A, a diagram the add-on created (unreadable here) and a plain photo.
 */
async function deckWorld(): Promise<DeckWorld> {
  const drive = createFakeDrive({ idPrefix: "driveFile-" });
  const idA = diagramIdForSource(XML_A);
  const ownFolder = await ensureFolderPath({ drive: drive.channel, path: ["sasha_slides", "slide", DECK, "drawio"] });
  const otherFolder = await ensureFolderPath({ drive: drive.channel, path: ["sasha_slides", "slide", OTHER_DECK, "drawio"] });
  const fileA = (await drive.channel.createFile({ name: `${idA}.drawio`, parentId: ownFolder, mimeType: DRAWIO_FILE_MEDIA_TYPE, media: { kind: "text", text: XML_A }, appProperties: {} })).id;
  const otherDeckFile = (await drive.channel.createFile({ name: "dgother01.drawio", parentId: otherFolder, mimeType: DRAWIO_FILE_MEDIA_TYPE, media: { kind: "text", text: XML_A }, appProperties: {} })).id;
  const sameIdFile = (await drive.channel.createFile({ name: `${idA}.drawio`, parentId: otherFolder, mimeType: DRAWIO_FILE_MEDIA_TYPE, media: { kind: "text", text: XML_A }, appProperties: {} })).id;
  const addonFile = drive.putUnreadableFile({ name: "dgaddon01.drawio", parentId: null, text: XML_A }).id;
  const versionA = diagramVersionOf(XML_A);
  const picture = (options: Readonly<{ objectId: string; slideNumber: number; stamp: string | null; fileId: string | null }>): SlidePicture => ({
    pageObjectId: `slide_${String(options.slideNumber)}`,
    slideNumber: options.slideNumber,
    objectId: options.objectId,
    description: options.stamp,
    linkUrl: options.fileId === null ? null : driveFileAddress(options.fileId),
  });
  const slides = createFakeComments({ now: () => new Date("2026-10-17T12:00:00.000Z"), pageObjectIds: ["slide_1", "slide_2", "slide_3"], defaultFileId: DECK });
  slides.setDeckPictures({
    pictures: [
      picture({ objectId: "pic_fresh", slideNumber: 1, stamp: drawioAltText({ diagramId: idA, version: versionA }), fileId: fileA }),
      picture({ objectId: "pic_stale", slideNumber: 2, stamp: drawioAltText({ diagramId: idA, version: "00000000" }), fileId: fileA }),
      picture({ objectId: "pic_addon", slideNumber: 2, stamp: drawioAltText({ diagramId: "dgaddon01", version: versionA }), fileId: addonFile }),
      picture({ objectId: "pic_copied", slideNumber: 3, stamp: drawioAltText({ diagramId: "dgother01", version: versionA }), fileId: otherDeckFile }),
      picture({ objectId: "pic_copied_twin", slideNumber: 3, stamp: drawioAltText({ diagramId: "dgother01", version: versionA }), fileId: otherDeckFile }),
      picture({ objectId: "pic_same_id", slideNumber: 3, stamp: drawioAltText({ diagramId: idA, version: versionA }), fileId: sameIdFile }),
      picture({ objectId: "pic_photo", slideNumber: 1, stamp: "team photo", fileId: null }),
    ],
  });
  const saved = new Map<string, string>();
  const env: DiagramDeckEnvironment = {
    drive: drive.channel,
    slides: slides.channel,
    remote: false,
    saveLocalCopy: ({ presentationId, diagramId, xml }) => {
      const path = `/tmp/fake/${presentationId}/${diagramId}.drawio`;
      saved.set(path, xml);
      return path;
    },
  };
  return { env, drive, slides, saved, idA, fileA, otherDeckFile, addonFile };
}

function pick(entry: Readonly<{ slideNumber: number; diagramId: string | null; readable: boolean; inThisDeckFolder: boolean; stale: boolean | null }> | undefined) {
  if (entry === undefined) return null;
  return { slideNumber: entry.slideNumber, diagramId: entry.diagramId, readable: entry.readable, inThisDeckFolder: entry.inThisDeckFolder, stale: entry.stale };
}

/** Folder names from the root down to the folder holding `fileId`. */
function folderPathOf(options: Readonly<{ fake: FakeDrive; fileId: string }>): readonly string[] {
  const byId = new Map(options.fake.files().map((file) => [file.id, file]));
  const names: string[] = [];
  let parentId = byId.get(options.fileId)?.parentId ?? null;
  while (parentId !== null) {
    const folder = byId.get(parentId);
    if (folder === undefined) break;
    names.unshift(folder.name);
    parentId = folder.parentId;
  }
  return names;
}

/** A real Client on an in-memory transport to a server whose Drive and Slides are the fakes. */
async function connect(options: Readonly<{ drive?: FakeDrive; slides?: FakeComments }>): Promise<
  Readonly<{
    client: Client;
    drive: FakeDrive;
    call: (name: string, args: Record<string, unknown>) => Promise<Readonly<{ text: string; isError: boolean | undefined }>>;
    close: () => Promise<void>;
  }>
> {
  const drive = options.drive ?? createFakeDrive({ idPrefix: "driveFile-" });
  const slides = options.slides ?? createFakeComments({ now: () => new Date(), pageObjectIds: [], defaultFileId: DECK });
  const env: ProposalEnvironment = {
    drive: drive.channel,
    now: () => new Date("2026-10-17T12:00:00.000Z"),
    randomSuffix: () => "aaa111",
    sleep: () => Promise.resolve(),
    statFile: () => ({ bytes: 2048 }),
    warn: () => undefined,
  };
  const server = createSashaSlidesServer({
    resolveEnvironment: () => Promise.resolve({ kind: "ok", env }),
    resolveFeedbackEnvironment: () =>
      Promise.resolve({ kind: "ok", env: { channel: slides.channel, now: () => new Date(), sleep: () => Promise.resolve(), warn: () => undefined } }),
    instructions: "test",
    remote: false,
  });
  const client = new Client({ name: "diagram-tools-test", version: "1.0.0" }, { capabilities: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    client,
    drive,
    call: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? (result.content as readonly Readonly<{ type: string; text?: string }>[]) : [];
      return { text: content.map((part) => part.text ?? "").join(""), isError: result.isError === true ? true : undefined };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
