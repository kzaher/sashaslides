// The picker's reducer and its React rendering, against stub data. No browser: the reducer is pure
// and the tree is checked with react-dom/server, so every status of the discriminated union is
// rendered and asserted in milliseconds.

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Picker, type PickerActions } from "./Picker.tsx";
import { stubConvertHtmlToSlideRequests } from "./converter-contract.ts";
import { slideHtml } from "./fake-drive.ts";
import type { Proposal } from "./observer.ts";
import {
  INITIAL_PICKER_STATE,
  anomaliesOf,
  offerOf,
  reducePicker,
  selectedFrame,
  type PickerEvent,
  type PickerState,
} from "./picker-state.ts";
import { WHOLE_SLIDE } from "./protocol.ts";
import { previewElementsOf } from "./rendered-preview.ts";

const proposal: Proposal = {
  proposalId: "p_1",
  folderId: "folder_p_1",
  presentationId: "deck_1",
  count: 3,
  slides: [1, 2, 3].map((index) => ({
    index,
    fileId: `html_${index}`,
    name: `${String(index).padStart(2, "0")}.html`,
    label: `option ${index}`,
  })),
};

test("an offer starts on slide 1 showing the HTML, because the HTML is authoritative", () => {
  const state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  const offer = offerOf(state);
  assert.ok(offer !== null);
  assert.equal(offer.selectedIndex, 1);
  assert.equal(offer.view, "html");
  assert.equal(offer.slides.length, 3);
});

test("the toggle switches between the HTML and the converted slide and back", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  state = reducePicker(state, { kind: "view-chosen", view: "rendered" });
  assert.equal(offerOf(state)?.view, "rendered");
  state = reducePicker(state, { kind: "view-chosen", view: "html" });
  assert.equal(offerOf(state)?.view, "html");
});

test("selecting is 1-based and clamped to the manifest's count", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  state = reducePicker(state, { kind: "slide-selected", index: 3 });
  assert.equal(offerOf(state)?.selectedIndex, 3);
  state = reducePicker(state, { kind: "slide-selected", index: 9 });
  assert.equal(offerOf(state)?.selectedIndex, 3, "there is no option 9");
  state = reducePicker(state, { kind: "slide-selected", index: 0 });
  assert.equal(offerOf(state)?.selectedIndex, 1);
});

test("the converter's unsupported features become anomalies the user can comment on", () => {
  const converted = stubConvertHtmlToSlideRequests()({
    html: slideHtml({ index: 1, proposalId: "p_1" }),
    presentationId: "deck_1",
    pageObjectId: "sasha_page",
  });
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
    { kind: "converted", index: 1, result: converted },
  ]);
  const frame = selectedFrame(offerOf(state) ?? neverOffer());
  assert.ok(frame !== null);
  assert.equal(frame.anomalies.length, 1);
  assert.equal(frame.anomalies[0]?.source, "converter");
  assert.match(frame.anomalies[0]?.note ?? "", /stub-converter/);
});

test("a converter anomaly is reported even with no note; a blank user box is not", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
  ]);
  const offer = offerOf(state);
  assert.ok(offer !== null);
  const reported = anomaliesOf(offer);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.index, 2, "the anomaly keeps the slide it was drawn on");
  assert.equal(reported[0]?.note, "(no note)");
});

test("re-announcing the same proposal does not throw away the user's work", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "slide-selected", index: 2 },
    { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: WHOLE_SLIDE },
    { kind: "anomaly-noted", index: 2, anomalyId: "user_1", note: "gridlines gone" },
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
  ]);
  const offer = offerOf(state);
  assert.equal(offer?.selectedIndex, 2);
  assert.deepEqual(anomaliesOf(offer ?? neverOffer()), [
    { index: 2, note: "gridlines gone", region: WHOLE_SLIDE },
  ]);
});

