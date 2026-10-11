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
import { unsentMarkUps } from "./picker-state.ts";
import type { Proposal } from "./observer.ts";
import {
  INITIAL_PICKER_STATE,
  anomaliesOf,
  htmlToLoad,
  nextToConvert,
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

/**
 * The grid opens on the PREVIEW. It used to open on the markup, on the reasoning that the HTML
 * is authoritative -- true, and still the reason Original is one press away, but the grid is
 * where four candidates are being CHOSEN BETWEEN and the thing being chosen is what the
 * audience will see.
 */
test("an offer starts on slide 1 showing the preview, which is the candidate's own HTML", () => {
  const state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  const offer = offerOf(state);
  assert.ok(offer !== null);
  assert.equal(offer.selectedIndex, 1);
  assert.equal(offer.rendering, "html");
  assert.equal(offer.slides.length, 3);
  assert.equal(offer.editing, null, "and the grid alone -- the editor opens when a candidate is picked");
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
  // A LOADER, not an essay: the window is waiting, and that is the whole of what it can say.
  assert.match(markup, /class="sasha-loader"/);
  assert.doesNotMatch(markup, /candidates appear here/i);
  // It must still not claim a proposal exists.
  assert.doesNotMatch(markup, /candidate slides<|>Insert</);
});

test("the dialog numbers the candidates 1..N so the user can say 'option 3'", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  // The number is ON THE PICTURE now, not in a caption under it, and "4 candidate slides p_..."
  // is gone from the header: the count is the number of slides the reader is looking at.
  for (const index of [1, 2, 3]) {
    assert.match(markup, new RegExp(`sasha-cell-number" aria-hidden="true">${index}<`), `badge ${index}`);
  }
  // The count survives only as the grid's `aria-label`, which is what a screen reader needs; it
  // is no longer a heading over the pictures.
  assert.doesNotMatch(markup, /<strong>\s*3 candidate slide/, "the header no longer counts what is on screen");
  assert.doesNotMatch(markup, new RegExp(proposal.proposalId), "and it no longer names a file nobody opens");
  assert.match(markup, /Open option 1 to request changes/);
});

test("the HTML view renders the document in a sandboxed iframe that never runs its scripts", () => {
  const html = slideHtml({ index: 1, proposalId: "p_1" });
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      // The grid opens on the preview, so the markup pane is one press away -- and the live
      // editor lives in the EDITOR WINDOW now, which is what gets the reachable frame.
      { kind: "rendering-chosen", rendering: "html" },
      { kind: "editor-opened", index: 1 },
      { kind: "html-arrived", index: 1, html },
    ]),
  );
  // The candidate the editor is attached to gets `allow-same-origin` --
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
  // NOT the converter's findings: those are off until asked for, so a candidate does not come
  // up covered in dashed boxes nobody drew.
  assert.doesNotMatch(markup, /sasha-mark-converter/, "findings are off by default");
});

test("a tab with no presentation says so and disables insert", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: null }]));
  assert.match(markup, /not an editable presentation/);
  // Insert is per candidate now, so EVERY one of them is disabled.
  assert.equal(
    (markup.match(/class="sasha-primary sasha-small" disabled=""/g) ?? []).length,
    3,
    "no candidate can be inserted into a tab that is not a presentation",
  );
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
  // NOT PAINTED BY DEFAULT. The finding still travels with PICK (`anomaliesOf` above), but a
  // candidate does not come up covered in boxes the user did not draw.
  const quiet = marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion, showFindings: false });
  assert.deepEqual(quiet, [], "nothing is drawn until the user asks to see it");
  const shown = marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion, showFindings: true }).map((mark) => mark.tone);
  assert.deepEqual(shown, ["converter"], "and it is there when asked for");
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
    marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion, showFindings: true }).map((mark) => mark.tone),
    ["converter", "user"],
  );
  // With the findings off, the user's own box is the only thing on the slide.
  assert.deepEqual(
    marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion, showFindings: false }).map((mark) => mark.tone),
    ["user"],
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
    { kind: "editor-opened", index: 2 },
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
    { kind: "editor-opened", index: 2 },
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

// --- the grid is slides and one toggle; the editor is a popup on top -------

/**
 * THE GRID IS SLIDES AND ONE TOGGLE, NOTHING ELSE.
 *
 * It used to carry three groups of chrome at once -- VIEW (all candidates / one slide), TOOL
 * (edit / annotate) and SHOWING (HTML / converted) -- plus a line of hint text, above four
 * thumbnails. Three of those are decisions about ONE candidate, and the grid is where you are
 * still choosing between four. They move into the editor, which now opens on top when a
 * candidate is picked.
 *
 * What survives in the grid is the one choice that is about all four at once: which rendering
 * you are comparing. PREVIEW is the default, because the preview is what the audience sees.
 */
test("the grid opens on the preview and on the grid alone", () => {
  const state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  const offer = offerOf(state);
  assert.ok(offer !== null);
  assert.equal(offer.rendering, "html", "the candidate itself, not a wireframe of the API call");
  assert.equal(offer.editing, null, "and no editor open over it");
});

