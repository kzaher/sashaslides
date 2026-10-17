// THE INSERT PATH, IN THE ORDER THE USER FEELS IT: what must happen before the window may say
// "Inserted", and what is bookkeeping that happens after.
//
// WHY IT IS SPLIT IN TWO. The user asked "why is insert taking ages if it already has rendered
// preview?", and the answer was all on this path: the candidate was CONVERTED AGAIN although the
// preview had converted it already, and after the batchUpdate the same round trip photographed the
// new page and wrote it to Drive (getThumbnail 0.8-1.2 s, a 0.25-0.3 s download, a folder lookup,
// a create and a tag), then PICK and the `slide-inserted` event went out one after the other at
// ~0.7 s of google.script.run overhead each -- all while the slide was already in the deck. Now:
//
//   1. `conversionForInsert`: the preview's conversion, renamed, when the window has it.
//   2. `insertNewSlide`: ONE host call, the batchUpdate. Its success is the user's answer.
//   3. `recordInsert`: PICK, the event and the render artifact, CONCURRENTLY, after the window has
//      already said so. None of them can turn the insert into a failure: the slide is in the deck,
//      and a failure here must never invite the user to insert it a second time.
//
// PICK IS NOT HELD BACK FOR THE RENDER any more. PROTOCOL.md requires neither order: `slide_images`
// answers "unavailable" until a render exists, and PICK carries `insertedObjectIds`, which is what
// `clear_slides` honours if the event has not landed yet. Separate from dialog.tsx so the order and
// the count of host calls are asserted against the fake Drive (insert-flow.test.ts).

import type { ConvertedDiagram } from "../../converter/convert-html-to-slide-requests.ts";
import type { RenderRequest } from "./bridge.ts";
import type { ConversionResult, SlidesApiRequest } from "./converter-contract.ts";
import type { DiagramLinkSpec } from "./diagram-host.ts";
import type { DiagramsLinked } from "./diagram-wire.ts";
import { createdObjectIdsOf, type DiagramApi, type SlidesApi } from "./drive-api.ts";
import type { PickOutcome } from "./pick-writer.ts";
import { renderArtifactOf, type RenderArtifactOutcome } from "./render-artifact.ts";
import {
  insertedWhereOf,
  insertRequests,
  retargetConversionNamed,
  type InsertedWhere,
  type InsertPosition,
} from "./slide-insert.ts";

/** What a pick put in the deck: the ids Slides created, their page, and where that page landed. */
export type Inserted = Readonly<{
  objectIds: readonly string[];
  pageObjectId: string | null;
  /** null for a merge, which redesigns a slide in place and so has no position to report. */
  where: InsertedWhere | null;
}>;

export type InsertAttempt = Readonly<{ kind: "inserted"; inserted: Inserted }> | Readonly<{ kind: "failed"; message: string }>;

/**
 * The requests to insert, from the PREVIEW'S conversion when this window already has it, converted
 * afresh only when it does not. `reused` is reported so the test -- and a console line -- can tell
 * which happened. `diagrams` are the draw.io pictures under the ids they will have IN THE DECK, so the
 * insert can link them to their sources afterwards; a diagram whose picture was not renamed (it is
 * not among the requests) is dropped rather than pointed at an id that will not exist.
 */
export async function conversionForInsert({
  preview,
  previewPageObjectId,
  pageObjectId,
  convert,
}: {
  /** The preview's conversion of exactly this HTML, or null when it never finished or was evicted. */
  preview: ConversionResult | null;
  previewPageObjectId: string;
  /** The page id Slides will create. */
  pageObjectId: string;
  convert: () => Promise<ConversionResult>;
}): Promise<Readonly<{ requests: readonly SlidesApiRequest[]; reused: boolean; diagrams: readonly ConvertedDiagram[] }>> {
  if (preview !== null) {
    const retargeted = retargetConversionNamed({ requests: preview.requests, fromPageObjectId: previewPageObjectId, toPageObjectId: pageObjectId });
    const diagrams = (preview.drawioDiagrams ?? []).flatMap((diagram) => {
      const objectId = retargeted.renamed.get(diagram.objectId);
      return objectId === undefined ? [] : [{ ...diagram, objectId }];
    });
    return { requests: retargeted.requests, reused: true, diagrams };
  }
  const converted = await convert();
  return { requests: converted.requests, reused: false, diagrams: converted.drawioDiagrams ?? [] };
}