test("a failed insert returns to picking with the reason and the notes intact", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "anomaly-drawn", index: 1, anomalyId: "user_1", region: WHOLE_SLIDE },
    { kind: "anomaly-noted", index: 1, anomalyId: "user_1", note: "kept" },
    { kind: "submit-started", picked: 1, stage: "converting" },
    { kind: "submit-failed", message: "Slides said 400" },
  ]);
  assert.equal(state.status, "picking");
  assert.equal(offerOf(state)?.lastFailure, "Slides said 400");
  assert.equal(anomaliesOf(offerOf(state) ?? neverOffer()).length, 1);
});

test("a background Drive hiccup does not replace a picker the user is mid-decision on", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "trouble", message: "Drive list failed" },
  ]);
  assert.equal(state.status, "picking");
  assert.equal(reducePicker(INITIAL_PICKER_STATE, { kind: "trouble", message: "x" }).status, "trouble");
});

test("the UI is read-only while a submit is in flight", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "submit-started", picked: 1, stage: "inserting" },
    { kind: "slide-selected", index: 3 },
  ]);
  assert.equal(state.status, "submitting");
  assert.equal(offerOf(state)?.selectedIndex, 1, "clicking a chip mid-insert changes nothing");
});

test("a dormant picker renders nothing at all", () => {
  assert.equal(markupOf(INITIAL_PICKER_STATE), "");
});

test("the dialog numbers the candidates 1..N so the user can say 'option 3'", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.match(markup, /3 candidate slides/);
  for (const index of [1, 2, 3]) {
    assert.match(markup, new RegExp(`sasha-chip-number">${index}<`), `chip ${index}`);
  }
  assert.match(markup, /Insert option 1</);
});

test("the HTML view renders the document in a fully sandboxed iframe", () => {
  const html = slideHtml({ index: 1, proposalId: "p_1" });
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html },
    ]),
  );
  assert.match(markup, /<iframe[^>]*sandbox=""/, "no scripts, no same-origin");
  // Case-insensitive: react-dom/server spells it `srcDoc`, the browser DOM property is `srcdoc`.
  assert.match(markup, /srcdoc="/i);
  assert.match(markup, /width: 1280px/, "the staged document itself is inside the srcdoc");
});

test("the converted view renders one box per element the converter asked Slides for", () => {
  const converted = stubConvertHtmlToSlideRequests()({
    html: slideHtml({ index: 1, proposalId: "p_1" }),
    presentationId: "deck_1",
    pageObjectId: "sasha_page",
  });
  assert.equal(previewElementsOf(converted.requests).length, 1);
  assert.match(previewElementsOf(converted.requests)[0]?.text ?? "", /converter not wired yet/);

  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html: "<html><body></body></html>" },
      { kind: "converted", index: 1, result: converted },
      { kind: "view-chosen", view: "rendered" },
    ]),
  );
  assert.match(markup, /sasha-el sasha-el-shape/);
  assert.doesNotMatch(markup, /<iframe/, "the HTML pane is not rendered at the same time");
  assert.match(markup, /sasha-mark-converter/, "the unsupported region is drawn on the preview");
});

test("a tab with no presentation says so and disables insert", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: null }]));
  assert.match(markup, /not an editable presentation/);
  assert.match(markup, /class="sasha-primary" disabled/);
});

test("the settled state tells the user what Claude was told", () => {
  assert.match(markupOf({ status: "settled", proposalId: "p_1", picked: 2 }), /Inserted option 2/);
  assert.match(markupOf({ status: "settled", proposalId: "p_1", picked: null }), /Dismissed p_1/);
});

const inertActions: PickerActions = {
  selectSlide() {},
  chooseView() {},
  drawAnomaly() {},
  noteAnomaly() {},
  removeAnomaly() {},
  insertPicked() {},
  dismiss() {},
};

function play(events: readonly PickerEvent[]): PickerState {
  let state = INITIAL_PICKER_STATE;
  for (const event of events) state = reducePicker(state, event);
  return state;
}

function markupOf(state: PickerState): string {
  return renderToStaticMarkup(createElement(Picker, { state, actions: inertActions }));
}

function neverOffer(): never {
  throw new Error("expected an offer");
}
