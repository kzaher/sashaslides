// The diagram dialog's Drive and Slides work, end to end against a fake Drive: the plan the dialog
// computes (diagram-flow.ts, converter/drawio-save-plan.ts) executed by the code Code.gs embeds
// (diagram-host.ts). The headline case is the user's rule: a diagram whose file lives under ANOTHER
// deck's folder is copied into this deck's folder on save, every reference here is re-pointed, and
// the other deck's file is left byte-identical.

import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramFolderPath, diagramVersionOf, driveFileAddress, driveFileIdOfAddress, drawioAltText } from "../../converter/drawio-diagram.ts";
import type { ConvertedDiagram } from "../../converter/convert-html-to-slide-requests.ts";
import { codeGs, DEFAULT_EDITOR_ORIGIN } from "./apps-script-project.ts";
import { SERVER_FUNCTION_NAMES } from "./bridge.ts";
import { DIAGRAM_MENU_ITEM } from "./diagram-code-gs.ts";
import { diagramEntriesOf, editSaveSpec, insertedDiagramLinkSpec, newDiagramSaveSpec, refreshSaveSpec, staleEntriesOf } from "./diagram-flow.ts";
import { diagramBootOf, executeDiagramLinks, executeDiagramSave, readDiagramSources, walkFolderPaths, type RawDeck } from "./diagram-host.ts";
import { parseDiagramSeed, parseDiagramSourcesReply, type DiagramModel, type DiagramSourceRead } from "./diagram-wire.ts";
import { fakeDiagramDrive, type FakeDiagramDrive } from "./fake-diagram-drive.ts";

const DECK_A = "deckAAAAAAAAAAAAAAAA";
const DECK_B = "deckBBBBBBBBBBBBBBBB";
const XML_ONE = '<mxfile><diagram id="p" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="one" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>';
const XML_TWO = XML_ONE.replace('value="one"', 'value="two"');
const PNG = pngDataUrl({ width: 600, height: 300 });

