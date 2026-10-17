// THE QUEUE: what the developer page holds between a paste and an insert (queue-state.ts).

import assert from "node:assert/strict";
import test from "node:test";
import type { SlidesApiRequest } from "../../../../mcp/sasha-slides/converter/index.ts";
import {
  convertedItems,
  EMPTY_QUEUE,
  isHtmlFile,
  nextToConvert,
  pastedDocument,
  queueSummary,
  reduceQueue,
  selectedItem,
  type ConvertedSlide,
  type QueueEvent,
  type QueueState,
} from "./queue-state.ts";

const SLIDE: ConvertedSlide = { requests: [request({ createShape: { objectId: "a" } })], unsupported: [], elementCount: 1, malformedCount: 0, drawioDiagrams: [], elapsedMilliseconds: 12 };

/** Test-only widening: these tests check that the page passes requests through untouched, not their shape. */
function request(value: Readonly<Record<string, unknown>>): SlidesApiRequest {
  return value as unknown as SlidesApiRequest;
}

function queueOf(events: readonly QueueEvent[]): QueueState {
  return events.reduce(reduceQueue, EMPTY_QUEUE);
}

test("added documents queue in order, numbered, and the first new one is selected", () => {
  const queue = queueOf([{ kind: "added", documents: [{ name: "a.html", html: "<p>a</p>" }, { name: "b.html", html: "<p>b</p>" }] }]);
  assert.deepEqual(queue.items.map((item) => [item.itemId, item.name, item.conversion.kind]), [["item-1", "a.html", "pending"], ["item-2", "b.html", "pending"]]);
  assert.equal(queue.selectedItemId, "item-1");
  const more = reduceQueue(queue, { kind: "added", documents: [{ name: "a.html", html: "<p>again</p>" }] });
  assert.equal(more.items[2]?.itemId, "item-3", "the same name twice stays two items");
  assert.equal(more.selectedItemId, "item-3");
});

test("blank documents are ignored, and an all-blank add changes nothing", () => {
  const queue = queueOf([{ kind: "added", documents: [{ name: "x.html", html: "   \n" }] }]);
  assert.equal(queue, EMPTY_QUEUE);
});

test("conversions run one at a time, in queue order", () => {
  let queue = queueOf([{ kind: "added", documents: [{ name: "a.html", html: "a" }, { name: "b.html", html: "b" }] }]);
  assert.equal(nextToConvert(queue)?.itemId, "item-1");
  queue = reduceQueue(queue, { kind: "conversionStarted", itemId: "item-1" });
  assert.equal(nextToConvert(queue), null, "nothing starts while one converts");
  queue = reduceQueue(queue, { kind: "conversionFinished", itemId: "item-1", slide: SLIDE });
  assert.equal(nextToConvert(queue)?.itemId, "item-2");
  queue = reduceQueue(queue, { kind: "conversionStarted", itemId: "item-2" });
  queue = reduceQueue(queue, { kind: "conversionFailed", itemId: "item-2", message: "boom" });
  assert.equal(nextToConvert(queue), null, "everything settled");
  assert.deepEqual(queueSummary(queue), { total: 2, pending: 0, converting: 0, converted: 1, failed: 1 });
  assert.deepEqual(convertedItems(queue.items).map((entry) => entry.item.itemId), ["item-1"]);
});

test("removing the selected item selects its neighbour; a late conversion of a removed item is dropped", () => {
  let queue = queueOf([{ kind: "added", documents: [{ name: "a.html", html: "a" }, { name: "b.html", html: "b" }, { name: "c.html", html: "c" }] }]);
  queue = reduceQueue(queue, { kind: "selected", itemId: "item-2" });
  queue = reduceQueue(queue, { kind: "conversionStarted", itemId: "item-2" });
  queue = reduceQueue(queue, { kind: "removed", itemId: "item-2" });
  assert.equal(selectedItem(queue)?.name, "c.html");
  const after = reduceQueue(queue, { kind: "conversionFinished", itemId: "item-2", slide: SLIDE });
  assert.equal(after, queue);
  queue = reduceQueue(queue, { kind: "removed", itemId: "item-3" });
  assert.equal(selectedItem(queue)?.name, "a.html", "the last one removed falls back to the new last");
  queue = reduceQueue(queue, { kind: "removed", itemId: "item-1" });
  assert.equal(queue.selectedItemId, null);
});

test("selecting an unknown item changes nothing; clearing keeps the numbering going", () => {
  let queue = queueOf([{ kind: "added", documents: [{ name: "a.html", html: "a" }] }]);
  assert.equal(reduceQueue(queue, { kind: "selected", itemId: "item-9" }), queue);
  queue = reduceQueue(queue, { kind: "cleared" });
  assert.deepEqual(queue.items, []);
  queue = reduceQueue(queue, { kind: "added", documents: [{ name: "b.html", html: "b" }] });
  assert.equal(queue.items[0]?.itemId, "item-2");
});

test("pasted text becomes a named document unless it is blank", () => {
  assert.deepEqual(pastedDocument({ text: "<html></html>", number: 3 }), { name: "pasted-3.html", html: "<html></html>" });
  assert.equal(pastedDocument({ text: "  ", number: 1 }), null);
});

test("dropped files are HTML by extension or media type", () => {
  assert.equal(isHtmlFile({ name: "slide.HTML", type: "" }), true);
  assert.equal(isHtmlFile({ name: "slide.htm", type: "" }), true);
  assert.equal(isHtmlFile({ name: "blob", type: "text/html" }), true);
  assert.equal(isHtmlFile({ name: "notes.txt", type: "text/plain" }), false);
});