test("picking a candidate opens the editor on it; closing comes back to the grid", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  state = reducePicker(state, { kind: "editor-opened", index: 3 });
  assert.equal(offerOf(state)?.editing, 3);
  assert.equal(offerOf(state)?.selectedIndex, 3, "the editor is open on what it says it is");

  state = reducePicker(state, { kind: "editor-closed" });
  assert.equal(offerOf(state)?.editing, null);
  assert.equal(offerOf(state)?.selectedIndex, 3, "and the grid remembers which one you were on");
});

test("the editor cannot be opened on a candidate that is not in the proposal", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  state = reducePicker(state, { kind: "editor-opened", index: 9 });
  assert.equal(offerOf(state)?.editing, 3, "clamped to the last candidate, never out of range");
});

/**
 * THE TOOL IS THE EDITOR'S, and it is named for what the pointer IS: a select arrow, the way
 * every drawing program names it. It was called "edit", which named the mode rather than the
 * pointer and read as the opposite of "annotate" -- but annotating is editing too.
 */
test("the editor opens with the select arrow, not the annotate tool", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  state = reducePicker(state, { kind: "editor-opened", index: 1 });
  assert.equal(offerOf(state)?.tool, "select");
  state = reducePicker(state, { kind: "tool-chosen", tool: "annotate" });
  assert.equal(offerOf(state)?.tool, "annotate");
});

/** Leaving with something typed but unsent must be refused, not silently dropped. */
test("an unsent mark-up is what makes closing the editor a question", () => {
  let state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "editor-opened", index: 2 },
  ]);
  assert.equal(unsentMarkUps(offerOf(state) ?? neverOffer()).length, 0, "nothing typed, nothing to lose");

  state = reducePicker(state, { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: WHOLE_SLIDE });
  assert.equal(unsentMarkUps(offerOf(state) ?? neverOffer()).length, 0, "an empty box is not words");

  state = reducePicker(state, { kind: "anomaly-noted", index: 2, anomalyId: "user_1", note: "the title is cut off" });
  const unsent = unsentMarkUps(offerOf(state) ?? neverOffer());
  assert.equal(unsent.length, 1, "typed and not sent: closing has to ask");
  assert.equal(unsent[0]?.note, "the title is cut off");
});

/**
 * "PREVIEW" MUST BE THE SLIDE, NOT A WIREFRAME OF THE API CALL.
 *
 * The grid's toggle read Preview | Original, and Preview showed the `rendered` pane. But that
 * pane is NOT a rendering: `rendered-preview.ts` says so in its own first line -- it is a
 * projection of the requests the converter will send Slides, drawn as boxes and loose text,
 * because the real thing cannot exist until the slide is in a deck.
 *
 * So the default view of every candidate was a debugging wireframe labelled "Preview", which is
 * why a table showed up as one run-on blob of its cells' text. The candidate's own HTML is the
 * true visual preview -- it is a self-contained document that renders exactly.
 */
test("the grid opens on the candidate's own HTML, which is the thing a preview shows", () => {
  const offer = offerOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.equal(offer?.rendering, "html", "the slide itself, not a projection of the API call");
});

test("the two panes are named for what they actually are", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.match(markup, /Preview/, "the HTML pane");
  assert.match(markup, /Converted/, "and the wireframe of what Slides will receive");
  assert.doesNotMatch(markup, />Original</, "nothing is called Original any more");
});

// --- the expensive work is done BEFORE the user asks for it ---------------------------------

/**
 * THE REPRO for "When I go to Converted it just waits for the conversion". `nextToConvert`
 * deliberately converted nothing until the converted view was chosen, so the click itself
 * started N serial iframe conversions. It now converts in the BACKGROUND (when the browser is
 * idle) while the preview is showing, and NOW once somebody is looking at the converted view.
 */
test("THE PREVIEW CONVERTS IN THE BACKGROUND, so Converted is ready before it is clicked", () => {
  const previewing = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-arrived", index: 1, html: "<html></html>" },
  ]);
  const due = nextToConvert(offerOf(previewing) ?? neverOffer());
  assert.equal(due?.frame.index, 1, "the loaded candidate is converted without being asked");
  assert.equal(due?.urgency, "idle", "but only when the browser has nothing better to do");

  const looking = reducePicker(previewing, { kind: "rendering-chosen", rendering: "rendered" });
  assert.equal(nextToConvert(offerOf(looking) ?? neverOffer())?.urgency, "now", "somebody is waiting for it");
});

test("a candidate converted already -- e.g. from the browser's cache -- is not converted again", () => {
  const convert = stubConvertHtmlToSlideRequests();
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-arrived", index: 1, html: "<html></html>" },
    {
      kind: "converted",
      index: 1,
      result: convert({ html: "<html></html>", presentationId: "deck_1", pageObjectId: "sashaprev_1_p_1" }),
    },
  ]);
  assert.equal(nextToConvert(offerOf(state) ?? neverOffer()), null);
});

/** Every document is asked for at once: `google.script.run` calls run concurrently. */
test("every candidate's HTML is requested AT ONCE, not one round trip after another", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  assert.deepEqual(
    htmlToLoad(offerOf(state) ?? neverOffer()).map((frame) => frame.index),
    [1, 2, 3],
  );
  state = reducePicker(state, { kind: "html-requested", index: 2 });
  assert.deepEqual(
    htmlToLoad(offerOf(state) ?? neverOffer()).map((frame) => frame.index),
    [1, 3],
    "and one already in flight is not asked for twice",
  );
});
