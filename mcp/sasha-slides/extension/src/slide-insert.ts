// Turning a converted candidate into one Slides batchUpdate. Pure: the authorized call itself lives
// in the offscreen document (drive-api.ts), because that is where the token is.

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
 * `createSlide` first, then whatever the converter emitted. The new page is APPENDED (no
 * `insertionIndex`): a content script cannot reliably read the filmstrip's selected index out of
 * Google's virtualized React UI, and appending is at least predictable enough for the user to
 * drag the slide where they want it.
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
