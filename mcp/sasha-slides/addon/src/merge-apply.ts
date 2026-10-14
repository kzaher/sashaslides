// APPLYING A PICKED MERGE CANDIDATE: read the slide, convert onto it, plan, send ONE batchUpdate.
//
// The insert path (dialog.tsx `insertPicked`) converts a candidate onto a NEW page id and prepends
// `createSlide`. A merge (PROTOCOL.md "Merge proposals") converts onto the TARGET slide's own page
// id and lets slide-merge.ts plan the deletes, creates and z-order moves. Separate from the dialog
// so every refusal below is unit-tested against the fake Drive instead of only being reachable by
// clicking a real window.
//
// ORDER IS THE SAFETY PROPERTY. Nothing is sent until the slide has been read NOW and the plan
// accepted, and what is sent is one batchUpdate, which Slides applies atomically. So every outcome
// other than `applied` leaves the user's slide exactly as it was.

import type { RenderRequest } from "./bridge.ts";
import type { ConvertSlideHtml } from "./converter-contract.ts";
import { createdObjectIdsOf, type SlidesApi } from "./drive-api.ts";
import { removalFor, type MergeSpec } from "./protocol.ts";
import { describeMergeRefusal, planMerge } from "./slide-merge.ts";

export type MergeApplyOutcome =
  /** The slide is redesigned. `createdObjectIds` is what the batch reply says Slides made. */
  | Readonly<{ kind: "applied"; pageObjectId: string; createdObjectIds: readonly string[]; renderArtifact: string | null }>
  /** Nothing was sent: the merge could not be planned safely. `message` is for the user. */
  | Readonly<{ kind: "refused"; message: string }>
  /** A host call or the conversion failed; nothing changed (the batch is atomic). */
  | Readonly<{ kind: "failed"; message: string }>;

export async function applyMergeCandidate({
  slides,
  convert,
  merge,
  openPresentationId,
  index,
  html,
  objectIdPrefix,
  render,
  onSending,
}: {
  slides: SlidesApi;
  convert: ConvertSlideHtml;
  merge: MergeSpec;
  /** The deck this window has open; a merge only ever touches the deck it names. */
  openPresentationId: string;
  /** The picked candidate, 1-based. */
  index: number;
  html: string;
  /** Unique per apply, so the new elements' ids cannot clash with the slide's. */
  objectIdPrefix: string;
  render: RenderRequest | null;
  /** Called once the plan is accepted and the batchUpdate is about to go, for the stage indicator. */
  onSending: () => void;
}): Promise<MergeApplyOutcome> {
  if (merge.presentationId !== openPresentationId) {
    return {
      kind: "refused",
      message:
        `this proposal redesigns a slide in another presentation (${merge.presentationId}); ` +
        "open that deck to apply it",
    };
  }
  const page = await slides.pageElements({ presentationId: merge.presentationId, pageObjectId: merge.slideObjectId });
  if (page.kind !== "ok") {
    return { kind: "failed", message: `could not read slide ${merge.slideObjectId}: ${page.message}` };
  }

  let converted;
  try {
    converted = await convert({
      html,
      presentationId: merge.presentationId,
      pageObjectId: merge.slideObjectId,
      objectIdPrefix,
    });
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }

  const plan = planMerge({
    pageObjectId: merge.slideObjectId,
    existingObjectIds: page.value.objectIds,
    remove: removalFor({ merge, index }),
    newElements: converted.stackedElements,
  });
  if (plan.kind === "refused") return { kind: "refused", message: describeMergeRefusal(plan.refusal) };

  onSending();
  const sent = await slides.insert({ presentationId: merge.presentationId, requests: plan.requests, render });
  if (sent.kind !== "ok") return { kind: "failed", message: sent.message };
  return {
    kind: "applied",
    pageObjectId: merge.slideObjectId,
    createdObjectIds: createdObjectIdsOf(sent.value.batchResponse),
    renderArtifact: sent.value.renderArtifact,
  };
}
