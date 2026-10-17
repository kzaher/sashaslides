/**
 * drawio-save-plan.ts — what saving an edited draw.io diagram must do to one presentation, decided
 * without any I/O, so the add-on (Code.gs executes it) and the connector (Node executes it) cannot
 * disagree and a fake Drive can test it.
 *
 * THE RULE (the user's): "During save edit should detect all references to the drawio in the
 * document and do cow, if the drawio link is under some other document, it should copy the asset
 * under proper sasha_slides/slide/id/drawio/drawio_id.drawio."
 *
 *   1. REFERENCES. Every picture in THIS presentation that shows the diagram: its link resolves to the
 *      same Drive file, or (when it has no link) its alternative text names the same diagram id. All
 *      of them get the new picture, the link and the new version stamp. Pictures in other
 *      presentations are never touched: they keep the file they point at.
 *   2. COPY ON WRITE. The source is updated IN PLACE only when it already lives in this
 *      presentation's own folder (`sasha_slides/slide/<presentationId>/drawio`). Anywhere else (another
 *      presentation's folder: a slide was copied between decks; the old `drawio/slide/<id>` store; a
 *      file a person linked by hand) the edited XML is written as a NEW file in this presentation's
 *      folder, the old file is left exactly as it was, and every reference here is re-pointed to the
 *      new file.
 *   3. NAMES. The copy keeps the diagram id when this folder has no file of that name; otherwise it
 *      takes the first free `<id>-2`, `<id>-3`, … so it never overwrites a different diagram.
 */
import { diagramFileName, diagramFolderPath, driveFileAddress, driveFileIdOfAddress, drawioAltText, isDiagramId, parseDrawioAltText, type DiagramStamp } from "./drawio-diagram.js";
import type { SlidesApiRequest } from "./slides-api.js";

/** One picture of the presentation as `presentations.get` reports it (only what the plan needs). */
export type DeckPicture = Readonly<{
  pageObjectId: string;
  objectId: string;
  /** The alternative-text description, or null. */
  description: string | null;
  /** `image.imageProperties.link.url`, or null. */
  linkUrl: string | null;
}>;

/** A picture that is, or claims to be, a draw.io diagram. */
export type DiagramReference = Readonly<{
  pageObjectId: string;
  objectId: string;
  stamp: DiagramStamp | null;
  fileId: string | null;
}>;

/** Where the diagram's current source file is, as Drive reports it; null when there is none yet. */
export type DiagramSource = Readonly<{ fileId: string; parentFolderIds: readonly string[] }>;

export type DiagramFileAction =
  | Readonly<{ kind: "update"; fileId: string }>
  | Readonly<{
      kind: "create";
      /** Folder names from My Drive's root, created when missing (drawio-diagram.ts diagramFolderPath). */
      folderPath: readonly string[];
      fileName: string;
      /** The file this one is a copy-on-write of, or null for a brand-new diagram. */
      copiedFromFileId: string | null;
    }>;

export type DiagramSavePlan = Readonly<{
  diagramId: string;
  file: DiagramFileAction;
  /** Every picture in this presentation to replace, re-link and re-stamp. */
  imageObjectIds: readonly string[];
}>;

/** The pictures that are diagrams: a draw.io stamp, or a link to a Drive file. */
export function diagramReferencesOf(pictures: readonly DeckPicture[]): readonly DiagramReference[] {
  return pictures.flatMap((picture) => {
    const stamp = parseDrawioAltText(picture.description);
    const fileId = driveFileIdOfAddress(picture.linkUrl);
    if (stamp === null && fileId === null) return [];
    return [{ pageObjectId: picture.pageObjectId, objectId: picture.objectId, stamp, fileId }];
  });
}

/**
 * The plan for saving `diagramId` (whose current source is `source`) in `presentationId`.
 * `deckFolderId` is the id of `sasha_slides/slide/<presentationId>/drawio` when it exists, and
 * `deckFolderFileNames` the names already in it. `editedObjectId` is the picture the person opened
 * (always included, even if its link was removed by hand).
 */
export function planDiagramSave(
  options: Readonly<{
    presentationId: string;
    diagramId: string;
    source: DiagramSource | null;
    deckFolderId: string | null;
    deckFolderFileNames: readonly string[];
    references: readonly DiagramReference[];
    editedObjectId: string | null;
  }>,
): DiagramSavePlan {
  const { presentationId, diagramId, source, deckFolderId } = options;
  if (!isDiagramId(diagramId)) throw new Error(`not a diagram id: ${diagramId}`);
  const imageObjectIds = referencedObjectIds({ references: options.references, diagramId, sourceFileId: source?.fileId ?? null, editedObjectId: options.editedObjectId });
  const ownsSource = source !== null && deckFolderId !== null && source.parentFolderIds.includes(deckFolderId);
  if (ownsSource) return { diagramId, file: { kind: "update", fileId: source.fileId }, imageObjectIds };
  const freeId = firstFreeDiagramId({ diagramId, taken: options.deckFolderFileNames });
  return {
    diagramId: freeId,
    file: { kind: "create", folderPath: diagramFolderPath(presentationId), fileName: diagramFileName(freeId), copiedFromFileId: source?.fileId ?? null },
    imageObjectIds,
  };
}

