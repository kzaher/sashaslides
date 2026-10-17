/**
 * insert-html.ts — running a validated developer-page insert (insert-html-parse.ts) with the
 * person's own Google grant.
 *
 * PER SLIDE, IN ORDER, STOPPING AT THE FIRST FAILURE (as export-run.ts does):
 *   1. stage its pictures: upload each to the person's Drive (`drive.file`), share it "anyone with
 *      the link can read", and point the `createImage` at `uc?id=<file>` — exactly what the add-on's
 *      Code.gs `sashaStageImages_` does, because that is the one address shape measured to work
 *      (converter/slide-image.ts). The `sashaStageImage` sidecar never reaches Google: the parser
 *      already took it off;
 *   2. one batchUpdate: `createSlide` (BLANK layout, the server's page id, at the position), then the
 *      slide's requests;
 *   3. delete the staged files, on every path: Slides copies the bytes during the batchUpdate, so the
 *      shared copy can stop existing at once (measured, slide-image.ts). A failed delete is a
 *      warning, never a failed insert.
 *
 * THEN, BEST EFFORT, each diagram's source: find or create the folder path
 * `sasha_slides/slide/<presentationId>/drawio` (converter/drawio-diagram.ts), write
 * `<diagramId>.drawio` there (replacing the content of a same-named file, so its id and every link
 * to it survive), and link and stamp the picture (drawio-save-plan.ts `diagramLinkRequests`). Any
 * failure here becomes a warning: the slides are already in, and the insert stands.
 */
import type { DeckApiErrorCode } from "../engine/src/contracts/deck-api.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import { diagramFileName, diagramFolderPath, diagramVersionOf, DRAWIO_FILE_MEDIA_TYPE } from "../converter/drawio-diagram.ts";
import { diagramLinkRequests } from "../converter/drawio-save-plan.ts";
import { stagedImageUrl } from "../converter/slide-image.ts";
import type { DriveClient } from "./drive-files.ts";
import type { InsertHtmlResponseBody, InsertPosition } from "./insert-html-contract.ts";
import type { JsonObject, ParsedDiagram, ParsedInsert, ParsedSlide, PlannedRequest } from "./insert-html-parse.ts";
import { googleFailureCodeOf, presentationAddressOf, type SlidesClient } from "./slides-client.ts";

export type InsertRunOutcome =
  | Readonly<{ kind: "inserted"; answer: InsertHtmlResponseBody }>
  | Readonly<{
      kind: "failed";
      code: DeckApiErrorCode;
      /** Names the slide, and how many before it are already in the presentation. */
      message: string;
      /** 1-based. */
      failedSlideNumber: number;
      insertedPageObjectIds: readonly string[];
    }>;

export async function runInsertHtml(options: Readonly<{ slides: SlidesClient; drive: DriveClient; insert: ParsedInsert }>): Promise<InsertRunOutcome> {
  const { slides, drive, insert } = options;
  const warnings: string[] = [];
  const inserted: string[] = [];
  for (const [index, slide] of insert.slides.entries()) {
    const slideNumber = index + 1;
    const written = await insertSlide({ slides, drive, presentationId: insert.presentationId, slide, insertionIndex: insertionIndexOf({ position: insert.position, offset: index }), warnings });
    if (written.kind === "failed") {
      const before = inserted.length === 0 ? "No slide was inserted." : inserted.length === 1 ? "Slide 1 was inserted." : `Slides 1 to ${inserted.length} were inserted.`;
      return { kind: "failed", code: googleFailureCodeOf(written.status), message: `Slide ${slideNumber} of ${insert.slides.length} could not be inserted: ${written.message} ${before}`, failedSlideNumber: slideNumber, insertedPageObjectIds: inserted };
    }
    inserted.push(slide.pageObjectId);
  }
  const diagrams = await writeDiagrams({ slides, drive, presentationId: insert.presentationId, diagrams: insert.slides.flatMap((slide) => slide.diagrams), warnings });
  return {
    kind: "inserted",
    answer: { presentationId: insert.presentationId, presentationAddress: presentationAddressOf(insert.presentationId), pageObjectIds: inserted, diagrams, warnings },
  };
}

/** `createSlide.insertionIndex` for the slide `offset` places after the first; null appends. */
export function insertionIndexOf(options: Readonly<{ position: InsertPosition; offset: number }>): number | null {
  const { position } = options;
  switch (position.kind) {
    case "end":
      return null;
    case "index":
      return position.index + options.offset;
    default:
      return assertNever(position);
  }
}

type StepOutcome = Readonly<{ kind: "ok" }> | Readonly<{ kind: "failed"; status: number; message: string }>;

async function insertSlide(
  options: Readonly<{ slides: SlidesClient; drive: DriveClient; presentationId: string; slide: ParsedSlide; insertionIndex: number | null; warnings: string[] }>,
): Promise<StepOutcome> {
  const { drive, slide } = options;
  const staged: string[] = [];
  try {
    const requests: JsonObject[] = [createSlideRequest({ pageObjectId: slide.pageObjectId, insertionIndex: options.insertionIndex })];
    for (const planned of slide.requests) {
      const resolved = await resolveRequest({ drive, planned, staged });
      if (resolved.kind === "failed") return { kind: "failed", status: resolved.status, message: `a picture could not be staged on Drive: ${resolved.message}` };
      requests.push(resolved.request);
    }
    const answer = await options.slides.batchUpdate({ presentationId: options.presentationId, requests });
    return answer.kind === "ok" ? { kind: "ok" } : { kind: "failed", status: answer.status, message: answer.message };
  } finally {
    for (const fileId of staged) {
      const deleted = await drive.deleteFile({ fileId });
      if (deleted.kind === "failed") options.warnings.push(`The staged picture ${fileId} could not be deleted from Drive: ${deleted.message}`);
    }
  }
}

