// WHAT THE DIAGRAM DIALOG ASKS CODE.GS TO DO, decided in TypeScript: which diagrams the deck holds,
// which of them are stale, and the exact save (or link) spec diagram-host.ts executes. Pure: the
// dialog (diagram.tsx) does the I/O, and the plan itself is converter/drawio-save-plan.ts's.
//
// PLACEHOLDERS. A spec is complete except for two things only a Drive write can name: the staged
// picture's address (`STAGED_IMAGE_URL`, the converter's own placeholder) and, for a file that is
// about to be created, its id. The second is written as the Drive address of a fixed placeholder id,
// and the executor swaps the whole address -- `/view` closes it, so one placeholder can never be the
// start of another.

import {
  diagramFileName,
  diagramFolderPath,
  diagramIdForSource,
  diagramIdOfFileName,
  diagramVersionOf,
  driveFileAddress,
  drawioAltText,
  DRAWIO_FILE_MEDIA_TYPE,
  parseDrawioAltText,
  parseDrawioSource,
  type DiagramStamp,
} from "../../converter/drawio-diagram.ts";
import { DRAWIO_RENDER_SCALE } from "../../converter/drawio-embed.ts";
import {
  diagramImageRequests,
  diagramLinkRequests,
  diagramReferencesOf,
  fitDiagramBox,
  newDiagramRequests,
  planDiagramSave,
  type EmuBox,
} from "../../converter/drawio-save-plan.ts";
import { STAGED_IMAGE_URL } from "../../converter/slide-image.ts";
import type { ConvertedDiagram } from "../../converter/convert-html-to-slide-requests.ts";
import type { DiagramLinkSpec, DiagramSaveSpec, FileAddressParts } from "./diagram-host.ts";
import type { DeckPictureRow, DiagramModel, DiagramSaved, DiagramSourceRead } from "./diagram-wire.ts";

/** Stands in for a file id until the file exists. A valid id shape, so `driveFileAddress` accepts it. */
export const DIAGRAM_FILE_PLACEHOLDER_ID = "sashaPendingDiagramFile";

/** A blank page for "New diagram". */
export const BLANK_DIAGRAM_XML =
  '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

/** One diagram of the deck: every picture that shows it, grouped by its source file (or its id). */
export type DiagramEntry = Readonly<{
  key: string;
  /** The Drive file the pictures link to, or null when they only carry a stamp. */
  fileId: string | null;
  /** From a stamp, else null until the source is read (diagramIdOf). */
  stampedDiagramId: string | null;
  pictures: readonly DeckPictureRow[];
  /** The picture the person had selected when the dialog opened is in this entry. */
  selected: boolean;
}>;

/** A spec, or why there is none. */
export type SpecOutcome<TValue> = Readonly<{ kind: "ready"; value: TValue }> | Readonly<{ kind: "refused"; reason: string }>;

/** A save spec with what the dialog needs to update its own model once Code.gs has run it. */
export type PlannedSave = Readonly<{ spec: DiagramSaveSpec; diagramId: string; stamp: DiagramStamp; imageObjectIds: readonly string[] }>;

/** The deck's diagrams, the selected one first, then in slide order. */
export function diagramEntriesOf(model: DiagramModel): readonly DiagramEntry[] {
  const references = diagramReferencesOf(model.pictures);
  const groups = new Map<string, { fileId: string | null; stampedDiagramId: string | null; pictures: DeckPictureRow[] }>();
  for (const reference of references) {
    const picture = model.pictures.find((candidate) => candidate.objectId === reference.objectId);
    if (picture === undefined) continue;
    const key = reference.fileId !== null ? `file:${reference.fileId}` : `diagram:${reference.stamp?.diagramId ?? reference.objectId}`;
    const group = groups.get(key) ?? { fileId: reference.fileId, stampedDiagramId: null, pictures: [] };
    group.pictures.push(picture);
    if (group.stampedDiagramId === null && reference.stamp !== null) group.stampedDiagramId = reference.stamp.diagramId;
    groups.set(key, group);
  }
  const entries = [...groups.entries()].map(([key, group]): DiagramEntry => ({
    key,
    fileId: group.fileId,
    stampedDiagramId: group.stampedDiagramId,
    pictures: group.pictures,
    selected: group.pictures.some((picture) => model.selection.objectIds.includes(picture.objectId)),
  }));
  return [...entries.filter((entry) => entry.selected), ...entries.filter((entry) => !entry.selected)];
}

