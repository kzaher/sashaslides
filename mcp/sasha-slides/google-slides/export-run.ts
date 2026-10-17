/**
 * Running an export plan: on the server with the account's own grant (`runExport`), or flattened
 * for the add-on, whose Code.gs runs it with the add-on's authorization (`addonExportRequests`).
 *
 * ORDER, AND WHY A FAILURE IS SAFE: optional deletion batches, then one batch per slide in slide
 * order, stopping at the first failure, which is reported by slide number; then the clean-up batch
 * (a new presentation's default slide, or slides an earlier export made that the deck no longer
 * has); then the speaker notes, which need the notes shapes' ids that `createSlide` assigns
 * (read back with one `presentations.get`). The slides before a failed one stay written; the next
 * export replaces them again because pages are addressed by the engine's ids (SPEC.md 21.12).
 *
 * WHICH PAGES ARE OURS ON A RE-EXPORT: the link records only the presentation, so a page counts as
 * written by an earlier export when its id is engine-minted (`sl_`) or is one of the deck's slide
 * ids; anything else was added in Slides by hand and is kept. (A per-link list of exported page ids
 * would be exact; it is listed as a contract change.)
 */
import type { DeckApiErrorCode, GoogleSlidesExportReport, InterchangeLoss } from "../engine/src/contracts/deck-api.ts";
import type { DocumentSnapshot } from "../engine/src/contracts/document.ts";
import type { AssetId, SlideId } from "../engine/src/contracts/ids.ts";
import { OBJECT_ID_REUSE_AFTER_DELETE, planExport, type ExportPlan } from "./export-deck.ts";
import { googleFailureCodeOf, presentationAddressOf, type SlidesClient } from "./slides-client.ts";
import type { ExportInstruction, ExportRequest } from "./slides-requests.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type ExportTarget =
  | Readonly<{ kind: "newPresentation" }>
  /** `importedPageIds`: the link's record of the pages the last import read (GoogleSlidesLink). */
  | Readonly<{ kind: "linkedPresentation"; presentationId: string; importedPageIds: readonly string[] }>;

export type ExportRunOutcome =
  | Readonly<{ kind: "exported"; report: GoogleSlidesExportReport; title: string }>
  | Readonly<{
      kind: "failed";
      code: DeckApiErrorCode;
      message: string;
      /** The slide whose batch Google refused, 1-based; null when the export failed before any slide. */
      failedSlideNumber: number | null;
      presentationId: string | null;
    }>;

export async function runExport(
  options: Readonly<{ slides: SlidesClient; snapshot: DocumentSnapshot; target: ExportTarget; assetAddress: (assetId: AssetId) => string }>,
): Promise<ExportRunOutcome> {
  const { slides, snapshot } = options;
  const opened = await openTarget({ slides, snapshot, target: options.target });
  if (opened.kind === "failed") return opened;
  const { presentationId, existingPageIds } = opened;
  const plan = planExport({
    snapshot,
    assetAddress: options.assetAddress,
    pageExists: (slideId) => existingPageIds.includes(slideId),
    reuseInOneBatch: OBJECT_ID_REUSE_AFTER_DELETE.sameBatch,
  });
  let requestCount = 0;
  const send = async (requests: readonly ExportRequest[]): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; status: number; message: string }>> => {
    if (requests.length === 0) return { ok: true };
    requestCount += requests.length;
    const answer = await slides.batchUpdate({ presentationId, requests });
    return answer.kind === "ok" ? { ok: true } : { ok: false, status: answer.status, message: answer.message };
  };

  for (const deletion of plan.deletionBatches) {
    const sent = await send(deletion.requests);
    if (!sent.ok) return slideFailure({ plan, slideId: deletion.slideId, status: sent.status, message: sent.message, presentationId });
  }
  const written: SlideId[] = [];
  for (const batch of plan.batches) {
    const sent = await send(batch.requests);
    if (!sent.ok) {
      await writeNotes({ slides, presentationId, plan, written });
      return slideFailure({ plan, slideId: batch.slideId, status: sent.status, message: sent.message, presentationId });
    }
    written.push(batch.slideId);
  }
  const cleanup = stalePages({ existingPageIds, snapshot, target: options.target }).map((objectId): ExportRequest => ({ deleteObject: { objectId } }));
  const cleaned = await send(cleanup);
  if (!cleaned.ok) return { kind: "failed", code: googleFailureCodeOf(cleaned.status), message: `The slides were written but old ones could not be removed: ${cleaned.message}`, failedSlideNumber: null, presentationId };
  requestCount += await writeNotes({ slides, presentationId, plan, written });
  return {
    kind: "exported",
    title: plan.title,
    report: { presentationId, presentationAddress: presentationAddressOf(presentationId), slideCount: plan.batches.length, requestCount, losses: plan.losses },
  };
}

