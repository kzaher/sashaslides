// The picker's reducer and its React rendering, against stub data. No browser: the reducer is pure
// and the tree is checked with react-dom/server, so every status of the discriminated union is
// rendered and asserted in milliseconds.

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Picker, type PickerActions } from "./Picker.tsx";
import { INERT_PICKER_ACTIONS } from "./inert-actions.ts";
import { stubConvertHtmlToSlideRequests } from "./converter-contract.ts";
import { slideHtml } from "./fake-drive.ts";
import { marksOf } from "./slide-stage.tsx";
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
  assert.equal(offer.rendering, "html");
  assert.equal(offer.slides.length, 3);
});

test("AND IT STARTS IN THE EDIT TOOL: editing is the default state, not a thing you navigate to", () => {
  const offer = offerOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.equal(offer?.tool, "edit");
  assert.equal(offer?.view, "grid", "and at the grid zoom level, so all the candidates are comparable");
});

test("the rendering toggle switches between the HTML and the converted slide and back", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  state = reducePicker(state, { kind: "rendering-chosen", rendering: "rendered" });
  assert.equal(offerOf(state)?.rendering, "rendered");
  state = reducePicker(state, { kind: "rendering-chosen", rendering: "html" });
  assert.equal(offerOf(state)?.rendering, "html");
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

test("a box the user drew but never wrote on is still reported, as \"(no note)\"", () => {
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

test("a dormant sidebar says what it is waiting for instead of rendering blank", () => {
  // An empty panel reads as a broken add-on. The old overlay rendered "" here on purpose; a
  // sidebar owns its own column, so it explains itself.
  const markup = markupOf(INITIAL_PICKER_STATE);
  assert.notEqual(markup, "");
  assert.match(markup, /Waiting for slides/);
  assert.match(markup, /candidates appear here/i);
  // It must still not claim a proposal exists.
  assert.doesNotMatch(markup, /candidate slides<|Insert option/);
});

test("the dialog numbers the candidates 1..N so the user can say 'option 3'", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.match(markup, /3 candidate slides/);
  for (const index of [1, 2, 3]) {
    assert.match(markup, new RegExp(`sasha-chip-number">${index}<`), `chip ${index}`);
  }
  assert.match(markup, /Insert option 1</);
});

test("the HTML view renders the document in a sandboxed iframe that never runs its scripts", () => {
  const html = slideHtml({ index: 1, proposalId: "p_1" });
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html },
    ]),
  );
  // The selected candidate is the one the editor is attached to, so it gets `allow-same-origin` --
  // and NEVER `allow-scripts`, which is the combination that keeps a staged document inert while
  // still letting the host reach into it (scaled-frame.tsx, editor/slide-editor.ts).
  assert.match(markup, /<iframe[^>]*sandbox="allow-same-origin"/);
  assert.doesNotMatch(markup, /allow-scripts/, "no candidate ever executes anything");
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
      { kind: "rendering-chosen", rendering: "rendered" },
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

test("A CLEARED SET IS NOT AN EMPTY GRID -- READY survives a clear, so this window can land on one", () => {
  // `clear_slides` deletes the uninserted candidates and bumps `revision`; it leaves `READY` in
  // place, so the name walk still finds the folder and the manifest comes back with count 0.
  const cleared = play([
    { kind: "proposal-offered", proposal: { ...proposal, count: 0, slides: [] }, presentationId: "deck_1" },
  ]);
  assert.deepEqual(cleared, { status: "cleared", proposalId: proposal.proposalId });
  const markup = markupOf(cleared);
  assert.match(markup, /Sasha discarded these slides/);
  assert.doesNotMatch(markup, /class="sasha-grid"/, "a grid of nothing is indistinguishable from a bug");
});

test("the settled state tells the user what Sasha was told", () => {
  assert.match(markupOf({ status: "settled", proposalId: "p_1", picked: 2 }), /Inserted option 2/);
  assert.match(markupOf({ status: "settled", proposalId: "p_1", picked: null }), /Dismissed p_1/);
});

/**
 * The injected actions, from inert-actions.ts rather than restated here: a second copy of
 * `PickerActions` compiles until it drifts, and the whole point of the file is one substitution.
 */
const inertActions: PickerActions = INERT_PICKER_ACTIONS;

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

