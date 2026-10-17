// THE DEVELOPER PAGE'S QUEUE: every HTML document the person pasted or dropped, in the order they
// arrived, each with the state of its conversion. A pure reducer, so the page renders from one
// value and the tests drive it without a browser.
//
// Key decisions:
//
//  * CONVERSIONS RUN ONE AT A TIME (`nextToConvert`). Each conversion stages a 1280x720 frame and
//    may start the draw.io editor; running several at once makes each slower and their timing
//    unreadable. The page converts whatever `nextToConvert` names, so adding ten files queues ten.
//  * AN ITEM IS IDENTIFIED BY A NUMBER THE QUEUE HANDS OUT (`item-<n>`), never by its file name:
//    the same file may be dropped twice, and both copies must stay distinct.

import type { ConvertedDiagram, SlidesApiRequest, UnsupportedFeature } from "../../../../mcp/sasha-slides/converter/index.ts";
import { assertNever } from "../../../../mcp/sasha-slides/engine/src/contracts/assert-never.ts";

/** One document as it entered the page. */
export type QueuedDocument = Readonly<{ name: string; html: string }>;

/** What the product converter produced for one document. */
export type ConvertedSlide = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
  elementCount: number;
  malformedCount: number;
  drawioDiagrams: readonly ConvertedDiagram[];
  elapsedMilliseconds: number;
}>;

export type Conversion =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "converting" }>
  | Readonly<{ kind: "converted"; slide: ConvertedSlide }>
  | Readonly<{ kind: "failed"; message: string }>;

export type QueueItem = Readonly<{ itemId: string; name: string; html: string; conversion: Conversion }>;

export type QueueState = Readonly<{
  items: readonly QueueItem[];
  /** The item whose preview and warnings are shown; null only while the queue is empty. */
  selectedItemId: string | null;
  /** The number the next added item gets. */
  nextNumber: number;
}>;

export type QueueEvent =
  | Readonly<{ kind: "added"; documents: readonly QueuedDocument[] }>
  | Readonly<{ kind: "removed"; itemId: string }>
  | Readonly<{ kind: "selected"; itemId: string }>
  | Readonly<{ kind: "cleared" }>
  | Readonly<{ kind: "conversionStarted"; itemId: string }>
  | Readonly<{ kind: "conversionFinished"; itemId: string; slide: ConvertedSlide }>
  | Readonly<{ kind: "conversionFailed"; itemId: string; message: string }>;

/** How many items are in each state, for the page's summary line. */
export type QueueSummary = Readonly<{ total: number; pending: number; converting: number; converted: number; failed: number }>;

export const EMPTY_QUEUE: QueueState = { items: [], selectedItemId: null, nextNumber: 1 };

export function reduceQueue(state: QueueState, event: QueueEvent): QueueState {
  switch (event.kind) {
    case "added":
      return withDocuments({ state, documents: event.documents });
    case "removed":
      return withoutItem({ state, itemId: event.itemId });
    case "selected":
      if (!state.items.some((item) => item.itemId === event.itemId)) return state;
      return { ...state, selectedItemId: event.itemId };
    case "cleared":
      return { ...EMPTY_QUEUE, nextNumber: state.nextNumber };
    case "conversionStarted":
      return withConversion({ state, itemId: event.itemId, conversion: { kind: "converting" } });
    case "conversionFinished":
      return withConversion({ state, itemId: event.itemId, conversion: { kind: "converted", slide: event.slide } });
    case "conversionFailed":
      return withConversion({ state, itemId: event.itemId, conversion: { kind: "failed", message: event.message } });
    default:
      return assertNever(event);
  }
}

/** The item to convert next: the first pending one, and none while another is converting. */
export function nextToConvert(state: QueueState): QueueItem | null {
  const summary = queueSummary(state);
  if (summary.converting > 0 || summary.pending === 0) return null;
  return state.items.find((item) => isPending(item.conversion)) ?? null;
}

export function selectedItem(state: QueueState): QueueItem | null {
  return state.items.find((item) => item.itemId === state.selectedItemId) ?? null;
}

/** Every converted item, in queue order: what an insert or a .pptx download sends. */
export function convertedItems(items: readonly QueueItem[]): readonly Readonly<{ item: QueueItem; slide: ConvertedSlide }>[] {
  return items.flatMap((item) => {
    const slide = convertedSlideOf(item);
    return slide === null ? [] : [{ item, slide }];
  });
}

/** The item's conversion when it finished, else null. */
export function convertedSlideOf(item: QueueItem): ConvertedSlide | null {
  const { conversion } = item;
  switch (conversion.kind) {
    case "converted":
      return conversion.slide;
    case "pending":
    case "converting":
    case "failed":
      return null;
    default:
      return assertNever(conversion);
  }
}

export function queueSummary(state: QueueState): QueueSummary {
  const counts = { pending: 0, converting: 0, converted: 0, failed: 0 };
  for (const item of state.items) counts[item.conversion.kind] += 1;
  return { total: state.items.length, ...counts };
}

/** Pasted text as a document, or null when it is blank. Pastes are named in arrival order. */
export function pastedDocument(options: Readonly<{ text: string; number: number }>): QueuedDocument | null {
  if (options.text.trim() === "") return null;
  return { name: `pasted-${options.number}.html`, html: options.text };
}

/** Whether a dropped file is HTML, by its name or its media type. */
export function isHtmlFile(file: Readonly<{ name: string; type: string }>): boolean {
  return /\.html?$/i.test(file.name) || file.type === "text/html";
}

function isPending(conversion: Conversion): boolean {
  switch (conversion.kind) {
    case "pending":
      return true;
    case "converting":
    case "converted":
    case "failed":
      return false;
    default:
      return assertNever(conversion);
  }
}

function withDocuments(options: Readonly<{ state: QueueState; documents: readonly QueuedDocument[] }>): QueueState {
  const { state } = options;
  const documents = options.documents.filter((document) => document.html.trim() !== "");
  if (documents.length === 0) return state;
  const added = documents.map(
    (document, index): QueueItem => ({ itemId: `item-${state.nextNumber + index}`, name: document.name, html: document.html, conversion: { kind: "pending" } }),
  );
  const firstAdded = added[0];
  return {
    items: [...state.items, ...added],
    // A new paste is what the person wants to look at; keep an existing selection otherwise.
    selectedItemId: firstAdded === undefined ? state.selectedItemId : firstAdded.itemId,
    nextNumber: state.nextNumber + added.length,
  };
}

function withoutItem(options: Readonly<{ state: QueueState; itemId: string }>): QueueState {
  const { state, itemId } = options;
  const index = state.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) return state;
  const items = state.items.filter((item) => item.itemId !== itemId);
  if (state.selectedItemId !== itemId) return { ...state, items };
  // The neighbour that slid into the removed item's place, else the new last one.
  const neighbour = items[Math.min(index, items.length - 1)];
  return { ...state, items, selectedItemId: neighbour === undefined ? null : neighbour.itemId };
}

function withConversion(options: Readonly<{ state: QueueState; itemId: string; conversion: Conversion }>): QueueState {
  const { state } = options;
  // A conversion that finishes after its item was removed is dropped, not resurrected.
  if (!state.items.some((item) => item.itemId === options.itemId)) return state;
  return { ...state, items: state.items.map((item) => (item.itemId === options.itemId ? { ...item, conversion: options.conversion } : item)) };
}
