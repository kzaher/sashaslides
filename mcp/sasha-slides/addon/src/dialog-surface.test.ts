// THE DIALOG'S TWO AXES: the VIEW (grid or one slide) and the TOOL (edit or annotate), which are
// independent, and the four combinations of them.
//
// Same shape as picker-state.test.ts -- the reducer is pure and the tree is rendered with
// react-dom/server, so every combination is asserted in milliseconds with no browser and no Apps
// Script host. The order of the tests follows the order of the code: the reducer's transitions,
// then the selectors the dialog's feedback loops are gated on, then the markup.
//
// WHAT THESE TESTS PIN. The window used to hold ONE `surface` enum, so clicking a cell entered a
// screen where annotation became possible and leaving it took the gesture away. The tests below
// state the replacement as four properties: edit is the default, a zoom never moves the tool, a
// tool never moves the zoom, and both tools render at both zoom levels.

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { stubConvertHtmlToSlideRequests } from "./converter-contract.ts";
import { slideHtml } from "./fake-drive.ts";
import { INERT_PICKER_ACTIONS } from "./inert-actions.ts";
import type { Proposal } from "./observer.ts";
import { Picker } from "./Picker.tsx";
import {
  INITIAL_PICKER_STATE,
  drawsRegions,
  selectsElements,
  editorIsLive,
  editorReachOf,
  editsSlides,
  nextHtmlToLoad,
  nextToConvert,
  offerOf,
  reducePicker,
  selectedFrame,
  type PickerEvent,
  type PickerState,
} from "./picker-state.ts";
import { UNMEASURED_SCALE } from "./scaled-frame.tsx";
import { describeSlideEdit, nullSlideEditor, slideEditRecord, type SlideEdit } from "./slide-editor.ts";

const proposal: Proposal = {
  proposalId: "p_1",
  folderId: "folder_p_1",
  presentationId: "deck_1",
  count: 4,
  slides: [1, 2, 3, 4].map((index) => ({
    index,
    fileId: `html_${index}`,
    name: `${String(index).padStart(2, "0")}.html`,
    label: `option ${index}`,
  })),
};

// --- the view and the tool, which are independent -------------------------

test("an offer opens on the GRID, because comparing the candidates is the point of the window", () => {
  const offer = offerOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.ok(offer !== null);
  assert.equal(offer.view, "grid");
  assert.equal(offer.tool, "select", "and in the EDIT tool: editing is the default, not a destination");
  assert.equal(offer.selectedIndex, 1, "and option 1 is pre-selected, so Insert always has a target");
});

test("ZOOMING IN ON A CANDIDATE CHANGES THE VIEW AND NOTHING ELSE -- not the tool", () => {
  const offer = offerOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "tool-chosen", tool: "annotate" },
      { kind: "candidate-zoomed", index: 3 },
    ]),
  );
  assert.equal(offer?.view, "single");
  assert.equal(offer?.selectedIndex, 3);
  assert.equal(offer?.tool, "annotate", "the tool the user picked survives the zoom");
});

test("AND CHOOSING A TOOL CHANGES THE TOOL AND NOTHING ELSE -- not the view", () => {
  const offer = offerOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "candidate-zoomed", index: 2 },
      { kind: "tool-chosen", tool: "annotate" },
      { kind: "tool-chosen", tool: "select" },
    ]),
  );
  assert.equal(offer?.view, "single", "two tool changes left the zoom level alone");
  assert.equal(offer?.tool, "select");
  assert.equal(offer?.selectedIndex, 2);
});

test("every one of the four view/tool combinations is reachable", () => {
  for (const view of ["grid", "single"] as const) {
    for (const tool of ["select", "annotate"] as const) {
      const offer = offerOf(
        play([
          { kind: "proposal-offered", proposal, presentationId: "deck_1" },
          { kind: "view-chosen", view },
          { kind: "tool-chosen", tool },
        ]),
      );
      assert.equal(offer?.view, view, `${view}/${tool}`);
      assert.equal(offer?.tool, tool, `${view}/${tool}`);
    }
  }
});

