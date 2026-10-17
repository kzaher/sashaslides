import assert from "node:assert/strict";
import test from "node:test";
import { stubConvertHtmlToSlideRequests } from "./test-support.ts";
import { fakeDrive } from "./fake-drive.ts";
import { renderKeyOf } from "./render-cache.ts";
import {
  describeInsertedWhere,
  insertedWhereOf,
  insertionIndexFor,
  insertRequests,
  newPageObjectId,
  previewConversionSpec,
  retargetConversion,
} from "./slide-insert.ts";

const HTML = "<html><body><h1>Q3</h1></body></html>";

/**
 * THE REPRO for "Converted waits every time". The preview conversion used to be asked for with
 * `newPageObjectId({ random: Math.random })`, so every open baked a fresh page id into the
 * requests and `renderKeyOf(requests)` -- the render cache's key -- never matched twice.
 */
test("THE SAME CANDIDATE CONVERTED ON TWO OPENS KEYS THE SAME RENDER, so the cache can hit", () => {
  const convert = stubConvertHtmlToSlideRequests();
  const firstOpen = convert(previewConversionSpec({ proposalId: "p_1", index: 2, html: HTML, presentationId: "deck_1" }));
  const secondOpen = convert(previewConversionSpec({ proposalId: "p_1", index: 2, html: HTML, presentationId: "deck_1" }));
  assert.equal(renderKeyOf(firstOpen.requests), renderKeyOf(secondOpen.requests));
});

test("...which the old random page id could never do", () => {
  const convert = stubConvertHtmlToSlideRequests();
  let seed = 0;
  const random = (): number => (seed = (seed + 0.37) % 1);
  const once = convert({ html: HTML, presentationId: "deck_1", pageObjectId: newPageObjectId({ random }) });
  const again = convert({ html: HTML, presentationId: "deck_1", pageObjectId: newPageObjectId({ random }) });
  assert.notEqual(renderKeyOf(once.requests), renderKeyOf(again.requests));
});

test("two candidates of one proposal never share a preview page or prefix, even with a long id", () => {
  const proposalId = "p_".padEnd(80, "x");
  const two = previewConversionSpec({ proposalId, index: 2, html: HTML, presentationId: "deck_1" });
  const three = previewConversionSpec({ proposalId, index: 3, html: HTML, presentationId: "deck_1" });
  assert.notEqual(two.pageObjectId, three.pageObjectId);
  assert.notEqual(two.objectIdPrefix, three.objectIdPrefix);
  for (const spec of [two, three]) {
    assert.match(spec.pageObjectId, /^[A-Za-z0-9_-]{5,50}$/, "a legal Slides object id");
  }
});

test("insert puts createSlide first, on the page id it was given", () => {
  const requests = insertRequests({ pageObjectId: "sasha_abc", converted: [{ insertText: { text: "x" } }] });
  assert.deepEqual(requests[0], {
    createSlide: { objectId: "sasha_abc", slideLayoutReference: { predefinedLayout: "BLANK" } },
  });
  assert.equal(requests.length, 2);
});

/** Eight slides, the fourth (index 3) selected -- the deck the user reported from. */
const EIGHT_SLIDES = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];

/**
 * THE REPRO for "when I inserted slide it ignored my selected slide". `insertRequests` emitted
 * `createSlide` with no `insertionIndex`, so Slides appended every insert at the END of the deck,
 * whatever the user had selected.
 */
test("INSERT AFTER THE SELECTED SLIDE 4 OF 8 lands as slide 5, not at the end", async () => {
  const drive = fakeDrive();
  drive.putDeck({ presentationId: "deck_1", slideObjectIds: EIGHT_SLIDES, selectedSlideIndex: 3 });
  const outcome = await drive.slides.insert({
    presentationId: "deck_1",
    requests: insertRequests({ pageObjectId: "sasha_new", converted: [] }),
    position: "after",
  });
  assert.equal(outcome.kind, "ok");
  const sent = drive.batches()[0]?.requests[0];
  assert.deepEqual(sent, {
    createSlide: { objectId: "sasha_new", slideLayoutReference: { predefinedLayout: "BLANK" }, insertionIndex: 4 },
  });
  assert.equal(drive.deck("deck_1").indexOf("sasha_new"), 4);
});