// --- the converter's findings travel, but they are not the user's annotations ---

/**
 * The converter's own findings are sent UNDER THE HOOD and never appear as mark-up rows.
 *
 * They used to be seeded straight into `frame.anomalies`, which is the list the slides window
 * renders as the user's annotations -- so a four-candidate proposal opened with thirteen
 * "CONVERTER" rows the user never wrote, each with its own editable note and Send button,
 * above the one or two boxes they had actually drawn. The user could not tell their own
 * comments from the machine's.
 *
 * They still have to REACH Sasha: the converter already knows it could not express those
 * regions, and that is worth reporting. So they ride on `PICK.anomalies` exactly as before,
 * derived from the conversion rather than from a row on screen, and they are still DRAWN on
 * the slide so the user can see what was flagged.
 */
test("a converter finding is not a mark-up row", () => {
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
  assert.deepEqual(frame.anomalies, [], "the user has drawn nothing, so there is nothing to list");
});

test("...but it still travels with the PICK, and it is still drawn on the slide", () => {
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
  const offer = offerOf(state);
  assert.ok(offer !== null);
  const reported = anomaliesOf(offer);
  assert.equal(reported.length, 1, "the converter's finding is still reported");
  assert.match(reported[0]?.note ?? "", /stub-converter/);
  assert.equal(reported[0]?.index, 1);

  const frame = selectedFrame(offer);
  assert.ok(frame !== null);
  const tones = marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion }).map((mark) => mark.tone);
  assert.deepEqual(tones, ["converter"], "it is still visible as a box on the slide");
});

test("the user's own boxes and the converter's findings are both drawn, user ones last", () => {
  const converted = stubConvertHtmlToSlideRequests()({
    html: slideHtml({ index: 1, proposalId: "p_1" }),
    presentationId: "deck_1",
    pageObjectId: "sasha_page",
  });
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
    { kind: "converted", index: 1, result: converted },
    { kind: "anomaly-drawn", index: 1, anomalyId: "user_1", region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
  ]);
  const frame = selectedFrame(offerOf(state) ?? neverOffer());
  assert.ok(frame !== null);
  assert.equal(frame.anomalies.length, 1, "only the user's box is a row");
  assert.equal(frame.anomalies[0]?.source, "user");
  // The user's box is painted OVER the converter's, so their own mark is never hidden by one.
  assert.deepEqual(
    marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion }).map((mark) => mark.tone),
    ["converter", "user"],
  );
});

/**
 * A MARK-UP IS A COMMENT, and a comment is written in more than one line.
 *
 * It was a single-line `<input>`, so a user typing two sentences about a slide saw a sliver of
 * their own text scrolling sideways, and a newline was impossible. Google's own comment
 * composer is a growing multiline box; so is this one.
 */
test("the mark-up composer is multiline and keeps the newlines the user typed", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "tool-chosen", tool: "annotate" },
    { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: WHOLE_SLIDE },
    { kind: "anomaly-noted", index: 2, anomalyId: "user_1", note: "line one\nline two" },
  ]);
  const offer = offerOf(state);
  assert.ok(offer !== null);
  assert.equal(offer.slides[1]?.anomalies[0]?.note, "line one\nline two", "the newline survives the reducer");

  const markup = renderToStaticMarkup(
    createElement(Picker, { state, actions: INERT_PICKER_ACTIONS as PickerActions }),
  );
  assert.match(markup, /<textarea[^>]*class="sasha-note"/, "a comment is written in a textarea");
  assert.doesNotMatch(markup, /<input[^>]*class="sasha-note"/, "never a one-line input");
});

/** The mark-up list is a stack of comment cards, the shape Google's own comment pane uses. */
test("a mark-up is drawn as a comment card: avatar, author, where", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "tool-chosen", tool: "annotate" },
    { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } },
  ]);
  const markup = renderToStaticMarkup(
    createElement(Picker, { state, actions: INERT_PICKER_ACTIONS as PickerActions }),
  );
  assert.match(markup, /class="sasha-c-avatar"/, "the round initial");
  assert.match(markup, /class="sasha-c-name">You</, "who wrote it");
  assert.match(markup, /slide 2/, "which candidate it is about");
  // The uppercase source label is gone with the converter rows: every row here is the user's.
  assert.doesNotMatch(markup, /class="sasha-source/);
});