test("a zoom is clamped like every other selection -- there is no option 9", () => {
  const offer = offerOf(
    play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }, { kind: "candidate-zoomed", index: 9 }]),
  );
  assert.equal(offer?.selectedIndex, 4);
});

test("going back to the grid keeps the selection, the tool and the notes", () => {
  const offer = offerOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "tool-chosen", tool: "annotate" },
      { kind: "candidate-zoomed", index: 2 },
      { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      { kind: "view-chosen", view: "grid" },
    ]),
  );
  assert.equal(offer?.view, "grid");
  assert.equal(offer?.tool, "annotate");
  assert.equal(offer?.selectedIndex, 2);
  assert.equal(offer?.slides[1]?.anomalies.length, 1);
});

test("the window is read-only while a submit is in flight -- view and tool both freeze", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "submit-started", picked: 1, stage: "inserting" },
    { kind: "candidate-zoomed", index: 3 },
    { kind: "tool-chosen", tool: "annotate" },
  ]);
  assert.equal(state.status, "submitting");
  assert.equal(offerOf(state)?.view, "grid", "zooming mid-insert changes nothing");
  assert.equal(offerOf(state)?.tool, "select");
  assert.equal(offerOf(state)?.selectedIndex, 1);
});

test("the tool predicates are the only decision site, and they answer three different questions", () => {
  // BOTH TOOLS POINT AT ELEMENTS. That is what let annotate stop dragging rectangles and start
  // behaving like Claude's own artifact comments: hover, click, click again for the parent.
  assert.equal(selectsElements("select"), true);
  assert.equal(selectsElements("annotate"), true);
  // Only one of them may CHANGE what it selected.
  assert.equal(editsSlides("select"), true);
  assert.equal(editsSlides("annotate"), false);
  // And the rectangle is the FALLBACK, for a stage with no reachable elements to click.
  assert.equal(drawsRegions({ tool: "annotate", elementsReachable: false }), true);
  assert.equal(
    drawsRegions({ tool: "annotate", elementsReachable: true }),
    false,
    "a drag surface over a live document would swallow every click the selection needs",
  );
  assert.equal(drawsRegions({ tool: "select", elementsReachable: false }), false);
});

test("THE EDITOR'S REACH IS A UNION WITH A REASON, never a silently empty slot", () => {
  const offer = offerOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.ok(offer !== null);
  const loading = selectedFrame(offer);
  assert.equal(editorReachOf({ rendering: "html", frame: loading }).kind, "unloaded");
  // The converted pane is a PROJECTION; the invariants say an edit edits the HTML, never the
  // conversion, so the editor refuses it by name rather than appearing to work.
  assert.equal(editorReachOf({ rendering: "rendered", frame: loading }).kind, "projection");
  assert.equal(editorReachOf({ rendering: "html", frame: null }).kind, "no-candidate");
  const arrived = offerOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
    ]),
  );
  assert.ok(arrived !== null);
  const reach = editorReachOf({ rendering: "html", frame: selectedFrame(arrived) });
  assert.equal(reach.kind, "reachable");
  assert.equal(editorIsLive(reach), true);
  for (const kind of ["projection", "unloaded", "no-candidate"] as const) {
    assert.equal(editorIsLive(kind === "unloaded" ? { kind, message: "x" } : { kind }), false);
  }
});

test("the visual editor's list is recorded on the candidate it belongs to", () => {
  const edits: readonly SlideEdit[] = [{ kind: "removed", target: ".badge" }];
  const offer = offerOf(
    play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }, { kind: "edits-changed", index: 2, edits }]),
  );
  assert.deepEqual(offer?.slides[1]?.edits, edits);
  assert.deepEqual(offer?.slides[0]?.edits, [], "and nowhere else");
});

// --- what the dialog's loops fetch ----------------------------------------