/** The id the diagram is saved under: its stamp, else its file's name, else a hash of its source. */
export function diagramIdOf(options: Readonly<{ entry: DiagramEntry; source: DiagramSourceRead | null; xml: string }>): string {
  if (options.entry.stampedDiagramId !== null) return options.entry.stampedDiagramId;
  const fromName = options.source?.kind === "read" ? diagramIdOfFileName(options.source.name) : null;
  return fromName ?? diagramIdForSource(normalisedXml(options.xml));
}

/**
 * The XML every id and version is computed from: `parseDrawioSource`'s `<mxfile>` form, the same
 * normalisation the connector hashes, so both sides name and version one diagram identically.
 * Text that does not parse is used as it is (draw.io itself produced it).
 */
export function normalisedXml(xml: string): string {
  const parsed = parseDrawioSource(xml);
  return parsed.kind === "ok" ? parsed.xml : xml;
}

/**
 * SAVING AN EDIT: the copy-on-write plan (drawio-save-plan.ts) turned into what Code.gs executes.
 * In place only when the source is in this presentation's folder; otherwise a new file there, with
 * every reference in this deck re-pointed. `editedObjectId` is the picture the person opened.
 */
export function editSaveSpec(
  options: Readonly<{ model: DiagramModel; entry: DiagramEntry; source: DiagramSourceRead | null; xml: string; pngDataUrl: string; editedObjectId: string | null }>,
): SpecOutcome<PlannedSave> {
  const { model, entry, source } = options;
  const xml = normalisedXml(options.xml);
  const picture = pictureOf(options.pngDataUrl);
  if (picture === null) return { kind: "refused", reason: "draw.io did not export a PNG picture" };
  if (entry.fileId !== null && source?.kind !== "read") return { kind: "refused", reason: "the diagram's source file could not be read, so it cannot be saved" };
  const plan = planDiagramSave({
    presentationId: model.presentationId,
    diagramId: diagramIdOf({ entry, source, xml }),
    source: source?.kind === "read" ? { fileId: source.fileId, parentFolderIds: source.parentFolderIds } : null,
    deckFolderId: deckFolderFor({ model, parentFolderIds: source?.kind === "read" ? source.parentFolderIds : [] }),
    deckFolderFileNames: model.folder?.fileNames ?? [],
    references: diagramReferencesOf(model.pictures),
    editedObjectId: options.editedObjectId,
  });
  const stamp: DiagramStamp = { diagramId: plan.diagramId, version: diagramVersionOf(xml) };
  const planned = (file: DiagramSaveSpec["file"], linkedFileId: string): SpecOutcome<PlannedSave> => ({
    kind: "ready",
    value: {
      diagramId: plan.diagramId,
      stamp,
      imageObjectIds: plan.imageObjectIds,
      spec: saveSpec({
        presentationId: model.presentationId,
        xml,
        picture: { ...picture, fileName: `${plan.diagramId}.png` },
        file,
        requests: diagramImageRequests({ imageObjectIds: plan.imageObjectIds, imageUrl: STAGED_IMAGE_URL, fileId: linkedFileId, stamp }),
      }),
    },
  });
  switch (plan.file.kind) {
    case "update":
      return planned({ kind: "update", fileId: plan.file.fileId, deckFolderPath: diagramFolderPath(model.presentationId) }, plan.file.fileId);
    case "create":
      return planned({ kind: "create", folderPath: plan.file.folderPath, fileName: plan.file.fileName }, DIAGRAM_FILE_PLACEHOLDER_ID);
    default: {
      const unknownAction: never = plan.file;
      return unknownAction;
    }
  }
}