/**
 * The add-on's flat request list (AddonExportPlanBody.requests): each slide's requests after a
 * `sashaSlideBoundary`, the clean-up deletions, then one `sashaSpeakerNotes` per slide with notes.
 * Code.gs sends one batch per boundary, so a failure names its slide there too.
 */
export function addonExportRequests(
  options: Readonly<{
    snapshot: DocumentSnapshot;
    existingPageIds: readonly string[];
    importedPageIds: readonly string[];
    assetAddress: (assetId: AssetId) => string;
  }>,
): Readonly<{ requests: readonly (ExportRequest | ExportInstruction)[]; losses: readonly InterchangeLoss[] }> {
  const { snapshot, existingPageIds } = options;
  const plan = planExport({
    snapshot,
    assetAddress: options.assetAddress,
    pageExists: (slideId) => existingPageIds.includes(slideId),
    reuseInOneBatch: OBJECT_ID_REUSE_AFTER_DELETE.sameBatch,
  });
  const requests: (ExportRequest | ExportInstruction)[] = [];
  for (const deletion of plan.deletionBatches) {
    requests.push({ sashaSlideBoundary: { slideId: deletion.slideId, slideNumber: 0 } }, ...deletion.requests);
  }
  for (const batch of plan.batches) requests.push({ sashaSlideBoundary: { slideId: batch.slideId, slideNumber: batch.slideNumber } }, ...batch.requests);
  const stale = stalePages({ existingPageIds, snapshot, target: { kind: "linkedPresentation", presentationId: "", importedPageIds: options.importedPageIds } });
  if (stale.length > 0) requests.push({ sashaSlideBoundary: { slideId: "cleanup", slideNumber: 0 } }, ...stale.map((objectId): ExportRequest => ({ deleteObject: { objectId } })));
  for (const batch of plan.batches) if (batch.speakerNotes !== null) requests.push({ sashaSpeakerNotes: { slideObjectId: batch.slideId, text: batch.speakerNotes } });
  return { requests, losses: plan.losses };
}

type OpenedTarget = Readonly<{ kind: "opened"; presentationId: string; existingPageIds: readonly string[] }> | Extract<ExportRunOutcome, { kind: "failed" }>;

async function openTarget(options: Readonly<{ slides: SlidesClient; snapshot: DocumentSnapshot; target: ExportTarget }>): Promise<OpenedTarget> {
  const { slides, snapshot, target } = options;
  switch (target.kind) {
    case "newPresentation": {
      const created = await slides.createPresentation({
        title: snapshot.title,
        widthEnglishMetricUnits: 9_144_000,
        heightEnglishMetricUnits: Math.round(snapshot.pageSize.height * 7143.75),
      });
      if (created.kind === "failed") return { kind: "failed", code: googleFailureCodeOf(created.status), message: created.message, failedSlideNumber: null, presentationId: null };
      const presentationId = stringField(created.body, "presentationId");
      if (presentationId === null) return { kind: "failed", code: "googleFailed", message: "Google created no presentation id.", failedSlideNumber: null, presentationId: null };
      return { kind: "opened", presentationId, existingPageIds: pageIdsOf(created.body) };
    }
    case "linkedPresentation": {
      const read = await slides.getPresentation({ presentationId: target.presentationId, fields: "slides(objectId)" });
      if (read.kind === "failed") return { kind: "failed", code: googleFailureCodeOf(read.status), message: read.message, failedSlideNumber: null, presentationId: target.presentationId };
      return { kind: "opened", presentationId: target.presentationId, existingPageIds: pageIdsOf(read.body) };
    }
    default:
      return assertNever(target);
  }
}

