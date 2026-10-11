// Turning a converted candidate into one Slides batchUpdate. Pure: the authorized call itself runs
// in Code.gs (`sashaInsert`), because that is where ScriptApp.getOAuthToken() is.

import type { SlidesApiRequest } from "./converter-contract.ts";

/** Slides accepts 5-50 chars of [a-zA-Z0-9_-] as a caller-supplied objectId. */
const OBJECT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const OBJECT_ID_RANDOM_CHARS = 12;

/**
 * A page id generated BEFORE the request is sent, because the converter needs the pageObjectId to
 * address the elements it creates -- so the page cannot be named by the server's reply.
 */
export function newPageObjectId({ random }: { random: () => number }): string {
  let suffix = "";
  for (let position = 0; position < OBJECT_ID_RANDOM_CHARS; position++) {
    const index = Math.floor(random() * OBJECT_ID_ALPHABET.length) % OBJECT_ID_ALPHABET.length;
    suffix += OBJECT_ID_ALPHABET[index] ?? "0";
  }
  return `sasha_${suffix}`;
}

/**
 * WHAT THE PREVIEW CONVERSION IS ASKED, and it is a pure function of the candidate.
 *
 * The preview's requests are never sent to the user's deck: `sashaRenderPreviews` retargets every
 * request at a page of its own throwaway deck (build-addon.ts `sashaRetargetToPage_`), so the page
 * id here only has to be well formed and stable. It USED to be `newPageObjectId({ random })`,
 * which baked a fresh random id into every request -- so `renderKeyOf(requests)` was different on
 * every open and the render cache could never hit, and neither could a cache of the conversion.
 * Insert still converts afresh with a fresh id (`newPageObjectId`), because there the page id has
 * to be the one Slides actually creates.
 */
export function previewConversionSpec({
  proposalId,
  index,
  html,
  presentationId,
}: {
  proposalId: string;
  index: number;
  html: string;
  presentationId: string;
}): Readonly<{ html: string; presentationId: string; pageObjectId: string; objectIdPrefix: string }> {
  const prefix = previewPrefix({ proposalId, index });
  // Slides object ids are 5-50 chars of [a-zA-Z0-9_-]. The index goes FIRST so clipping a long
  // proposal id to fit can never make two candidates share a page id.
  const pageObjectId = `sashaprev_${String(index)}_${prefix}`.slice(0, 50);
  return { html, presentationId, pageObjectId, objectIdPrefix: prefix };
}

/**
 * `createSlide` first, then whatever the converter emitted. The new page is APPENDED (no
 * `insertionIndex`): a sidebar cannot reliably read the filmstrip's selected index out of Google's
 * virtualized React UI, and appending is at least predictable enough for the user to drag the slide
 * where they want it.
 */
export function insertRequests({
  pageObjectId,
  converted,
}: {
  pageObjectId: string;
  converted: readonly SlidesApiRequest[];
}): readonly SlidesApiRequest[] {
  return [
    {
      createSlide: {
        objectId: pageObjectId,
        slideLayoutReference: { predefinedLayout: "BLANK" },
      },
    },
    ...converted,
  ];
}

/** Unique per candidate within the presentation, which is what the converter's allocator needs. */
function previewPrefix({ proposalId, index }: { proposalId: string; index: number }): string {
  return `${proposalId.replace(/[^A-Za-z0-9_-]/g, "")}_${String(index)}`;
}