test("the grid wants EVERY candidate's HTML, one at a time, in order", () => {
  let state = play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]);
  const asked: number[] = [];
  for (let step = 0; step < proposal.count; step++) {
    const next = nextHtmlToLoad(offerOf(state) ?? neverOffer());
    assert.ok(next !== null, `step ${step} had nothing to load`);
    asked.push(next.index);
    state = reducePicker(state, { kind: "html-requested", index: next.index });
    state = reducePicker(state, { kind: "html-arrived", index: next.index, html: "<html></html>" });
  }
  assert.deepEqual(asked, [1, 2, 3, 4]);
  assert.equal(nextHtmlToLoad(offerOf(state) ?? neverOffer()), null, "and then it stops asking");
});

test("a candidate whose HTML failed is not asked for again, and the others still load", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-requested", index: 1 },
    { kind: "html-failed", index: 1, message: "Drive said 404" },
  ]);
  assert.equal(nextHtmlToLoad(offerOf(state) ?? neverOffer())?.index, 2);
});

test("WHILE THE PREVIEW IS SHOWING, conversion waits for an idle browser -- never the user's click", () => {
  // The converter stages a real offscreen iframe per slide and waits for its fonts and images,
  // on the main thread. Doing it the moment the HTML lands would be a busy UI while the user is
  // trying to click a candidate; doing it only when Converted is clicked made that click wait.
  const previewing = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-arrived", index: 2, html: "<html></html>" },
  ]);
  assert.equal(offerOf(previewing)?.rendering, "html", "the preview is what opens");
  assert.equal(nextToConvert(offerOf(previewing) ?? neverOffer())?.urgency, "idle", "so it converts in the background");
});

test("and it follows the HTML, urgently, once somebody asks for the conversion", () => {
  const state = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    { kind: "html-arrived", index: 2, html: "<html></html>" },
    { kind: "rendering-chosen", rendering: "rendered" },
  ]);
  const due = nextToConvert(offerOf(state) ?? neverOffer());
  assert.equal(due?.frame.index, 2, "1 has no HTML yet, so 2 is next");
  assert.equal(due?.urgency, "now");
});

// --- the grid's markup ----------------------------------------------------

test("the grid draws one cell per candidate, numbered 1..N", () => {
  const markup = markupOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.equal(countOf(markup, /class="sasha-cell[ "]/g), 4, "four cells for four candidates");
  for (const index of [1, 2, 3, 4]) {
    assert.match(markup, new RegExp(`sasha-cell-number" aria-hidden="true">${index}<`), `cell ${index} carries its own number`);
  }
  assert.match(markup, /class="sasha-grid"/);
  // THE PICTURE IS THE CONTROL. A transparent button over the stage opens the editor on that
  // candidate -- the cell carries no name chip, no "Show large" and no caption, because the
  // index is on the picture and everything else was a sentence nobody could act on.
  assert.match(markup, /Open option 3 to request changes/);
  assert.doesNotMatch(markup, /show candidate 3 large/, "clicking the slide IS the zoom");
  assert.doesNotMatch(markup, /work on candidate 3/, "the name chip is gone");
  assert.doesNotMatch(markup, /to mark it up/, "clicking a cell no longer enters a mark-up screen");
  // The only two things a cell can receive, Insert last and accented.
  assert.equal(countOf(markup, />Report defect</g), 4, "one per candidate");
  assert.equal(countOf(markup, /class="sasha-primary sasha-small"[^>]*>Insert</g), 4, "one per candidate");
});