test("every function Code.gs embeds runs from its own source text, with nothing else in scope", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const embeddedWalk = embedded(walkFolderPaths);
  assert.deepEqual(embeddedWalk({ names: ["a", "b"], create: false, folders: { findChildFolders: () => [], createChildFolder: () => "x" } }), []);
  const embeddedRead = embedded(readDiagramSources);
  assert.equal(embeddedRead({ fileIds: ["missing0000000"], drive: fake.drive }).files[0]?.error?.includes("File not found"), true);
  for (const source of [diagramBootOf, executeDiagramSave, executeDiagramLinks].map((fn) => fn.toString())) {
    assert.doesNotMatch(source, /__name|\?\.|\?\?|catch \{|require\(|import\(/, "no helper, no import and no syntax newer than Code.gs's own");
  }
});

test("COPY ON WRITE ACROSS DOCUMENTS: a diagram under deck A, edited in deck B, becomes a new file in B's folder", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderA = fake.folderAt(diagramFolderPath(DECK_A));
  const fileA = fake.putFile({ folderId: folderA, name: "dgshared.drawio", text: XML_ONE });
  const before = fake.nodes.get(fileA)?.text;
  // Deck B: two pictures of the diagram (a slide was copied between decks, then duplicated) and one other picture.
  const stamp = drawioAltText({ diagramId: "dgshared", version: diagramVersionOf(XML_ONE) });
  const model = modelOf({
    presentationId: DECK_B,
    pictures: [
      { pageObjectId: "p1", objectId: "pictureOne", description: stamp, linkUrl: driveFileAddress(fileA) },
      { pageObjectId: "p2", objectId: "pictureTwo", description: stamp, linkUrl: driveFileAddress(fileA) },
      { pageObjectId: "p2", objectId: "photo", description: null, linkUrl: null },
    ],
    folder: null,
  });
  const entry = diagramEntriesOf(model)[0];
  assert.ok(entry !== undefined);
  const source = sourceRead({ fake, fileId: fileA });
  const planned = editSaveSpec({ model, entry, source, xml: XML_TWO, pngDataUrl: PNG, editedObjectId: "pictureOne" });
  assert.equal(planned.kind, "ready");
  if (planned.kind !== "ready") return;
  assert.equal(planned.value.spec.file.kind, "create");

  const reply = executeDiagramSave({ spec: planned.value.spec, drive: fake.drive });

  assert.equal(reply.created, true);
  assert.notEqual(reply.fileId, fileA);
  const folderB = fake.drive.findFolderPaths(diagramFolderPath(DECK_B))[0];
  assert.ok(folderB !== undefined, "B's folder sasha_slides/slide/<B>/drawio was created");
  assert.deepEqual(fake.filesIn(folderB).map((file) => [file.id, file.name, file.text]), [[reply.fileId, "dgshared.drawio", XML_TWO]]);
  assert.equal(fake.nodes.get(fileA)?.text, before, "deck A's file is byte-identical");
  assert.deepEqual(fake.nodes.get(fileA)?.parents, [folderA]);

  const batch = fake.batches[0];
  assert.ok(batch !== undefined && fake.batches.length === 1, "ONE batchUpdate");
  assert.equal(batch.presentationId, DECK_B);
  const text = JSON.stringify(batch.requests);
  assert.doesNotMatch(text, new RegExp(fileA), "no reference in B still points at A's file");
  assert.doesNotMatch(text, /staged\.sasha-slides\.invalid|sashaPendingDiagramFile/, "every placeholder was substituted");
  for (const objectId of ["pictureOne", "pictureTwo"]) {
    assert.ok(batch.requests.some((request) => JSON.stringify(request) === JSON.stringify({ replaceImage: { imageObjectId: objectId, url: `https://drive.google.com/uc?id=${stagedIdOf(fake)}`, imageReplaceMethod: "CENTER_INSIDE" } })), `${objectId} gets the new picture`);
    assert.ok(batch.requests.some((request) => JSON.stringify(request) === JSON.stringify({ updateImageProperties: { objectId, imageProperties: { link: { url: driveFileAddress(reply.fileId) } }, fields: "link" } })), `${objectId} links to B's copy`);
    assert.ok(batch.requests.some((request) => JSON.stringify(request) === JSON.stringify({ updatePageElementAltText: { objectId, description: drawioAltText({ diagramId: "dgshared", version: diagramVersionOf(XML_TWO) }) } })), `${objectId} is re-stamped`);
  }
  assert.doesNotMatch(text, /"photo"/, "an unrelated picture is untouched");
  assert.deepEqual(fake.deleted, [stagedIdOf(fake)], "the staged picture is deleted after the batch");
});

test("IN PLACE: a diagram whose file is already in this deck's folder is updated, not copied", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderB = fake.folderAt(diagramFolderPath(DECK_B));
  const fileB = fake.putFile({ folderId: folderB, name: "dgown.drawio", text: XML_ONE });
  const model = modelOf({
    presentationId: DECK_B,
    pictures: [{ pageObjectId: "p1", objectId: "pictureOne", description: "drawio:dgown", linkUrl: driveFileAddress(fileB) }],
    folder: { folderId: folderB, folderIds: [folderB], fileNames: ["dgown.drawio"] },
  });
  const entry = diagramEntriesOf(model)[0];
  assert.ok(entry !== undefined);
  const planned = editSaveSpec({ model, entry, source: sourceRead({ fake, fileId: fileB }), xml: XML_TWO, pngDataUrl: PNG, editedObjectId: "pictureOne" });
  assert.ok(planned.kind === "ready" && planned.value.spec.file.kind === "update");
  const reply = executeDiagramSave({ spec: planned.value.spec, drive: fake.drive });
  assert.equal(reply.fileId, fileB);
  assert.equal(reply.created, false);
  assert.equal(fake.nodes.get(fileB)?.text, XML_TWO);
  assert.equal(fake.filesIn(folderB).length, 1, "no copy");
});