/**
 * AFTER THE USER HAS BEEN TOLD: the inserted diagrams' source files, links and stamps, in one host
 * call. Best effort like the render artifact: the slide is in the deck and its pictures are right,
 * so a failure here costs only the edit link (the diagram dialog can still upload the source), and
 * it is logged, never shown as a failed insert. No call at all for a slide without diagrams.
 */
export async function linkInsertedDiagramsBestEffort({
  diagramsApi,
  spec,
  warn,
}: {
  diagramsApi: DiagramApi;
  spec: DiagramLinkSpec | null;
  warn: (message: string) => void;
}): Promise<DiagramsLinked | null> {
  if (spec === null) return null;
  try {
    const linked = await diagramsApi.linkInserted(spec);
    if (linked.kind === "ok") return linked.value;
    warn(`the inserted diagrams were not linked to their sources: ${linked.message}`);
  } catch (cause) {
    warn(`the inserted diagrams were not linked to their sources: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return null;
}

/**
 * THE ONE HOST CALL the user waits for: `createSlide` placed against the selected slide, plus the
 * converted elements, as one batchUpdate.
 */
export async function insertNewSlide({
  slides,
  presentationId,
  pageObjectId,
  converted,
  position,
}: {
  slides: SlidesApi;
  presentationId: string;
  pageObjectId: string;
  converted: readonly SlidesApiRequest[];
  position: InsertPosition;
}): Promise<InsertAttempt> {
  const sent = await slides.insert({
    presentationId,
    requests: insertRequests({ pageObjectId, converted }),
    position,
  });
  if (sent.kind !== "ok") return { kind: "failed", message: sent.message };
  const objectIds = createdObjectIdsOf(sent.value.batchResponse);
  return {
    kind: "inserted",
    inserted: { objectIds, pageObjectId: objectIds[0] ?? pageObjectId, where: insertedWhereOf(sent.value.insertionIndex) },
  };
}

/**
 * THE BOOKKEEPING, AFTER THE USER HAS BEEN TOLD: PICK, the session event and the render artifact,
 * all started at once. Only PICK's outcome is returned, because it is the one the window reports
 * ("Sasha has been told"); the other two are logged and otherwise forgotten.
 */
export async function recordInsert({
  slides,
  presentationId,
  render,
  writePick,
  appendEvent,
  warn,
}: {
  slides: SlidesApi;
  presentationId: string;
  render: RenderRequest | null;
  writePick: () => Promise<PickOutcome>;
  appendEvent: () => Promise<void>;
  warn: (message: string) => void;
}): Promise<PickOutcome> {
  const [picked, , rendered] = await Promise.all([
    writePick(),
    appendEvent(),
    writeRenderBestEffort({ slides, presentationId, render }),
  ]);
  if (rendered.kind === "skipped") warn(`no render artifact: ${rendered.reason}`);
  return picked;
}

/** The render artifact, or the reason there is none. Never throws, never fails the insert. */
async function writeRenderBestEffort({
  slides,
  presentationId,
  render,
}: {
  slides: SlidesApi;
  presentationId: string;
  render: RenderRequest | null;
}): Promise<RenderArtifactOutcome> {
  if (render === null) return renderArtifactOf({ renderArtifact: null, requested: null });
  try {
    const written = await slides.writeRender({ presentationId, render });
    return renderArtifactOf({ renderArtifact: written.kind === "ok" ? written.value.renderArtifact : null, requested: render });
  } catch (cause) {
    return { kind: "skipped", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