test("a grid cell renders the candidate's own HTML in a scaled sandboxed iframe, never a picture", () => {
  const html = slideHtml({ index: 1, proposalId: "p_1" });
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html },
      { kind: "html-arrived", index: 2, html },
    ]),
  );
  assert.equal(countOf(markup, /<iframe/g), 2, "one iframe per loaded candidate");
  // ONE EDITABLE FRAME AT A TIME. The selected candidate's is `allow-same-origin` so the visual
  // editor can reach its document; every other cell keeps the strictest box. `allow-scripts` is
  // granted nowhere, under either sandbox, so no candidate ever executes anything.
  // EVERY grid cell is inert. The live editor lives in the editor window, which is the only
  // place a candidate gets `allow-same-origin` -- so the grid cannot be reached into at all.
  assert.equal(countOf(markup, /sandbox=""/g), 2, "both cells inert in the grid");
  assert.equal(countOf(markup, /sandbox="allow-same-origin"/g), 0, "the grid never hosts the editor");
  assert.doesNotMatch(markup, /allow-scripts/);
  assert.match(markup, new RegExp(`transform:scale\\(${UNMEASURED_SCALE}\\)`));
  assert.doesNotMatch(markup, /<img/, "a thumbnail would lie; the HTML is authoritative");
});

test("a cell that could not be loaded says so on the cell", () => {
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-requested", index: 2 },
      { kind: "html-failed", index: 2, message: "Drive said 404" },
    ]),
  );
  assert.match(markup, /Drive said 404/, "the stage itself carries the failure");
});

test("in the EDIT tool a cell shows the boxes already reported, with no drag surface over them", () => {
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } },
    ]),
  );
  assert.match(markup, /class="sasha-mark sasha-mark-user"/);
  // The editor draws its chrome over the frame, so a transparent drag overlay above it would
  // swallow every one of its pointer events. `RegionMarks` has no handlers at all.
  assert.doesNotMatch(markup, /class="sasha-overlay"/, "the edit tool does not take the pointer for dragging");
  // The comments have not been read, so the badge says "?" -- never a zero it cannot vouch for.
  assert.match(markup, /class="sasha-cell-unresolved sasha-unresolved-unknown"/);
});

test("the cell's unresolved badge is the conversation's number, and never a silent zero", () => {
  const read = play([
    { kind: "proposal-offered", proposal, presentationId: "deck_1" },
    {
      kind: "comments-arrived",
      comments: {
        kind: "loaded",
        readAt: "2026-10-04T12:00:00.000Z",
        slides: [
          {
            proposalId: proposal.proposalId,
            slideIndex: 1,
            threads: {
              kind: "read",
              threads: [
                {
                  commentId: "cc_1",
                  author: "Krunoslav",
                  text: "gridlines gone",
                  at: "2026-10-04T12:01:00.000Z",
                  resolved: false,
                  region: null,
                  replies: [],
                },
              ],
            },
          },
          { proposalId: proposal.proposalId, slideIndex: 2, threads: { kind: "unreadable", message: "HTTP 404" } },
        ],
      },
    },
  ]);
  const markup = markupOf(read);
  assert.match(markup, /class="sasha-cell-unresolved sasha-unresolved-known" title="1 open comment"/);
  assert.match(markup, /class="sasha-cell-unresolved sasha-unresolved-unreachable"/);
  assert.match(markup, /open comments could not be read: HTTP 404/);
});

// --- the markup, at both zoom levels, with both tools ---------------------

/**
 * THE GRID NEVER TAKES THE POINTER, and that is the change that made this window legible.
 *
 * It used to put a drag surface on all four cells whenever the annotate tool was on, so the
 * grid was simultaneously a chooser and a work surface and carried the chrome for both. The
 * grid is now only a chooser: one toggle, four slides, and picking one opens the editor. The
 * cells still DRAW the marks already on a slide; they just do not accept the gesture.
 */
test("the grid is a chooser: no drag surface on any cell, whatever the tool says", () => {
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
      { kind: "tool-chosen", tool: "annotate" },
    ]),
  );
  assert.match(markup, /class="sasha-grid"/);
  assert.equal(countOf(markup, /class="sasha-overlay"/g), 0, "the grid chooses; the editor works");
  // And the chrome above it is ONE toggle -- no VIEW group, no TOOL group.
  assert.match(markup, /Preview/);
  assert.match(markup, /Converted/);
  assert.doesNotMatch(markup, /All candidates|One slide/, "the view switch is gone with the single pane");
});