test("IN PLACE across a SECOND same-named folder tree: the connector's own drawio folder is still this deck's", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  fake.folderAt(diagramFolderPath(DECK_B));
  const slideFolder = fake.drive.findFolderPaths(diagramFolderPath(DECK_B).slice(0, 3))[0] ?? null;
  const secondDrawio = fake.duplicateFolder({ parentId: slideFolder, name: "drawio" });
  const file = fake.putFile({ folderId: secondDrawio, name: "dgconn.drawio", text: XML_ONE });
  const boot = diagramBootOf({ presentationId: DECK_B, deck: deckOf([{ objectId: "pic", url: driveFileAddress(file) }]), selection: { pageObjectId: "p1", objectIds: ["pic"] }, drive: fake.drive });
  assert.equal(boot.folder?.folderIds.length, 2);
  assert.deepEqual(boot.folder?.fileNames, ["dgconn.drawio"]);
  const seed = parseDiagramSeed(JSON.stringify(boot));
  assert.ok(seed.kind === "ok");
  const entry = diagramEntriesOf(seed.value.model)[0];
  assert.ok(entry !== undefined);
  const planned = editSaveSpec({ model: seed.value.model, entry, source: seed.value.selectedSource, xml: XML_TWO, pngDataUrl: PNG, editedObjectId: "pic" });
  assert.ok(planned.kind === "ready" && planned.value.spec.file.kind === "update", "updated in place, not copied a second time");
  executeDiagramSave({ spec: planned.value.spec, drive: fake.drive });
  assert.equal(fake.nodes.get(file)?.text, XML_TWO);
});

test("NAME COLLISION: a copy whose name is taken in this deck's folder gets the next free name, and a name taken after the plan is refused", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderA = fake.folderAt(diagramFolderPath(DECK_A));
  const folderB = fake.folderAt(diagramFolderPath(DECK_B));
  const fileA = fake.putFile({ folderId: folderA, name: "dgsame.drawio", text: XML_ONE });
  const other = fake.putFile({ folderId: folderB, name: "dgsame.drawio", text: "<mxfile>a different diagram</mxfile>" });
  const model = modelOf({
    presentationId: DECK_B,
    pictures: [{ pageObjectId: "p1", objectId: "pic", description: "drawio:dgsame", linkUrl: driveFileAddress(fileA) }],
    folder: { folderId: folderB, folderIds: [folderB], fileNames: ["dgsame.drawio"] },
  });
  const entry = diagramEntriesOf(model)[0];
  assert.ok(entry !== undefined);
  const planned = editSaveSpec({ model, entry, source: sourceRead({ fake, fileId: fileA }), xml: XML_TWO, pngDataUrl: PNG, editedObjectId: "pic" });
  assert.ok(planned.kind === "ready" && planned.value.spec.file.kind === "create");
  assert.equal(planned.value.spec.file.fileName, "dgsame-2.drawio");
  executeDiagramSave({ spec: planned.value.spec, drive: fake.drive });
  assert.equal(fake.nodes.get(other)?.text, "<mxfile>a different diagram</mxfile>", "the other diagram is not overwritten");
  assert.match(JSON.stringify(fake.batches[0]?.requests), /drawio:dgsame-2;v=/);
  // The same plan run again: its name now exists, so it is refused, not overwritten.
  assert.throws(() => executeDiagramSave({ spec: planned.value.spec, drive: fake.drive }), /appeared in this presentation's diagram folder/);
});

