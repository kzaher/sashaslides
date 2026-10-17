/**
 * drawio-save-plan.ts: which pictures a save touches, and update-in-place versus copy-on-write.
 * Run: npx tsx --test mcp/sasha-slides/converter/test/drawio-*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { driveFileAddress } from "../drawio-diagram.ts";
import { diagramImageRequests, diagramReferencesOf, fitDiagramBox, planDiagramSave, type DeckPicture } from "../drawio-save-plan.ts";

const THIS_DECK = "1thisDeckPresentationIdAAAAAAAAAAAAAAAAAAAA";
const OWN_FILE = "1ownFileInThisDeckFolderXX";
const FOREIGN_FILE = "1fileUnderAnotherDeckXXXXX";
const THIS_FOLDER = "1folderOfThisDeckXXXXXXXXX";
const OTHER_FOLDER = "1folderOfAnotherDeckXXXXXX";

const pictures: readonly DeckPicture[] = [
  { pageObjectId: "p1", objectId: "img-a", description: "drawio:dg11111111;v=aaaaaaaa", linkUrl: driveFileAddress(FOREIGN_FILE) },
  { pageObjectId: "p2", objectId: "img-b", description: "drawio:dg11111111;v=aaaaaaaa", linkUrl: driveFileAddress(FOREIGN_FILE) },
  { pageObjectId: "p3", objectId: "img-c", description: "drawio:dg11111111", linkUrl: null },
  { pageObjectId: "p3", objectId: "img-d", description: "drawio:dg11111111", linkUrl: driveFileAddress(OWN_FILE) },
  { pageObjectId: "p4", objectId: "photo", description: "a photo", linkUrl: null },
];

test("only pictures with a stamp or a Drive link are references", () => {
  assert.deepEqual(
    diagramReferencesOf(pictures).map((reference) => reference.objectId),
    ["img-a", "img-b", "img-c", "img-d"],
  );
});

test("a source under ANOTHER document is copied into this deck's folder and every reference re-pointed", () => {
  const plan = planDiagramSave({
    presentationId: THIS_DECK,
    diagramId: "dg11111111",
    source: { fileId: FOREIGN_FILE, parentFolderIds: [OTHER_FOLDER] },
    deckFolderId: THIS_FOLDER,
    deckFolderFileNames: [],
    references: diagramReferencesOf(pictures),
    editedObjectId: "img-a",
  });
  assert.deepEqual(plan.file, {
    kind: "create",
    folderPath: ["sasha_slides", "slide", THIS_DECK, "drawio"],
    fileName: "dg11111111.drawio",
    copiedFromFileId: FOREIGN_FILE,
  });
  // img-c has no link but the same id; img-d links a DIFFERENT file, so it is a different copy.
  assert.deepEqual(plan.imageObjectIds, ["img-a", "img-b", "img-c"]);
});

test("a source already in this deck's folder is updated in place", () => {
  const plan = planDiagramSave({
    presentationId: THIS_DECK,
    diagramId: "dg11111111",
    source: { fileId: OWN_FILE, parentFolderIds: [THIS_FOLDER] },
    deckFolderId: THIS_FOLDER,
    deckFolderFileNames: ["dg11111111.drawio"],
    references: diagramReferencesOf(pictures),
    editedObjectId: "img-d",
  });
  assert.deepEqual(plan.file, { kind: "update", fileId: OWN_FILE });
  // img-c has no link, so its stamp alone makes it this diagram; it is linked to the file now.
  assert.deepEqual(plan.imageObjectIds, ["img-c", "img-d"]);
});

test("a copy never overwrites a different diagram of the same name", () => {
  const plan = planDiagramSave({
    presentationId: THIS_DECK,
    diagramId: "dg11111111",
    source: { fileId: FOREIGN_FILE, parentFolderIds: [OTHER_FOLDER] },
    deckFolderId: THIS_FOLDER,
    deckFolderFileNames: ["dg11111111.drawio", "dg11111111-2.drawio"],
    references: [],
    editedObjectId: "img-a",
  });
  assert.equal(plan.diagramId, "dg11111111-3");
  assert.equal(plan.file.kind === "create" ? plan.file.fileName : null, "dg11111111-3.drawio");
});

test("a diagram with no source file yet is created; no deck folder yet is fine", () => {
  const plan = planDiagramSave({ presentationId: THIS_DECK, diagramId: "dgnew", source: null, deckFolderId: null, deckFolderFileNames: [], references: [], editedObjectId: null });
  assert.deepEqual(plan.file, { kind: "create", folderPath: ["sasha_slides", "slide", THIS_DECK, "drawio"], fileName: "dgnew.drawio", copiedFromFileId: null });
  assert.deepEqual(plan.imageObjectIds, []);
});

test("each reference is replaced in place, then re-linked and re-stamped", () => {
  const requests = diagramImageRequests({ imageObjectIds: ["img-a"], imageUrl: "https://drive.google.com/uc?id=1stagedPngXXXXXXXXXXXX", fileId: OWN_FILE, stamp: { diagramId: "dg11111111", version: "bbbbbbbb" } });
  assert.deepEqual(requests, [
    { replaceImage: { imageObjectId: "img-a", url: "https://drive.google.com/uc?id=1stagedPngXXXXXXXXXXXX", imageReplaceMethod: "CENTER_INSIDE" } },
    { updateImageProperties: { objectId: "img-a", imageProperties: { link: { url: driveFileAddress(OWN_FILE) } }, fields: "link" } },
    { updatePageElementAltText: { objectId: "img-a", description: "drawio:dg11111111;v=bbbbbbbb" } },
  ]);
});

test("a new picture keeps its aspect ratio inside the area", () => {
  assert.deepEqual(fitDiagramBox({ area: { x: 0, y: 0, width: 1000, height: 500 }, pictureWidth: 200, pictureHeight: 200 }), { x: 250, y: 0, width: 500, height: 500 });
});