/**
 * PICKING A CANDIDATE OPENS THE EDITOR ON TOP, and the grid stays mounted underneath.
 *
 * It used to REPLACE the grid with a single large pane, which is why this test once asserted the
 * grid was gone. An overlay is what makes closing come back to exactly where the user was --
 * same scroll position, same choice -- so the grid being rendered at the same time is now the
 * point rather than a bug.
 */
test("picking a candidate opens the editor over the grid, with the current tool on it", () => {
  const annotating = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 2, html: slideHtml({ index: 2, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 2 },
      { kind: "tool-chosen", tool: "annotate" },
    ]),
  );
  assert.match(annotating, /class="sasha-editor-scrim"/, "the editor is a window on top");
  assert.match(annotating, /class="sasha-grid"/, "and the grid is still underneath, where it was");
  assert.match(annotating, /Close the editor/, "with a way out");
  assert.match(annotating, /class="sasha-toolrail"/, "and the toolbar down its left edge");
  /*
   * NO DRAG SURFACE AT ALL on a candidate whose document is reachable. Annotate points at
   * elements now -- hover, click, click again for the parent -- the way Claude's own artifact
   * comments do, and a transparent overlay above the frame would swallow every one of those
   * clicks. The rectangle is the fallback, and the converted rendering below is where it lives.
   */
  assert.equal(
    countOf(annotating, /class="sasha-overlay"/g),
    0,
    "a live document is clicked, not dragged over",
  );
  assert.match(annotating, /Click a thing on the slide to comment on it/, "and the tool says so");

  // THE RECTANGLE COMES BACK where there are no elements to click: the converted rendering is a
  // picture, so "this part" can only be said with a box.
  const overPicture = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 2, html: slideHtml({ index: 2, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 2 },
      { kind: "tool-chosen", tool: "annotate" },
      { kind: "rendering-chosen", rendering: "rendered" },
    ]),
  );
  assert.equal(
    countOf(overPicture, /class="sasha-overlay"/g),
    1,
    "nothing to point at, so the drag surface returns",
  );

  // THE SAME WINDOW WITH THE SELECT TOOL: no drag surface, the visual editor's panel instead.
  const selecting = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 2, html: slideHtml({ index: 2, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 2 },
    ]),
  );
  assert.doesNotMatch(selecting, /class="sasha-overlay"/);
  assert.match(selecting, /Visual edits/);
});

test("the mark-up list names the slide each box is on, so a box drawn in the grid is findable", () => {
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "editor-opened", index: 2 },
      { kind: "tool-chosen", tool: "annotate" },
      { kind: "anomaly-drawn", index: 2, anomalyId: "user_1", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 } },
      { kind: "anomaly-noted", index: 2, anomalyId: "user_1", note: "gridlines gone" },
    ]),
  );
  // A textarea carries its value as its CHILD, not as a value attribute -- which is also the
  // proof that the composer is multiline now.
  assert.match(markup, /<textarea[^>]*class="sasha-note"[^>]*>gridlines gone<\/textarea>/);
  assert.match(markup, /slide 2 -- 10%,20% 30%x25%/, "the slide number AND the readable region");
});