test("an UPDATE of a file outside this deck's folder is refused by the executor, whatever the plan said", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderA = fake.folderAt(diagramFolderPath(DECK_A));
  fake.folderAt(diagramFolderPath(DECK_B));
  const fileA = fake.putFile({ folderId: folderA, name: "dgx.drawio", text: XML_ONE });
  const forged = { kind: "update" as const, fileId: fileA, deckFolderPath: diagramFolderPath(DECK_B) };
  const planned = editSaveSpec({
    model: modelOf({ presentationId: DECK_B, pictures: [{ pageObjectId: "p1", objectId: "pic", description: "drawio:dgx", linkUrl: driveFileAddress(fileA) }], folder: null }),
    entry: { key: `file:${fileA}`, fileId: fileA, stampedDiagramId: "dgx", pictures: [], selected: false },
    source: sourceRead({ fake, fileId: fileA }),
    xml: XML_TWO,
    pngDataUrl: PNG,
    editedObjectId: "pic",
  });
  assert.ok(planned.kind === "ready");
  assert.throws(() => executeDiagramSave({ spec: { ...planned.value.spec, file: forged }, drive: fake.drive }), /never modified in place/);
  assert.equal(fake.nodes.get(fileA)?.text, XML_ONE);
  assert.equal(fake.batches.length, 0);
});

test("a save for another presentation than the open one is refused before anything is written", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_A });
  const planned = newDiagramSaveSpec({ model: modelOf({ presentationId: DECK_B, pictures: [], folder: null }), xml: XML_ONE, pngDataUrl: PNG, objectId: "newpic00001" });
  assert.ok(planned.kind === "ready");
  assert.throws(() => executeDiagramSave({ spec: planned.value.spec, drive: fake.drive }), /another presentation/);
  assert.equal(fake.nodes.size, 0);
});

test("a refused batchUpdate removes the copy it created and the staged picture, so Drive is as it was", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const planned = newDiagramSaveSpec({ model: modelOf({ presentationId: DECK_B, pictures: [], folder: null }), xml: XML_ONE, pngDataUrl: PNG, objectId: "newpic00001" });
  assert.ok(planned.kind === "ready");
  fake.failNextBatch("Invalid requests[0].createImage");
  assert.throws(() => executeDiagramSave({ spec: planned.value.spec, drive: fake.drive }), /Invalid requests/);
  assert.deepEqual([...fake.nodes.values()].filter((node) => node.kind === "file"), []);
});

test("NEW DIAGRAM: one createImage on the selected slide, centred at its natural size, linked and stamped", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const model = { ...modelOf({ presentationId: DECK_B, pictures: [], folder: null }), slideObjectIds: ["p1", "p2"], selection: { pageObjectId: "p2", objectIds: [] } };
  const planned = newDiagramSaveSpec({ model, xml: XML_ONE, pngDataUrl: PNG, objectId: "newpic00001" });
  assert.ok(planned.kind === "ready");
  assert.equal(planned.value.pageObjectId, "p2");
  // 600x300 exported at scale 3 = 200x100 CSS pixels = 1,905,000 x 952,500 EMU, centred on the page.
  assert.deepEqual(planned.value.box, { x: 3_619_500, y: 2_095_500, width: 1_905_000, height: 952_500 });
  const reply = executeDiagramSave({ spec: planned.value.spec, drive: fake.drive });
  const requests = fake.batches[0]?.requests ?? [];
  assert.deepEqual(requests.map((request) => Object.keys(request)[0]), ["createImage", "updateImageProperties", "updatePageElementAltText"]);
  assert.match(JSON.stringify(requests), new RegExp(`/file/d/${reply.fileId}/view`));
});