/** Pages to delete after the slides are written (see the header). */
function stalePages(options: Readonly<{ existingPageIds: readonly string[]; snapshot: DocumentSnapshot; target: ExportTarget }>): readonly string[] {
  const deckSlideIds = new Set<string>(options.snapshot.slides.map((slide) => slide.id));
  switch (options.target.kind) {
    case "newPresentation":
      return options.existingPageIds.filter((pageId) => !deckSlideIds.has(pageId));
    case "linkedPresentation": {
      // Ours to remove: pages an earlier export wrote (sl_…) and pages the import read, when the deck
      // no longer holds them. A page someone added in Google after the import is neither, and stays.
      const imported = new Set(options.target.importedPageIds);
      return options.existingPageIds.filter((pageId) => !deckSlideIds.has(pageId) && (pageId.startsWith("sl_") || imported.has(pageId)));
    }
    default:
      return assertNever(options.target);
  }
}

/** Reads the notes shapes' ids of the written slides and fills them; returns the requests sent. */
async function writeNotes(options: Readonly<{ slides: SlidesClient; presentationId: string; plan: ExportPlan; written: readonly SlideId[] }>): Promise<number> {
  const withNotes = options.plan.batches.filter((batch) => batch.speakerNotes !== null && options.written.includes(batch.slideId));
  if (withNotes.length === 0) return 0;
  const read = await options.slides.getPresentation({
    presentationId: options.presentationId,
    fields: "slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))",
  });
  if (read.kind === "failed") return 0;
  const notesIds = notesIdsOf(read.body);
  const requests: ExportRequest[] = [];
  for (const batch of withNotes) {
    const notesId = notesIds.get(batch.slideId);
    if (notesId !== undefined && batch.speakerNotes !== null) requests.push({ insertText: { objectId: notesId, text: batch.speakerNotes, insertionIndex: 0 } });
  }
  if (requests.length === 0) return 0;
  await options.slides.batchUpdate({ presentationId: options.presentationId, requests });
  return requests.length;
}

function slideFailure(options: Readonly<{ plan: ExportPlan; slideId: SlideId; status: number; message: string; presentationId: string }>): ExportRunOutcome {
  const slideNumber = options.plan.batches.find((batch) => batch.slideId === options.slideId)?.slideNumber ?? null;
  return {
    kind: "failed",
    code: googleFailureCodeOf(options.status),
    message: `Google Slides refused slide ${slideNumber ?? "?"}: ${options.message}. The slides before it were written; exporting again replaces them.`,
    failedSlideNumber: slideNumber,
    presentationId: options.presentationId,
  };
}

/** `slides[].objectId` of a Presentation answer. */
export function pageIdsOf(body: unknown): readonly string[] {
  const slides = arrayField(body, "slides");
  return slides.map((slide) => stringField(slide, "objectId")).filter((objectId): objectId is string => objectId !== null);
}

export function notesIdsOf(body: unknown): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const slide of arrayField(body, "slides")) {
    const slideId = stringField(slide, "objectId");
    const notesId = stringField(objectField(objectField(objectField(slide, "slideProperties"), "notesPage"), "notesProperties"), "speakerNotesObjectId");
    if (slideId !== null && notesId !== null) ids.set(slideId, notesId);
  }
  return ids;
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  // A non-null object that has `key` (just checked): reading that one key is safe, and its value stays `unknown`.
  return (value as Readonly<Record<string, unknown>>)[key];
}

function stringField(value: unknown, key: string): string | null {
  const field = objectField(value, key);
  return typeof field === "string" ? field : null;
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  const field = objectField(value, key);
  return Array.isArray(field) ? field : [];
}