test("insert BEFORE the selected slide 4 takes its place, pushing it to slide 5", async () => {
  const drive = fakeDrive();
  drive.putDeck({ presentationId: "deck_1", slideObjectIds: EIGHT_SLIDES, selectedSlideIndex: 3 });
  const outcome = await drive.slides.insert({
    presentationId: "deck_1",
    requests: insertRequests({ pageObjectId: "sasha_new", converted: [] }),
    position: "before",
  });
  assert.deepEqual(outcome.kind === "ok" ? outcome.value.insertionIndex : "failed", 3);
  assert.deepEqual(drive.deck("deck_1").slice(2, 5), ["s2", "sasha_new", "s3"]);
});

test("with NO slide selected the slide is appended, and the reply says so", async () => {
  const drive = fakeDrive();
  drive.putDeck({ presentationId: "deck_1", slideObjectIds: EIGHT_SLIDES, selectedSlideIndex: null });
  const outcome = await drive.slides.insert({
    presentationId: "deck_1",
    requests: insertRequests({ pageObjectId: "sasha_new", converted: [] }),
    position: "after",
  });
  assert.equal(outcome.kind === "ok" ? outcome.value.insertionIndex : "failed", null);
  assert.equal(drive.deck("deck_1").indexOf("sasha_new"), 8);
  assert.match(describeInsertedWhere({ picked: 2, where: insertedWhereOf(null) }), /end of the deck, because no slide was selected/);
});

test("insertionIndexFor: before is the selected index, after is one past it, anything unreadable appends", () => {
  assert.equal(insertionIndexFor({ position: "before", selectedSlideIndex: 0, slideCount: 1 }), 0);
  assert.equal(insertionIndexFor({ position: "after", selectedSlideIndex: 7, slideCount: 8 }), 8);
  assert.equal(insertionIndexFor({ position: "after", selectedSlideIndex: null, slideCount: 8 }), null);
  assert.equal(insertionIndexFor({ position: "after", selectedSlideIndex: -1, slideCount: 8 }), null, "a layout or master page");
  assert.equal(insertionIndexFor({ position: "after", selectedSlideIndex: 8, slideCount: 8 }), null);
  assert.equal(insertionIndexFor({ position: "after", selectedSlideIndex: 1.5, slideCount: 8 }), null);
});

/**
 * Code.gs runs `insertionIndexFor.toString()` verbatim (build-addon.ts). Evaluated here from its
 * SOURCE TEXT ALONE, with nothing from this module in scope, it must still give the same answers --
 * which is what fails the moment someone gives it an import or a helper.
 */
test("insertionIndexFor is self-contained, so the copy Code.gs embeds runs exactly as tested", () => {
  const embedded = new Function(`return (${insertionIndexFor.toString()});`)() as typeof insertionIndexFor;
  for (const selectedSlideIndex of [null, -1, 0, 3, 7, 8]) {
    for (const position of ["before", "after"] as const) {
      const spec = { position, selectedSlideIndex, slideCount: 8 };
      assert.equal(embedded(spec), insertionIndexFor(spec));
    }
  }
});

test("where the slide landed is said in 1-based filmstrip numbers", () => {
  assert.equal(describeInsertedWhere({ picked: 2, where: insertedWhereOf(4) }), "Inserted option 2 as slide 5.");
});

test("a reused preview conversion is renamed onto the new page, with fresh ids for everything it creates", () => {
  const renamed = retargetConversion({
    requests: [
      { createShape: { objectId: "p_1_2_shape1", elementProperties: { pageObjectId: "sashaprev_2_p_1_2" } } },
      { createTable: { objectId: "p_1_2_table2", elementProperties: { pageObjectId: "sashaprev_2_p_1_2" } } },
      { updateTableCellProperties: { objectId: "p_1_2_table2", tableRange: { location: { rowIndex: 0 } } } },
      { insertText: { objectId: "p_1_2_shape1", text: "p_1_2_shape1 stays text" } },
    ],
    fromPageObjectId: "sashaprev_2_p_1_2",
    toPageObjectId: "sasha_new",
  });
  assert.deepEqual(renamed, [
    { createShape: { objectId: "sasha_new_1", elementProperties: { pageObjectId: "sasha_new" } } },
    { createTable: { objectId: "sasha_new_2", elementProperties: { pageObjectId: "sasha_new" } } },
    { updateTableCellProperties: { objectId: "sasha_new_2", tableRange: { location: { rowIndex: 0 } } } },
    { insertText: { objectId: "sasha_new_1", text: "p_1_2_shape1 stays text" } },
  ]);
  for (const request of renamed) {
    for (const value of Object.values(request)) {
      const objectId = (value as { objectId?: string }).objectId ?? "";
      assert.match(objectId, /^[A-Za-z0-9_-]{5,50}$/, "a legal Slides object id");
    }
  }
});