/**
 * A NEW DIAGRAM (drawn from blank, or uploaded): a new file in this presentation's folder and a new
 * picture on the selected slide (the first slide when none is selected), at the picture's natural
 * size, shrunk to fit inside the page's margins and centred.
 */
export function newDiagramSaveSpec(
  options: Readonly<{ model: DiagramModel; xml: string; pngDataUrl: string; objectId: string }>,
): SpecOutcome<PlannedSave & Readonly<{ pageObjectId: string; box: EmuBox }>> {
  const { model } = options;
  const xml = normalisedXml(options.xml);
  const picture = pictureOf(options.pngDataUrl);
  if (picture === null) return { kind: "refused", reason: "draw.io did not export a PNG picture" };
  const selectedPage = model.selection.pageObjectId;
  const pageObjectId = selectedPage !== null && model.slideObjectIds.includes(selectedPage) ? selectedPage : model.slideObjectIds[0];
  if (pageObjectId === undefined) return { kind: "refused", reason: "the presentation has no slide to put the diagram on" };
  const plan = planDiagramSave({
    presentationId: model.presentationId,
    diagramId: diagramIdForSource(xml),
    source: null,
    deckFolderId: model.folder?.folderId ?? null,
    deckFolderFileNames: model.folder?.fileNames ?? [],
    references: [],
    editedObjectId: null,
  });
  if (plan.file.kind !== "create") return { kind: "refused", reason: "a new diagram must create its file" };
  const stamp: DiagramStamp = { diagramId: plan.diagramId, version: diagramVersionOf(xml) };
  const box = newDiagramBox({ page: model.pageSize, picture: picture.size });
  return {
    kind: "ready",
    value: {
      diagramId: plan.diagramId,
      stamp,
      imageObjectIds: [options.objectId],
      pageObjectId,
      box,
      spec: saveSpec({
        presentationId: model.presentationId,
        xml,
        picture: { ...picture, fileName: `${plan.diagramId}.png` },
        file: { kind: "create", folderPath: plan.file.folderPath, fileName: plan.file.fileName },
        requests: newDiagramRequests({ pageObjectId, objectId: options.objectId, imageUrl: STAGED_IMAGE_URL, fileId: DIAGRAM_FILE_PLACEHOLDER_ID, stamp, box }),
      }),
    },
  };
}

/**
 * The diagrams whose pictures are OLDER than their source: a stamp names a version, and the file
 * now hashes to another one (an agent wrote new XML through the connector, or another deck saved
 * in place). A picture with no version in its stamp cannot be compared and is left alone.
 */
export function staleEntriesOf(
  options: Readonly<{ entries: readonly DiagramEntry[]; sources: ReadonlyMap<string, DiagramSourceRead> }>,
): readonly Readonly<{ entry: DiagramEntry; source: Extract<DiagramSourceRead, { kind: "read" }>; stalePictures: readonly DeckPictureRow[] }>[] {
  return options.entries.flatMap((entry) => {
    const source = entry.fileId === null ? undefined : options.sources.get(entry.fileId);
    if (source === undefined || source.kind !== "read") return [];
    const version = diagramVersionOf(source.xml);
    const stalePictures = entry.pictures.filter((picture) => {
      const stamp = parseDrawioAltText(picture.description);
      return stamp !== null && stamp.version !== null && stamp.version !== version;
    });
    return stalePictures.length === 0 ? [] : [{ entry, source, stalePictures }];
  });
}