test("UPDATE STALE PICTURES: a stamp older than its file is found, and the refresh replaces the pictures without touching the file", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderB = fake.folderAt(diagramFolderPath(DECK_B));
  const file = fake.putFile({ folderId: folderB, name: "dgold.drawio", text: XML_TWO });
  const model = modelOf({
    presentationId: DECK_B,
    pictures: [
      { pageObjectId: "p1", objectId: "old", description: drawioAltText({ diagramId: "dgold", version: diagramVersionOf(XML_ONE) }), linkUrl: driveFileAddress(file) },
      { pageObjectId: "p1", objectId: "unversioned", description: "drawio:dgold", linkUrl: driveFileAddress(file) },
    ],
    folder: { folderId: folderB, folderIds: [folderB], fileNames: ["dgold.drawio"] },
  });
  const sources = new Map<string, DiagramSourceRead>([[file, sourceRead({ fake, fileId: file })]]);
  const stale = staleEntriesOf({ entries: diagramEntriesOf(model), sources });
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0]?.stalePictures.map((picture) => picture.objectId), ["old"]);
  const found = stale[0];
  assert.ok(found !== undefined);
  const planned = refreshSaveSpec({ model, entry: found.entry, source: found.source, pngDataUrl: PNG });
  assert.ok(planned.kind === "ready" && planned.value.spec.file.kind === "keep");
  executeDiagramSave({ spec: planned.value.spec, drive: fake.drive });
  assert.equal(fake.nodes.get(file)?.text, XML_TWO, "the file is not rewritten");
  assert.match(JSON.stringify(fake.batches[0]?.requests), new RegExp(`drawio:dgold;v=${diagramVersionOf(XML_TWO)}`));
  // The current version is no longer stale.
  const fresh = modelOf({ ...model, pictures: model.pictures.map((picture) => ({ ...picture, description: drawioAltText({ diagramId: "dgold", version: diagramVersionOf(XML_TWO) }) })) });
  assert.equal(staleEntriesOf({ entries: diagramEntriesOf(fresh), sources }).length, 0);
});

test("AFTER INSERT: a file the connector pre-wrote is reused, a missing one is created, and one batch links both", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderB = fake.folderAt(diagramFolderPath(DECK_B));
  const prewritten = fake.putFile({ folderId: folderB, name: "dgknown.drawio", text: XML_ONE });
  const diagrams: readonly ConvertedDiagram[] = [
    { objectId: "slide_1", diagramId: "dgknown", version: diagramVersionOf(XML_ONE), xml: XML_ONE },
    { objectId: "slide_2", diagramId: "dgfresh", version: diagramVersionOf(XML_TWO), xml: XML_TWO },
    { objectId: "slide_3", diagramId: "dgknown", version: diagramVersionOf(XML_ONE), xml: XML_ONE },
  ];
  const spec = insertedDiagramLinkSpec({ presentationId: DECK_B, diagrams });
  assert.ok(spec !== null);
  assert.equal(spec.entries.length, 2, "one file per diagram id");
  const reply = executeDiagramLinks({ spec, drive: fake.drive });
  assert.deepEqual(reply.links.map((link) => [link.fileName, link.reused]), [["dgknown.drawio", true], ["dgfresh.drawio", false]]);
  assert.equal(reply.links[0]?.fileId, prewritten);
  assert.equal(fake.nodes.get(prewritten)?.text, XML_ONE);
  assert.equal(fake.filesIn(folderB).find((file) => file.name === "dgfresh.drawio")?.text, XML_TWO);
  assert.equal(fake.batches.length, 1);
  const text = JSON.stringify(fake.batches[0]?.requests);
  assert.doesNotMatch(text, /sashaPending/);
  assert.equal((text.match(new RegExp(`/file/d/${prewritten}/view`, "g")) ?? []).length, 2, "both pictures of dgknown link to the pre-written file");
  assert.equal(insertedDiagramLinkSpec({ presentationId: DECK_B, diagrams: [] }), null, "no diagrams, no call");
});

test("AFTER INSERT with no folder yet: the path is created, and a pre-written file in the connector's own tree is found", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const ours = fake.folderAt(diagramFolderPath(DECK_B));
  const slideFolder = fake.drive.findFolderPaths(diagramFolderPath(DECK_B).slice(0, 3))[0] ?? null;
  const theirs = fake.duplicateFolder({ parentId: slideFolder, name: "drawio" });
  const prewritten = fake.putFile({ folderId: theirs, name: "dgconn.drawio", text: XML_ONE });
  const spec = insertedDiagramLinkSpec({ presentationId: DECK_B, diagrams: [{ objectId: "slide_1", diagramId: "dgconn", version: diagramVersionOf(XML_ONE), xml: XML_ONE }] });
  assert.ok(spec !== null);
  const reply = executeDiagramLinks({ spec, drive: fake.drive });
  assert.deepEqual(reply.links, [{ fileName: "dgconn.drawio", fileId: prewritten, reused: true }]);
  assert.equal(fake.filesIn(ours).length, 0, "no duplicate copy in the add-on's tree");

  const empty = fakeDiagramDrive({ activePresentationId: DECK_B });
  executeDiagramLinks({ spec, drive: empty.drive });
  assert.equal(empty.drive.findFolderPaths(diagramFolderPath(DECK_B)).length, 1, "sasha_slides/slide/<id>/drawio was created");
});

