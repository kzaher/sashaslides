// Turning a converted candidate into one Slides batchUpdate. Pure: the authorized call itself runs
// in Code.gs (`sashaInsert`), because that is where ScriptApp.getOAuthToken() is.

import type { SlidesApiRequest } from "./converter-contract.ts";
import { assertNever } from "./protocol.ts";

/**
 * Where the new slide goes, relative to the slide the user has SELECTED in the deck. There is no
 * "end" arm on purpose: the end is what happens when nothing is selected, not something to ask for.
 */
export type InsertPosition = "before" | "after";

/**
 * Where the slide actually landed, as Code.gs reported it. `end` is the fallback when no slide was
 * selected (or the selection could not be read), and the window says so rather than leaving the
 * user to hunt for it.
 */
export type InsertedWhere = Readonly<{ kind: "at"; slideNumber: number }> | Readonly<{ kind: "end" }>;

/** Slides accepts 5-50 chars of [a-zA-Z0-9_-] as a caller-supplied objectId. */
const OBJECT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const OBJECT_ID_RANDOM_CHARS = 12;
/** The request fields that NAME an object, as the converter emits them (converter/emit-*.ts). */
const OBJECT_ID_KEYS: ReadonlySet<string> = new Set(["objectId", "pageObjectId"]);

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
 * Insert REUSES this conversion when it has it (`retargetConversion`), renamed onto the page id
 * Slides will actually create.
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
 * THE PREVIEW'S CONVERSION, RENAMED FOR THE INSERT, so picking a candidate whose preview already
 * converted does not convert it a second time (seconds of offscreen iframe work on the main thread).
 *
 * Only the NAMES differ between the two conversions: the preview page id becomes the new page id,
 * and every other object id is renamed to a fresh one under it. Fresh rather than kept, because the
 * preview ids are a pure function of the candidate (`previewConversionSpec`) -- inserting the same
 * candidate twice would otherwise ask Slides to create an id the deck already holds, and the whole
 * batch would be refused.
 */
export function retargetConversion({
  requests,
  fromPageObjectId,
  toPageObjectId,
}: {
  requests: readonly SlidesApiRequest[];
  fromPageObjectId: string;
  toPageObjectId: string;
}): readonly SlidesApiRequest[] {
  const renamed = new Map<string, string>([[fromPageObjectId, toPageObjectId]]);
  const rename = (objectId: string): string => {
    const known = renamed.get(objectId);
    if (known !== undefined) return known;
    const fresh = `${toPageObjectId}_${String(renamed.size)}`;
    renamed.set(objectId, fresh);
    return fresh;
  };
  return requests.map((request) => renamedRecord({ record: request, rename }));
}

/**
 * `createSlide` first, then whatever the converter emitted. It carries NO `insertionIndex`, and
 * that is deliberate: the position is decided by Code.gs at insert time (`insertionIndexFor`),
 * because only the server side can read the slide the user has selected NOW -- `SlidesApp`'s
 * selection, not the filmstrip's virtualized React UI, and not a value read when the window opened,
 * since the user may click another slide while it is open.
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

/**
 * THE 0-BASED `createSlide.insertionIndex` for a slide placed relative to the selected one, or null
 * for "append at the end" (nothing selected, or a selection that is not one of the deck's slides).
 * Before = the selected slide's own index (it moves down one), after = the index past it.
 *
 * IT RUNS IN Code.gs, VERBATIM: build-addon.ts embeds `insertionIndexFor.toString()`, so the rule
 * the tests check is the rule the server executes. That is why it is SELF-CONTAINED -- no imports,
 * no helpers, no `assertNever`, no syntax Apps Script's V8 lacks. slide-insert.test.ts evaluates its
 * source text on its own to prove it.
 */
export function insertionIndexFor({
  position,
  selectedSlideIndex,
  slideCount,
}: {
  position: InsertPosition;
  selectedSlideIndex: number | null;
  slideCount: number;
}): number | null {
  if (selectedSlideIndex === null || !Number.isInteger(selectedSlideIndex)) return null;
  if (selectedSlideIndex < 0 || selectedSlideIndex >= slideCount) return null;
  if (position === "before") return selectedSlideIndex;
  if (position === "after") return selectedSlideIndex + 1;
  return null;
}

/** What Code.gs reported, as the window will say it. A null index is the append fallback. */
export function insertedWhereOf(insertionIndex: number | null): InsertedWhere {
  return insertionIndex === null ? { kind: "end" } : { kind: "at", slideNumber: insertionIndex + 1 };
}

/** One sentence for the status line. Slide numbers are 1-based, as the filmstrip shows them. */
export function describeInsertedWhere({ picked, where }: { picked: number; where: InsertedWhere }): string {
  switch (where.kind) {
    case "at":
      return `Inserted option ${String(picked)} as slide ${String(where.slideNumber)}.`;
    case "end":
      return `Inserted option ${String(picked)} at the end of the deck, because no slide was selected.`;
    default:
      return assertNever(where);
  }
}

/** Unique per candidate within the presentation, which is what the converter's allocator needs. */
function previewPrefix({ proposalId, index }: { proposalId: string; index: number }): string {
  return `${proposalId.replace(/[^A-Za-z0-9_-]/g, "")}_${String(index)}`;
}

/** One request, every object-naming field renamed, everything else copied as it was. */
function renamedRecord({
  record,
  rename,
}: {
  record: Readonly<Record<string, unknown>>;
  rename: (objectId: string) => string;
}): Readonly<Record<string, unknown>> {
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    copied[key] = OBJECT_ID_KEYS.has(key) && typeof value === "string" ? rename(value) : renamedValue({ value, rename });
  }
  return copied;
}

function renamedValue({ value, rename }: { value: unknown; rename: (objectId: string) => string }): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => renamedValue({ value: item, rename }));
  if (typeof value !== "object" || value === null) return value;
  return renamedRecord({ record: value as Readonly<Record<string, unknown>>, rename });
}