function createSlideRequest(options: Readonly<{ pageObjectId: string; insertionIndex: number | null }>): JsonObject {
  // `objectId` first: the wire order the export's createSlide uses too.
  return {
    createSlide: {
      objectId: options.pageObjectId,
      ...(options.insertionIndex === null ? {} : { insertionIndex: options.insertionIndex }),
      slideLayoutReference: { predefinedLayout: "BLANK" },
    },
  };
}

async function resolveRequest(
  options: Readonly<{ drive: DriveClient; planned: PlannedRequest; staged: string[] }>,
): Promise<Readonly<{ kind: "ok"; request: JsonObject }> | Readonly<{ kind: "failed"; status: number; message: string }>> {
  const { drive, planned } = options;
  switch (planned.kind) {
    case "ready":
      return { kind: "ok", request: planned.request };
    case "stagedImage": {
      const uploaded = await drive.uploadFile({ name: planned.image.fileName, mediaType: planned.image.mediaType, bytes: planned.image.bytes, parentId: null });
      if (uploaded.kind === "failed") return uploaded;
      options.staged.push(uploaded.value);
      const shared = await drive.shareWithAnyoneReader({ fileId: uploaded.value });
      if (shared.kind === "failed") return shared;
      return { kind: "ok", request: { createImage: { ...planned.createImage, url: stagedImageUrl(uploaded.value) } } };
    }
    default:
      return assertNever(planned);
  }
}

async function writeDiagrams(
  options: Readonly<{ slides: SlidesClient; drive: DriveClient; presentationId: string; diagrams: readonly ParsedDiagram[]; warnings: string[] }>,
): Promise<readonly Readonly<{ diagramId: string; fileId: string }>[]> {
  const { drive, diagrams, warnings } = options;
  if (diagrams.length === 0) return [];
  const folder = await findOrCreateFolderPath({ drive, presentationId: options.presentationId });
  if (folder.kind === "failed") {
    warnings.push(`The diagrams' Drive folder could not be prepared, so no diagram is linked to its source: ${folder.message}`);
    return [];
  }
  const written: Readonly<{ diagramId: string; fileId: string }>[] = [];
  const fileIds = new Map<string, string>();
  for (const diagram of diagrams) {
    let fileId = fileIds.get(diagram.diagramId);
    if (fileId === undefined) {
      const saved = await saveDiagramFile({ drive, folderId: folder.folderId, diagram });
      if (saved.kind === "failed") {
        warnings.push(`The diagram ${diagram.diagramId} could not be saved to Drive: ${saved.message}`);
        continue;
      }
      fileId = saved.fileId;
      fileIds.set(diagram.diagramId, fileId);
      written.push({ diagramId: diagram.diagramId, fileId });
    }
    const linked = await options.slides.batchUpdate({
      presentationId: options.presentationId,
      requests: diagramLinkRequests({ objectId: diagram.objectId, fileId, stamp: { diagramId: diagram.diagramId, version: diagramVersionOf(diagram.xml) } }),
    });
    if (linked.kind === "failed") warnings.push(`The diagram ${diagram.diagramId} was saved but its picture could not be linked to it: ${linked.message}`);
  }
  return written;
}

async function findOrCreateFolderPath(
  options: Readonly<{ drive: DriveClient; presentationId: string }>,
): Promise<Readonly<{ kind: "ok"; folderId: string }> | Readonly<{ kind: "failed"; message: string }>> {
  let names: readonly string[];
  try {
    names = diagramFolderPath(options.presentationId);
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
  let parentId = "root";
  for (const name of names) {
    const found = await options.drive.findChild({ parentId, name, folder: true });
    if (found.kind === "failed") return { kind: "failed", message: found.message };
    if (found.value !== null) {
      parentId = found.value;
      continue;
    }
    const created = await options.drive.createFolder({ name, parentId });
    if (created.kind === "failed") return { kind: "failed", message: created.message };
    parentId = created.value;
  }
  return { kind: "ok", folderId: parentId };
}

async function saveDiagramFile(
  options: Readonly<{ drive: DriveClient; folderId: string; diagram: ParsedDiagram }>,
): Promise<Readonly<{ kind: "ok"; fileId: string }> | Readonly<{ kind: "failed"; message: string }>> {
  const { drive, diagram } = options;
  const name = diagramFileName(diagram.diagramId);
  const bytes = new Uint8Array(Buffer.from(diagram.xml, "utf8"));
  const existing = await drive.findChild({ parentId: options.folderId, name, folder: false });
  if (existing.kind === "failed") return { kind: "failed", message: existing.message };
  const saved =
    existing.value === null
      ? await drive.uploadFile({ name, mediaType: DRAWIO_FILE_MEDIA_TYPE, bytes, parentId: options.folderId })
      : await drive.updateFileContent({ fileId: existing.value, mediaType: DRAWIO_FILE_MEDIA_TYPE, bytes });
  return saved.kind === "ok" ? { kind: "ok", fileId: saved.value } : { kind: "failed", message: saved.message };
}