test("THE SEED: the selected picture's source is read in the same call, its link parsed exactly as the converter parses it", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folderA = fake.folderAt(diagramFolderPath(DECK_A));
  const file = fake.putFile({ folderId: folderA, name: "dgseed.drawio", text: XML_ONE });
  for (const url of [driveFileAddress(file), `https://drive.google.com/open?id=${file}`, `https://docs.google.com/uc?export=view&id=${file}`, "https://example.com/file/d/abcdefghijkl/view", "not a link"]) {
    const boot = diagramBootOf({ presentationId: DECK_B, deck: deckOf([{ objectId: "pic", url }]), selection: { pageObjectId: "p1", objectIds: ["pic"] }, drive: fake.drive });
    assert.equal(boot.selectedSource?.fileId ?? null, driveFileIdOfAddress(url), url);
  }
  const boot = diagramBootOf({ presentationId: DECK_B, deck: deckOf([{ objectId: "pic", url: driveFileAddress(file) }, { objectId: "other", url: null }]), selection: { pageObjectId: "p1", objectIds: ["pic"] }, drive: fake.drive });
  assert.equal(boot.folder, null, "deck B has no folder yet");
  const seed = parseDiagramSeed(JSON.stringify(boot));
  assert.ok(seed.kind === "ok");
  assert.deepEqual(seed.value.selectedSource, { kind: "read", fileId: file, name: "dgseed.drawio", parentFolderIds: [folderA], xml: XML_ONE });
  assert.deepEqual(seed.value.model.pictures.map((picture) => [picture.objectId, picture.slideNumber, picture.widthEmu]), [["pic", 1, 3_000_000], ["other", 1, 3_000_000]]);
  assert.equal(seed.value.model.pageSize.width, 9_144_000);
  const unselected = diagramBootOf({ presentationId: DECK_B, deck: deckOf([{ objectId: "pic", url: driveFileAddress(file) }]), selection: { pageObjectId: "p1", objectIds: [] }, drive: fake.drive });
  assert.equal(unselected.selectedSource, null);
  const missing = diagramBootOf({ presentationId: DECK_B, deck: deckOf([{ objectId: "pic", url: driveFileAddress("gonegonegone") }]), selection: { pageObjectId: "p1", objectIds: ["pic"] }, drive: fake.drive });
  assert.match(missing.selectedSource?.error ?? "", /File not found/);
  assert.equal(parseDiagramSeed(JSON.stringify({ failed: "The presentation could not be read: quota" })).kind, "invalid");
});

test("sashaReadDiagramSources: each file succeeds or fails on its own, and a .drawio.png yields its embedded source", () => {
  const fake = fakeDiagramDrive({ activePresentationId: DECK_B });
  const folder = fake.folderAt(["x"]);
  const good = fake.putFile({ folderId: folder, name: "a.drawio", text: XML_ONE });
  const svg = fake.putFile({ folderId: folder, name: "b.drawio.svg", text: `<svg xmlns="http://www.w3.org/2000/svg" content="${XML_TWO.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"></svg>` });
  const junk = fake.putFile({ folderId: folder, name: "c.txt", text: "hello" });
  const reply = readDiagramSources({ fileIds: [good, svg, junk, "missingmissing"], drive: fake.drive });
  const parsed = parseDiagramSourcesReply(JSON.parse(JSON.stringify(reply)));
  assert.ok(parsed.kind === "ok");
  assert.deepEqual(parsed.value.map((read) => (read.kind === "read" ? read.xml : read.kind)), [XML_ONE, XML_TWO, "unreadable", "unreadable"]);
});