/** REFRESHING STALE PICTURES: the file is right, so only the pictures are replaced and re-stamped. */
export function refreshSaveSpec(
  options: Readonly<{ model: DiagramModel; entry: DiagramEntry; source: Extract<DiagramSourceRead, { kind: "read" }>; pngDataUrl: string }>,
): SpecOutcome<PlannedSave> {
  const { model, entry, source } = options;
  const picture = pictureOf(options.pngDataUrl);
  if (picture === null) return { kind: "refused", reason: "draw.io did not export a PNG picture" };
  const diagramId = diagramIdOf({ entry, source, xml: source.xml });
  const stamp: DiagramStamp = { diagramId, version: diagramVersionOf(source.xml) };
  const imageObjectIds = entry.pictures.map((picture) => picture.objectId);
  return {
    kind: "ready",
    value: {
      diagramId,
      stamp,
      imageObjectIds,
      spec: saveSpec({
        presentationId: model.presentationId,
        xml: source.xml,
        picture: { ...picture, fileName: `${diagramId}.png` },
        file: { kind: "keep", fileId: source.fileId },
        requests: diagramImageRequests({ imageObjectIds, imageUrl: STAGED_IMAGE_URL, fileId: source.fileId, stamp }),
      }),
    },
  };
}

/**
 * The dialog's model after a save Code.gs reported: every re-pointed picture carries the new link and
 * stamp, a created file's name is taken, and a new picture is listed.
 */
export function modelAfterSave(
  options: Readonly<{
    model: DiagramModel;
    planned: PlannedSave;
    saved: DiagramSaved;
    added: Readonly<{ pageObjectId: string; box: EmuBox }> | null;
  }>,
): DiagramModel {
  const { model, planned, saved } = options;
  const linkUrl = driveFileAddress(saved.fileId);
  const description = drawioAltText(planned.stamp);
  const pictures = model.pictures.map((picture) => (planned.imageObjectIds.includes(picture.objectId) ? { ...picture, linkUrl, description } : picture));
  const added = options.added;
  const objectId = planned.imageObjectIds[0];
  const newRows =
    added === null || objectId === undefined
      ? []
      : [{ pageObjectId: added.pageObjectId, objectId, description, linkUrl, slideNumber: model.slideObjectIds.indexOf(added.pageObjectId) + 1, widthEmu: added.box.width, heightEmu: added.box.height }];
  const createdName = planned.spec.file.kind === "create" ? planned.spec.file.fileName : null;
  const folderId = model.folder?.folderId ?? saved.folderId;
  const folderIds = [...(model.folder?.folderIds ?? []), ...(saved.folderId === null || (model.folder?.folderIds ?? []).includes(saved.folderId) ? [] : [saved.folderId])];
  const fileNames = [...(model.folder?.fileNames ?? []), ...(createdName === null || !saved.created ? [] : [createdName])];
  return { ...model, pictures: [...pictures, ...newRows], folder: folderId === null ? null : { folderId, folderIds, fileNames } };
}

/**
 * AFTER AN INSERT: the link spec for every diagram the converter put on the slide. One file per
 * diagram id (two pictures of one diagram share it), linked and stamped in one batchUpdate. Null
 * when the slide has no diagram, so no server call is made at all.
 */
export function insertedDiagramLinkSpec(options: Readonly<{ presentationId: string; diagrams: readonly ConvertedDiagram[] }>): DiagramLinkSpec | null {
  if (options.diagrams.length === 0) return null;
  const placeholders = new Map<string, string>();
  const entries: { fileName: string; xml: string; fileAddressPlaceholder: string }[] = [];
  const requests = options.diagrams.flatMap((diagram) => {
    let placeholderId = placeholders.get(diagram.diagramId);
    if (placeholderId === undefined) {
      placeholderId = `sashaPendingDiagram${String(placeholders.size)}File`;
      placeholders.set(diagram.diagramId, placeholderId);
      entries.push({ fileName: diagramFileName(diagram.diagramId), xml: diagram.xml, fileAddressPlaceholder: driveFileAddress(placeholderId) });
    }
    return diagramLinkRequests({ objectId: diagram.objectId, fileId: placeholderId, stamp: { diagramId: diagram.diagramId, version: diagram.version } });
  });
  return {
    presentationId: options.presentationId,
    folderPath: diagramFolderPath(options.presentationId),
    fileMimeType: DRAWIO_FILE_MEDIA_TYPE,
    entries,
    requests,
    fileAddress: fileAddressParts(),
  };
}

