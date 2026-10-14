// MERGING A CANDIDATE INTO AN EXISTING SLIDE: the batchUpdate that redesigns part of a slide.
//
// An insert (slide-insert.ts) makes a new page and fills it. A merge (PROTOCOL.md "Merge
// proposals") leaves the page where it is: it deletes the existing elements the candidate names in
// `remove`, creates the candidate's new elements ON that page, and then stacks the new elements
// against what is left. This file is that plan, as a pure function of what the slide holds now and
// what the converter produced; the authorized call runs in Code.gs (`sashaInsert`), exactly as an
// insert's does.
//
// STACKING. Slides orders a page's elements by `page.pageElements`, back to front, and a created
// element lands ON TOP. The candidate gives each new element a CSS z-index on its top-level box
// (converter `StackedElement.zIndex`); the slide's kept content is treated as ONE layer at z-index
// 0. So:
//
//   * every new element is created in (zIndex, document order) -- which already leaves the
//     non-negative ones in front of the kept content, in order, because creation appends on top;
//   * then the negative ones are sent to the back one at a time, frontmost first, so the one with
//     the lowest z-index ends up rearmost. One request per element, rather than one request naming
//     them all, because a single SEND_TO_BACK's treatment of several ids' relative order is not
//     something this code has measured.
//
// EVERYTHING IS ONE batchUpdate, which Slides applies atomically: either the slide is redesigned
// or it is untouched. And a `remove` id that is not on the slide NOW is refused before anything is
// sent -- the slide may have changed since Claude captured it, and deleting by a stale id must
// never be a silent skip (or, worse, a deleteObject that finds the id on ANOTHER slide).

import type { SlidesApiRequest, StackedElement } from "./converter-contract.ts";
import { assertNever } from "./protocol.ts";

/** Why a merge was not planned. Every variant is something the user must be told, by `describeMergeRefusal`. */
export type MergeRefusal =
  /** `remove` names ids that are not top-level elements of the slide any more. */
  | Readonly<{ kind: "unknown-remove-ids"; pageObjectId: string; objectIds: readonly string[] }>
  /** The converter addressed an element at a different page: it was asked for the wrong one. */
  | Readonly<{ kind: "wrong-page"; pageObjectId: string; objectId: string; targetedPageObjectId: string }>
  /** A new element's id is already taken on the slide, so its create would fail the whole batch. */
  | Readonly<{ kind: "id-collision"; objectIds: readonly string[] }>
  /** Nothing to remove and nothing to add: a batchUpdate with no requests is not a redesign. */
  | Readonly<{ kind: "empty" }>;

export type MergePlan =
  | Readonly<{
      kind: "planned";
      requests: readonly SlidesApiRequest[];
      /** The new elements' object ids, back to front as they will stand on the slide. */
      createdObjectIds: readonly string[];
    }>
  | Readonly<{ kind: "refused"; refusal: MergeRefusal }>;

/**
 * The one batchUpdate for a merge: deletes, then creates in stacking order, then the z-order moves
 * that put the negative-z elements behind everything. `existingObjectIds` is the slide's top-level
 * `pageElements` in their order now (back to front); only those ids may be removed.
 */
export function planMerge({
  pageObjectId,
  existingObjectIds,
  remove,
  newElements,
}: {
  pageObjectId: string;
  existingObjectIds: readonly string[];
  remove: readonly string[];
  newElements: readonly StackedElement[];
}): MergePlan {
  const existing = new Set(existingObjectIds);
  const removals = [...new Set(remove)];
  const unknown = removals.filter((objectId) => !existing.has(objectId));
  if (unknown.length > 0) {
    return { kind: "refused", refusal: { kind: "unknown-remove-ids", pageObjectId, objectIds: unknown } };
  }

  // Stable sort: equal z-indices keep document (paint) order.
  const stacked = newElements
    .map((element, position) => ({ element, position }))
    .sort((left, right) => left.element.zIndex - right.element.zIndex || left.position - right.position)
    .map(({ element }) => element);

  const creates: SlidesApiRequest[] = [];
  const createdBehind: string[] = [];
  const createdInFront: string[] = [];
  for (const element of stacked) {
    for (const request of element.requests) {
      const created = createdElementOf(request);
      if (created !== null) {
        if (created.pageObjectId !== pageObjectId) {
          return {
            kind: "refused",
            refusal: { kind: "wrong-page", pageObjectId, objectId: created.objectId, targetedPageObjectId: created.pageObjectId },
          };
        }
        (element.zIndex < 0 ? createdBehind : createdInFront).push(created.objectId);
      }
      creates.push(request);
    }
  }

  const createdObjectIds = [...createdBehind, ...createdInFront];
  // Removed ids are deleted first in the same batch, so re-using one is legal; any other clash is not.
  const removedSet = new Set(removals);
  const collisions = createdObjectIds.filter((objectId) => existing.has(objectId) && !removedSet.has(objectId));
  if (collisions.length > 0) return { kind: "refused", refusal: { kind: "id-collision", objectIds: collisions } };

  const deletes: SlidesApiRequest[] = removals.map((objectId) => ({ deleteObject: { objectId } }));
  // Frontmost first, so the LAST one sent -- the lowest z-index -- ends up rearmost.
  const sendToBack: SlidesApiRequest[] = [...createdBehind].reverse().map((objectId) => ({
    updatePageElementsZOrder: { pageElementObjectIds: [objectId], operation: "SEND_TO_BACK" },
  }));

  const requests = [...deletes, ...creates, ...sendToBack];
  if (requests.length === 0) return { kind: "refused", refusal: { kind: "empty" } };
  return { kind: "planned", requests, createdObjectIds };
}

/** The sentence the slides window shows for a refusal. */
export function describeMergeRefusal(refusal: MergeRefusal): string {
  switch (refusal.kind) {
    case "unknown-remove-ids":
      return (
        `nothing was changed: the candidate removes ${refusal.objectIds.join(", ")}, which ` +
        `${refusal.objectIds.length === 1 ? "is" : "are"} no longer on slide ${refusal.pageObjectId}. ` +
        "The slide changed after the candidates were made; ask Sasha for a fresh set."
      );
    case "wrong-page":
      return `nothing was changed: the converted element ${refusal.objectId} targets page ${refusal.targetedPageObjectId}, not ${refusal.pageObjectId}`;
    case "id-collision":
      return `nothing was changed: the slide already has elements named ${refusal.objectIds.join(", ")}`;
    case "empty":
      return "nothing was changed: this candidate neither removes nor adds anything";
    default:
      return assertNever(refusal);
  }
}

/** The request kinds the converter creates page elements with (converter/slides-api.ts). */
const CREATE_KEYS = ["createShape", "createLine", "createImage", "createTable"] as const;

/** The element a create request makes and the page it puts it on, or null for any other request. */
function createdElementOf(request: SlidesApiRequest): Readonly<{ objectId: string; pageObjectId: string }> | null {
  for (const key of CREATE_KEYS) {
    const body = asRecord(request[key]);
    if (body === null) continue;
    const objectId = body["objectId"];
    const pageObjectId = asRecord(body["elementProperties"])?.["pageObjectId"];
    if (typeof objectId !== "string" || typeof pageObjectId !== "string") return null;
    return { objectId, pageObjectId };
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