test("the visual editor's slot says what it is for, and lists the edits once there are some", () => {
  const empty = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 1 },
    ]),
  );
  assert.match(empty, /Visual edits/);
  assert.match(empty, /no edits yet|waiting for the candidate to render/);
  // ONE ROW when there is nothing to list. The panel is always on screen (edit is the default), so
  // its empty state is part of the grid's vertical budget -- the sentence is the header's caption
  // rather than a paragraph under it, and the Undo button only exists once there is something to
  // undo. The browser smoke test measures the budget and fails if this grows back.
  assert.match(empty, /travels to Sasha as the change itself, never as the slide&#x27;s markup/);
  assert.doesNotMatch(empty, />Undo</, "nothing to undo yet, so no button taking a row's worth of height");

  const edited = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 1 },
      {
        kind: "edits-changed",
        index: 1,
        edits: [
          { kind: "moved", target: "h1.title", from: { x: 0.08, y: 0.1 }, to: { x: 0.08, y: 0.16 } },
          { kind: "retext", target: "h1.title", to: "Q3 infrastructure spend" },
        ],
      },
    ]),
  );
  assert.match(edited, /2 edits/);
  assert.match(edited, />Undo</, "and the button appears once there is something to undo");
  // The sentences are the EDITOR's own (`describeEdit`), re-exported through slide-editor.ts rather
  // than reworded here -- the editor is the authority on what one of its edits means.
  assert.match(edited, /moved h1\.title to 8%,16%/);
  // `retext` quotes the new words, and only `retext` does: UI-CONTRACT.md makes it the one place
  // slide text legitimately crosses, because the user typed it. Nothing else here is slide content.
  assert.match(edited, /retext h1\.title to &quot;Q3 infrastructure spend&quot;/);
});

test("the converted view replaces the documents in every cell, not just the open one", () => {
  const converted = stubConvertHtmlToSlideRequests()({
    html: slideHtml({ index: 1, proposalId: "p_1" }),
    presentationId: "deck_1",
    pageObjectId: "sasha_page",
  });
  const markup = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 1, html: slideHtml({ index: 1, proposalId: "p_1" }) },
      { kind: "converted", index: 1, result: converted },
      { kind: "rendering-chosen", rendering: "rendered" },
      { kind: "editor-opened", index: 1 },
    ]),
  );
  assert.doesNotMatch(markup, /<iframe/, "the HTML pane is not rendered at the same time");
  assert.match(markup, /sasha-el sasha-el-shape/);
  assert.match(markup, /converting\.\.\./, "the cells with no conversion yet say so rather than sitting blank");
  // And the editor says WHY it is not live, rather than leaving an unexplained empty panel.
  assert.match(markup, /switch the rendering back to HTML/);
});

test("an offer whose selected candidate is missing from the manifest says so instead of blanking", () => {
  // `clampIndex` makes this unreachable through the reducer, so the state is built directly: the
  // render path still has to answer for it, which is the whole reason the branch exists.
  const offer = offerOf(play([{ kind: "proposal-offered", proposal, presentationId: "deck_1" }]));
  assert.ok(offer !== null);
  const broken: PickerState = {
    status: "picking",
    offer: { ...offer, rendering: "html", editing: 9, selectedIndex: 9 },
  };
  assert.equal(selectedFrame({ ...offer, selectedIndex: 9 }), null);
  assert.match(markupOf(broken), /option 9 is missing from the manifest/);
});

// --- the editor seam ------------------------------------------------------

test("the null editor satisfies the interface: no edits, HTML unchanged, nothing to undo", () => {
  const editor = nullSlideEditor({ html: "<html>kept</html>" });
  assert.deepEqual(editor.edits(), []);
  assert.equal(editor.html(), "<html>kept</html>");
  assert.equal(editor.undo(), false);
});

test("the edit record carries the candidate's 1-based number and the edits, and no markup", () => {
  const record = slideEditRecord({
    candidateIndex: 2,
    protocolVersion: 1,
    edits: [{ kind: "recoloured", target: ".accent", property: "color", from: "#2b3a8f", to: "#111111" }],
  });
  assert.deepEqual(record, {
    protocolVersion: 1,
    candidateIndex: 2,
    edits: [{ kind: "recoloured", target: ".accent", property: "color", from: "#2b3a8f", to: "#111111" }],
  });
});