/** `driveFileAddress` around the file id, so Code.gs builds the same address without its own copy. */
export function fileAddressParts(): FileAddressParts {
  const address = driveFileAddress(DIAGRAM_FILE_PLACEHOLDER_ID);
  const at = address.indexOf(DIAGRAM_FILE_PLACEHOLDER_ID);
  return { prefix: address.slice(0, at), suffix: address.slice(at + DIAGRAM_FILE_PLACEHOLDER_ID.length) };
}

/** The width and height a PNG declares in its header, or null for anything that is not a PNG. */
export function pngSizeOf(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, at) => bytes[at] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const EMU_PER_PIXEL = 9525;
/** A new diagram keeps this share of the page free on every side. */
const NEW_DIAGRAM_MARGIN = 0.05;

/** Natural size (the export is DRAWIO_RENDER_SCALE times the drawing), never larger than the page's inner area. */
function newDiagramBox(options: Readonly<{ page: Readonly<{ width: number; height: number }>; picture: Readonly<{ width: number; height: number }> }>): EmuBox {
  const { page, picture } = options;
  const area: EmuBox = { x: page.width * NEW_DIAGRAM_MARGIN, y: page.height * NEW_DIAGRAM_MARGIN, width: page.width * (1 - 2 * NEW_DIAGRAM_MARGIN), height: page.height * (1 - 2 * NEW_DIAGRAM_MARGIN) };
  const naturalWidth = (picture.width / DRAWIO_RENDER_SCALE) * EMU_PER_PIXEL;
  const naturalHeight = (picture.height / DRAWIO_RENDER_SCALE) * EMU_PER_PIXEL;
  const width = Math.min(area.width, naturalWidth);
  const height = Math.min(area.height, naturalHeight);
  const centred: EmuBox = { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height };
  return fitDiagramBox({ area: centred, pictureWidth: picture.width, pictureHeight: picture.height });
}

type ExportedPicture = Readonly<{ mimeType: "image/png"; base64: string; size: Readonly<{ width: number; height: number }> }>;

/** draw.io's PNG export (`data:image/png;base64,…`) as bytes Code.gs can stage, with its size. */
function pictureOf(pngDataUrl: string): ExportedPicture | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(pngDataUrl);
  const base64 = match?.[1]?.replace(/\s+/g, "");
  if (base64 === undefined || base64.length === 0) return null;
  let header: Uint8Array;
  try {
    header = Uint8Array.from(atob(base64.slice(0, 44)), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  const size = pngSizeOf(header);
  return size === null ? null : { mimeType: "image/png", base64, size };
}

/**
 * The deck folder the plan compares the source against: the one of this deck's folders that holds
 * the source, else the first. There can be several (the connector cannot see the add-on's tree).
 */
function deckFolderFor(options: Readonly<{ model: DiagramModel; parentFolderIds: readonly string[] }>): string | null {
  const folder = options.model.folder;
  if (folder === null) return null;
  return folder.folderIds.find((folderId) => options.parentFolderIds.includes(folderId)) ?? folder.folderId;
}

function saveSpec(
  options: Readonly<{
    presentationId: string;
    xml: string;
    picture: Readonly<{ fileName: string; mimeType: string; base64: string }>;
    file: DiagramSaveSpec["file"];
    requests: DiagramSaveSpec["requests"];
  }>,
): DiagramSaveSpec {
  return {
    presentationId: options.presentationId,
    file: options.file,
    xml: options.xml,
    fileMimeType: DRAWIO_FILE_MEDIA_TYPE,
    picture: { fileName: options.picture.fileName, mimeType: options.picture.mimeType, base64: options.picture.base64 },
    requests: options.requests,
    imageUrlPlaceholder: STAGED_IMAGE_URL,
    fileAddressPlaceholder: driveFileAddress(DIAGRAM_FILE_PLACEHOLDER_ID),
    fileAddress: fileAddressParts(),
  };
}