test("Code.gs: the 'Edit diagram' menu item, the dialog, and every new server function, also listed in bridge.ts", () => {
  const code = codeGs({ editorOrigin: DEFAULT_EDITOR_ORIGIN });
  assert.deepEqual(DIAGRAM_MENU_ITEM, { label: "Edit diagram", functionName: "sashaOpenDiagrams" });
  assert.match(code, /\.addItem\('Edit diagram', 'sashaOpenDiagrams'\)/);
  assert.match(code, /^function sashaOpenDiagrams\(\)/m);
  assert.match(code, /createHtmlOutputFromFile\('Diagram'\)/);
  assert.match(code, /showModelessDialog\(page, 'Diagrams'\)/);
  for (const name of ["sashaSaveDiagram", "sashaReadDiagramSources", "sashaLinkInsertedDiagrams"]) {
    assert.ok(SERVER_FUNCTION_NAMES.includes(name as (typeof SERVER_FUNCTION_NAMES)[number]), `${name} is in bridge.ts's one list`);
    assert.match(code, new RegExp(`^function ${name}\\(`, "m"));
  }
  for (const name of ["sashaWalkFolderPaths_", "sashaDiagramBootOf_", "sashaExecuteDiagramSave_", "sashaExecuteDiagramLinks_", "sashaReadDiagramSourcesOf_"]) assert.match(code, new RegExp(`^var ${name} = function`, "m"));
});

/** A function as Code.gs runs it: its source text, evaluated with nothing else in scope. */
function embedded<TFunction>(fn: TFunction & { toString(): string }): TFunction {
  // SAFETY: the text is `fn`'s own source, so evaluating it yields a function of the same signature.
  return new Function(`return (${fn.toString()});`)() as TFunction;
}

function modelOf(options: Readonly<{ presentationId: string; pictures: readonly Readonly<{ pageObjectId: string; objectId: string; description: string | null; linkUrl: string | null }>[]; folder: DiagramModel["folder"] }>): DiagramModel {
  return {
    presentationId: options.presentationId,
    pageSize: { width: 9_144_000, height: 5_143_500 },
    slideObjectIds: ["p1", "p2"],
    pictures: options.pictures.map((picture) => ({ ...picture, slideNumber: picture.pageObjectId === "p2" ? 2 : 1, widthEmu: 3_000_000, heightEmu: 1_500_000 })),
    selection: { pageObjectId: "p1", objectIds: [] },
    folder: options.folder,
  };
}

function sourceRead(options: Readonly<{ fake: FakeDiagramDrive; fileId: string }>): DiagramSourceRead {
  const parsed = parseDiagramSourcesReply(readDiagramSources({ fileIds: [options.fileId], drive: options.fake.drive }));
  assert.ok(parsed.kind === "ok");
  const read = parsed.value[0];
  assert.ok(read !== undefined);
  return read;
}

function deckOf(pictures: readonly Readonly<{ objectId: string; url: string | null }>[]): RawDeck {
  return {
    pageSize: { width: { magnitude: 9_144_000, unit: "EMU" }, height: { magnitude: 5_143_500, unit: "EMU" } },
    slides: [
      {
        objectId: "p1",
        pageElements: pictures.map((picture) => ({
          objectId: picture.objectId,
          size: { width: { magnitude: 3_000_000, unit: "EMU" }, height: { magnitude: 1_500_000, unit: "EMU" } },
          transform: { scaleX: 1, scaleY: 1 },
          image: picture.url === null ? {} : { imageProperties: { link: { url: picture.url } } },
        })),
      },
    ],
  };
}

function stagedIdOf(fake: FakeDiagramDrive): string {
  const staged = fake.deleted.find((id) => id.startsWith("staged"));
  assert.ok(staged !== undefined, "a picture was staged");
  return staged;
}

/** A PNG data address whose header declares the size (only the header is ever read). */
function pngDataUrl(size: Readonly<{ width: number; height: number }>): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, size.width);
  view.setUint32(20, size.height);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}