test("every edit kind has a sentence, so none can render as an object", () => {
  const every: readonly SlideEdit[] = [
    { kind: "moved", target: "a", from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.25 } },
    { kind: "resized", target: "b", from: { w: 0.4, h: 0.3 }, to: { w: 0.52, h: 0.3 } },
    { kind: "recoloured", target: "c", property: "color", from: "#000", to: "#fff" },
    { kind: "retext", target: "d", to: "whatever" },
    { kind: "removed", target: "e" },
  ];
  for (const edit of every) {
    const sentence = describeSlideEdit(edit);
    assert.notEqual(sentence, "");
    assert.doesNotMatch(sentence, /\[object/);
  }
  assert.equal(describeSlideEdit(every[1] ?? neverEdit()), "resized b to 52%x30%");
});

function play(events: readonly PickerEvent[]): PickerState {
  let state = INITIAL_PICKER_STATE;
  for (const event of events) state = reducePicker(state, event);
  return state;
}

function markupOf(state: PickerState): string {
  return renderToStaticMarkup(createElement(Picker, { state, actions: INERT_PICKER_ACTIONS }));
}

function countOf(markup: string, pattern: RegExp): number {
  return markup.match(pattern)?.length ?? 0;
}

function neverOffer(): never {
  throw new Error("expected an offer");
}

function neverEdit(): never {
  throw new Error("expected an edit");
}

/**
 * WAITING IS A LOADER, NOT AN ESSAY.
 *
 * The dormant window used to explain itself in two paragraphs -- what would appear here, what
 * you could do with it, and that you could close it. The user's verdict: "This is also a
 * confusing loading screen, just use a loader." Nothing there was actionable: the window is
 * waiting, and the only honest thing to show is that it is waiting.
 */
test("the dormant window is a loader and nothing else", () => {
  const markup = markupOf(INITIAL_PICKER_STATE);
  assert.match(markup, /class="sasha-loader"/, "a loader");
  assert.doesNotMatch(markup, /Ask Sasha for a slide and the candidates appear/);
  assert.doesNotMatch(markup, /This window is watching your Drive/);
  assert.doesNotMatch(markup, /Waiting for slides/);
});

/**
 * THE COMPOSER OPENS ON WHAT WAS CLICKED -- the whole point of the annotate rework.
 *
 * The old flow put the note field in a list under the slide, so a comment about a heading was
 * typed somewhere the heading was not. Claude's own artifact comments anchor the box to the
 * thing, and this now does the same: the composer is inside the stage, positioned from the
 * selection's own region, headed with what was selected.
 */
test("selecting an element with the annotate tool opens a composer anchored to it", () => {
  const selected = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 2, html: slideHtml({ index: 2, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 2 },
      { kind: "tool-chosen", tool: "annotate" },
      {
        kind: "selection-changed",
        selection: {
          target: "div > section > h1",
          html: "<h1>Paths in</h1>",
          region: { x: 0.1, y: 0.12, w: 0.5, h: 0.14 },
        },
      },
    ]),
  );
  assert.match(selected, /class="sasha-spot"/, "the composer is open");
  // Headed by the thing, not the selector chain.
  assert.match(selected, /Comment on h1/);
  assert.match(selected, /What is wrong with this\?/, "with the cursor's prompt");
  assert.match(selected, />Comment</, "and a button that says what it does");
  // Placed from the region: 0.12 + 0.14 + the gap, as composerPlacementFor computes it.
  assert.match(selected, /data-side="below"/);
  assert.match(selected, /left:\s*10%/, "aligned with the selection's left edge");
  // The hint it replaces is gone while something is selected.
  assert.match(selected, /Comment on h1/, "the composer is what speaks while something is selected");
});

test("and the SELECT tool does not open one -- it inspects instead", () => {
  const selected = markupOf(
    play([
      { kind: "proposal-offered", proposal, presentationId: "deck_1" },
      { kind: "html-arrived", index: 2, html: slideHtml({ index: 2, proposalId: "p_1" }) },
      { kind: "editor-opened", index: 2 },
      {
        kind: "selection-changed",
        selection: { target: "h1", html: "<h1>Paths in</h1>", region: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } },
      },
    ]),
  );
  assert.doesNotMatch(selected, /class="sasha-spot"/, "select edits; annotate comments");
});
