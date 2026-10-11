import assert from "node:assert/strict";
import test from "node:test";
import { stubConvertHtmlToSlideRequests } from "./converter-contract.ts";
import { renderKeyOf } from "./render-cache.ts";
import { insertRequests, newPageObjectId, previewConversionSpec } from "./slide-insert.ts";

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