/**
 * The batchUpdate that puts a saved diagram's new picture on every reference: replace the bytes in
 * place (object id, size and position kept), then the link and the stamp, which a replacement may
 * drop. `imageUrl` is a URL Google can fetch (a staged Drive file, slide-image.ts stagedImageUrl).
 */
export function diagramImageRequests(
  options: Readonly<{ imageObjectIds: readonly string[]; imageUrl: string; fileId: string; stamp: DiagramStamp }>,
): readonly SlidesApiRequest[] {
  return options.imageObjectIds.flatMap((objectId) => [
    { replaceImage: { imageObjectId: objectId, url: options.imageUrl, imageReplaceMethod: "CENTER_INSIDE" as const } },
    ...diagramLinkRequests({ objectId, fileId: options.fileId, stamp: options.stamp }),
  ]);
}

/** The link to the source and the stamp, for one picture (after an insert, or after a replace). */
export function diagramLinkRequests(options: Readonly<{ objectId: string; fileId: string; stamp: DiagramStamp }>): readonly SlidesApiRequest[] {
  return [
    { updateImageProperties: { objectId: options.objectId, imageProperties: { link: { url: driveFileAddress(options.fileId) } }, fields: "link" } },
    { updatePageElementAltText: { objectId: options.objectId, description: drawioAltText(options.stamp) } },
  ];
}

/**
 * A NEW diagram's picture on `pageObjectId`, linked and stamped, centred in `box` (EMU). The size is
 * the box; `CENTER_INSIDE` is not available on createImage, so the caller passes a box with the
 * picture's own aspect ratio (fitDiagramBox).
 */
export function newDiagramRequests(
  options: Readonly<{ pageObjectId: string; objectId: string; imageUrl: string; fileId: string; stamp: DiagramStamp; box: EmuBox }>,
): readonly SlidesApiRequest[] {
  const { box } = options;
  return [
    {
      createImage: {
        objectId: options.objectId,
        url: options.imageUrl,
        elementProperties: {
          pageObjectId: options.pageObjectId,
          size: { width: { magnitude: box.width, unit: "EMU" }, height: { magnitude: box.height, unit: "EMU" } },
          transform: { scaleX: 1, scaleY: 1, translateX: box.x, translateY: box.y, unit: "EMU" },
        },
      },
    },
    ...diagramLinkRequests({ objectId: options.objectId, fileId: options.fileId, stamp: options.stamp }),
  ];
}

export type EmuBox = Readonly<{ x: number; y: number; width: number; height: number }>;

/** The largest box of the picture's aspect ratio that fits `area`, centred in it (EMU, rounded). */
export function fitDiagramBox(options: Readonly<{ area: EmuBox; pictureWidth: number; pictureHeight: number }>): EmuBox {
  const { area, pictureWidth, pictureHeight } = options;
  if (!(pictureWidth > 0) || !(pictureHeight > 0)) return area;
  const scale = Math.min(area.width / pictureWidth, area.height / pictureHeight);
  const width = Math.round(pictureWidth * scale);
  const height = Math.round(pictureHeight * scale);
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}

function referencedObjectIds(
  options: Readonly<{ references: readonly DiagramReference[]; diagramId: string; sourceFileId: string | null; editedObjectId: string | null }>,
): readonly string[] {
  const { sourceFileId, diagramId } = options;
  const matches = options.references.filter((reference) => {
    if (reference.fileId !== null && sourceFileId !== null) return reference.fileId === sourceFileId;
    if (reference.fileId !== null) return false;
    return reference.stamp?.diagramId === diagramId;
  });
  const ids = matches.map((reference) => reference.objectId);
  if (options.editedObjectId !== null && !ids.includes(options.editedObjectId)) ids.push(options.editedObjectId);
  return ids;
}

function firstFreeDiagramId(options: Readonly<{ diagramId: string; taken: readonly string[] }>): string {
  const taken = new Set(options.taken);
  if (!taken.has(diagramFileName(options.diagramId))) return options.diagramId;
  const stem = options.diagramId.replace(/-\d+$/, "").slice(0, 56);
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(diagramFileName(candidate))) return candidate;
  }
}
