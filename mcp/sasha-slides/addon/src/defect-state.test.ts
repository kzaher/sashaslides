// Same order as defect-state.ts: the flow, then the two slides, then the edits, then the gates,
// then the surface.
//
// The anonymiser is REAL here, not a fake: it is pure string-in/string-out, so the slide these
// tests assert on is the one the user is shown, including its verdicts -- which is the behaviour the
// whole surface exists to make visible.
//
// WHAT THESE TESTS PIN, which is the whole of UI-CONTRACT.md's "The defect report is the same
// editor, not a table":
//
//   1. there is NO run-by-run table: the surface renders two slides;
//   2. `rejectedReplacements`, `shapeRisks` and `residualRisks` are still visible, as annotations;
//   3. editing the LEFT slide is re-anonymised; editing the RIGHT slide is what gets sent;
//   4. the bytes sent are the bytes the right-hand slide renders, and an edit after preparing makes
//      the report unsendable rather than sending yesterday's bytes;
//   5. a hand edit that puts the original slide's words back cannot even be prepared.

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { anonymiseSlideHtml, extractTextRuns, type DefectReportPreview } from "./anonymise/index.ts";
import { DefectPanel } from "./Defect.tsx";
import {
  annotationIsPinned,
  annotationsOf,
  canPrepare,
  defectOnSlide,
  defectWithoutSlide,
  discardedSentEdits,
  editsOnSide,
  flaggedRunsOf,
  needsPass,
  needsSlideHtml,
  preparable,
  previewIsStale,
  reduceDefect,
  reintroducedOriginals,
  replacementsFor,
  sendableAnonymised,
  runRowsOf,
  sendablePreview,
  sentFrameHtmlOf,
  sentHtmlOf,
  sourceFrameHtmlOf,
  sourceHtmlOf,
  titleRunOf,
  type Defect,
  type DefectEvent,
  type ReportAnnotation,
} from "./defect-state.ts";
import { INERT_DEFECT_ACTIONS } from "./inert-actions.ts";

const SEED = "test-seed";
const HTML =
  '<html><head><title>Northwind Q3</title></head><body><h1>Northwind revenue</h1><p>Rose to 3,200,000</p></body></html>';

// --- the flow --------------------------------------------------------------

test("a flow with no slide says what it needs instead of showing two blank panes", () => {
  const defect = defectWithoutSlide({ seed: SEED, message: "no candidate slide is staged" });
  assert.equal(needsSlideHtml(defect), false);
  assert.equal(needsPass(defect), false);
  assert.match(markupOf(defect), /no candidate slide is staged/);
});

test("the HTML is fetched once, then the pass runs, and the pass is what the two slides read", () => {
  const fresh = defectOnSlide({ fileId: "html_1", label: "option 1", seed: SEED });
  assert.equal(needsSlideHtml(fresh), true);
  const loading = reduceDefect(fresh, { kind: "slide-requested" });
  assert.equal(needsSlideHtml(loading), false);
  const loaded = reduceDefect(loading, { kind: "slide-arrived", html: HTML });
  assert.equal(needsPass(loaded), true);
  assert.equal(sentFrameHtmlOf(loaded), null, "nothing is rendered on the right from a pass that has not run");
  assert.equal(sourceFrameHtmlOf(loaded), HTML, "but the left slide is the user's own bytes already");
  const passed = withPass(loaded);
  assert.equal(needsPass(passed), false);
  assert.deepEqual(
    runRowsOf(passed).map((row) => row.before),
    ["Northwind Q3", "Northwind revenue", "Rose to 3,200,000"],
  );
});

test("a pass that threw says so and is not retried on its own", () => {
  const failed = play(loadedDefect(), [{ kind: "pass-failed", message: "tokenizer gave up" }]);
  assert.equal(needsPass(failed), false);
  assert.match(markupOf(failed), /could not be anonymised: tokenizer gave up/);
});

// --- the two slides --------------------------------------------------------

test("THE SURFACE IS TWO RENDERED SLIDES AND NOT A TABLE OF RUNS", () => {
  const markup = markupOf(withPass(loadedDefect()));
  assert.match(markup, /class="sasha-pair sasha-pair-pair"/);
  assert.equal(countOf(markup, /class="sasha-pane-side /g), 2, "both slides are on screen");
  assert.equal(countOf(markup, /<iframe/g), 2, "both are RENDERED, not described");
  assert.match(markup, /As it is/);
  assert.match(markup, /As it will be sent/);
  // The table and the model round trip that filled half of it are gone.
  assert.doesNotMatch(markup, /<table/);
  assert.doesNotMatch(markup, /Before -- not in the report/);
  assert.doesNotMatch(markup, /Ask Sasha to rewrite/);
  assert.doesNotMatch(markup, /Only the [0-9]+ refused/);
});

test("the view is a ZOOM LEVEL: one slide at full width, and it changes nothing about what is sent", () => {
  const passed = withPass(loadedDefect());
  const sent = sentHtmlOf(passed);
  const zoomed = play(passed, [{ kind: "view-chosen", view: "as-sent" }]);
  const markup = markupOf(zoomed);
  assert.equal(countOf(markup, /<iframe/g), 1, "only the slide that is being looked at");
  assert.match(markup, /class="sasha-pair sasha-pair-as-sent"/);
  assert.equal(sentHtmlOf(zoomed), sent, "the bytes did not move");

  const prepared = preparedFrom(passed);
  assert.notEqual(sendablePreview(prepared), null);
  assert.notEqual(
    sendablePreview(play(prepared, [{ kind: "view-chosen", view: "as-is" }])),
    null,
    "and a prepared report stays sendable: a view is not a mode",
  );
});

test("the left slide's bytes are the user's own and the right slide's are the anonymisation", () => {
  const passed = withPass(loadedDefect());
  assert.equal(sourceFrameHtmlOf(passed), HTML);
  const sent = sentFrameHtmlOf(passed);
  assert.ok(sent !== null && !sent.includes("Northwind"), "nothing original survives on the right");
  assert.equal(sent, sentHtmlOf(passed), "and the bytes rendered are the bytes sent");
});

test("every run is lorem or substituted -- nothing original survives, with no model involved", () => {
  const passed = withPass(loadedDefect());
  for (const row of runRowsOf(passed)) {
    assert.equal(row.origin, "substituted");
    assert.notEqual(row.after, row.before);
  }
  assert.equal(flaggedRunsOf(passed).length, 0, "and with nobody proposing anything, nothing is refused");
});

// --- the annotations, which replaced the table's columns -------------------

test("THE RESIDUAL RISKS ARE STILL ON SCREEN, verbatim, as numbered notes about the sent slide", () => {
  const passed = withPass(loadedDefect());
  const annotations = annotationsOf(passed);
  const anonymised = passed.pass.kind === "run" ? passed.pass.slide : null;
  assert.ok(anonymised !== null);
  for (const risk of anonymised.residualRisks) {
    assert.ok(
      annotations.some((annotation) => annotation.detail === risk),
      `the anonymiser's own sentence is rendered word for word: ${risk}`,
    );
  }
  assert.ok(annotations.every((annotation) => annotation.side === "as-sent"));
  const markup = markupOf(passed);
  assert.match(markup, /class="sasha-annot-list"/, "one numbered card per note");
  assert.equal(countOf(markup, /class="sasha-annot sasha-annot-/g), annotations.length);
  for (const annotation of annotations) assert.equal(annotationIsPinned(annotation.tone), false);
  // AND NO PINS, because a clean pass has nothing to decide about. A dozen grey dots for a dozen
  // residual-risk sentences said nothing about where anything was and buried the one pin that
  // means "look at this slide before you send it".
  assert.doesNotMatch(markup, /class="sasha-pins"/);
  assert.equal(annotationIsPinned("leak"), true);
  assert.equal(annotationIsPinned("risk"), true);
});

test("A LEAK OR A RISK DOES GET A PIN, in the margin beside the slide it is about", () => {
  const passed = withPass(loadedDefect());
  const anonymised = sentFrameHtmlOf(passed);
  assert.ok(anonymised !== null);
  const edited = play(passed, [
    { kind: "sent-edited", html: anonymised, edits: [{ kind: "removed", target: "h1" }] },
  ]);
  const markup = markupOf(edited);
  assert.match(markup, /class="sasha-pins"/);
  // The pin and its card carry the SAME number, from one numbering over the whole list.
  const pinned = numberedOf(annotationsOf(edited)).filter((entry) => annotationIsPinned(entry.annotation.tone));
  assert.equal(pinned.length, 1);
  assert.equal(countOf(markup, /class="sasha-pin sasha-pin-risk"/g), 2, "one in the margin, one on the card");
  assert.match(markup, new RegExp(`sasha-pin sasha-pin-risk">${pinned[0]?.number ?? 0}<`));
});

test("A REFUSED REPLACEMENT IS AN ANNOTATION, and it says what the slide actually says instead", () => {
  // The echo rule has no model to judge any more, but it still judges the USER: a title that hands
  // the original back is refused, gibberished, and reported.
  const refused = withPass(play(loadedDefect(), [{ kind: "run-edited", runId: runIdAt(0), text: "Northwind Q3" }]));
  const row = flaggedRunsOf(refused)[0];
  assert.equal(row?.rejected?.reason, "unchanged");
  assert.equal(row?.typed, "Northwind Q3");
  assert.notEqual(row?.after, row?.typed);
  const annotation = annotationsOf(refused).find((entry) => entry.annotationId.startsWith("rejected_"));
  assert.equal(annotation?.tone, "risk");
  assert.match(markupOf(refused), /A replacement you typed was refused/);
});

test("a replacement that reuses four consecutive characters is refused, and is fixable by hand", () => {
  const echoed = play(loadedDefect(), [{ kind: "run-edited", runId: runIdAt(0), text: "Northwind autumn" }]);
  assert.equal(flaggedRunsOf(withPass(echoed))[0]?.rejected?.reason, "echoes-original");
  // Typing again over the SAME run replaces that edit rather than adding a second one.
  const fixed = withPass(play(echoed, [{ kind: "run-edited", runId: runIdAt(0), text: "Bolt Works autumn" }]));
  assert.equal(fixed.edits.length, 1);
  assert.equal(titleRunOf(fixed)?.origin, "rewritten");
  assert.equal(flaggedRunsOf(fixed)[0]?.rejected ?? null, null, "the refusal is gone");
  // A SHAPE RISK may remain, and that is the engine doing its job: the replacement is longer than
  // the original, so the line may wrap differently and the defect may not reproduce off the layout.
  // It is a risk annotation, not a refusal, and the two are not interchangeable.
  for (const row of flaggedRunsOf(fixed)) assert.ok(row.shapeRisk !== null);
});

test("the preserve policy ANNOTATES what would be sent verbatim, so the trade-off is read", () => {
  const preserved = withPass(
    play(
      reduceDefect(defectOnSlide({ fileId: "f", label: "option 1", seed: SEED }), {
        kind: "slide-arrived",
        html: '<body><h1 class="acme-q3-revenue">Northwind revenue</h1></body>',
      }),
      [{ kind: "policy-chosen", identifiers: "preserve" }],
    ),
  );
  const annotation = annotationsOf(preserved).find((entry) => entry.annotationId === "retained_identifiers");
  assert.equal(annotation?.tone, "risk");
  assert.match(annotation?.detail ?? "", /acme-q3-revenue/);
  assert.match(markupOf(preserved), /acme-q3-revenue/);
});

// --- the title, and the two editable slides --------------------------------

test("THE TITLE IS ITS OWN FIELD, because the visual editor cannot reach a document title", () => {
  const passed = withPass(loadedDefect());
  const title = titleRunOf(passed);
  assert.equal(title?.kind, "document-title");
  assert.equal(title?.before, "Northwind Q3");
  assert.match(markupOf(passed), /Title, as it will be sent/);
  // And it goes through the anonymiser's gate rather than into the bytes: the engine reports it as
  // `rewritten`, which is the engine saying the text IS in the HTML.
  const retitled = withPass(play(passed, [{ kind: "run-edited", runId: runIdAt(0), text: "Bolt Works autumn" }]));
  assert.equal(titleRunOf(retitled)?.after, "Bolt Works autumn");
  assert.equal(titleRunOf(retitled)?.origin, "rewritten");
  assert.ok(sentHtmlOf(retitled)?.includes("Bolt Works autumn"));
});

test("EDITING THE LEFT SLIDE IS RE-ANONYMISED -- nothing on that path bypasses the engine", () => {
  const trimmed = '<html><head><title>Northwind Q3</title></head><body><h1>Northwind revenue</h1></body></html>';
  const edited = play(withPass(loadedDefect()), [
    { kind: "source-edited", html: trimmed, edits: [{ kind: "removed", target: "p" }] },
  ]);
  assert.equal(sourceHtmlOf(edited), trimmed, "the pass runs over what the user left behind");
  assert.equal(needsPass(edited), true, "and it re-runs, rather than keeping the old anonymisation");
  const repassed = withPass(edited);
  assert.deepEqual(
    runRowsOf(repassed).map((row) => row.before),
    ["Northwind Q3", "Northwind revenue"],
  );
  const sent = sentHtmlOf(repassed);
  assert.ok(sent !== null && !sent.includes("Northwind") && !sent.includes("3,200,000"));
  assert.deepEqual(editsOnSide({ defect: repassed, side: "as-is" }), [{ kind: "removed", target: "p" }]);

  // And undoing them goes back to Drive's copy, re-anonymised again.
  const reset = play(repassed, [{ kind: "source-reset" }]);
  assert.equal(sourceHtmlOf(reset), HTML);
  assert.equal(needsPass(reset), true);
});

test("EDITING THE RIGHT SLIDE IS WHAT GETS SENT, and it is annotated as exactly that", () => {
  const passed = withPass(loadedDefect());
  const anonymised = sentFrameHtmlOf(passed);
  assert.ok(anonymised !== null);
  const mine = anonymised.replace("</body>", "<p>lorem ipsum addendum</p></body>");
  const edited = play(passed, [
    { kind: "sent-edited", html: mine, edits: [{ kind: "retext", target: "p", to: "lorem ipsum addendum" }] },
  ]);
  assert.equal(sentHtmlOf(edited), mine, "the bytes that leave are the bytes on the right");
  assert.equal(needsPass(edited), false, "and the pass is NOT re-run: that would wipe the edit on the spot");
  const annotation = annotationsOf(edited).find((entry) => entry.annotationId === "handedited_sent");
  assert.equal(annotation?.tone, "risk");
  assert.match(annotation?.detail ?? "", /sent exactly as you made them/);
  assert.deepEqual(editsOnSide({ defect: edited, side: "as-sent" }), [
    { kind: "retext", target: "p", to: "lorem ipsum addendum" },
  ]);
  assert.equal(sentHtmlOf(play(edited, [{ kind: "sent-reset" }])), anonymised, "and undoing them restores the pass");
});

test("THE SLIDE HANDED TO previewDefectReport CARRIES THE RIGHT-HAND PANE'S BYTES", () => {
  // The hinge of the byte-identity claim: `previewDefectReport` converts `anonymised.html` and
  // `defectReportFrom` sends that same string, so this is what makes "the conversion is made from
  // the bytes that are sent" true for a hand-edited slide as well as an untouched one.
  const passed = withPass(loadedDefect());
  assert.equal(sendableAnonymised(passed), passed.pass.kind === "run" ? passed.pass.slide : null);
  const anonymised = sentFrameHtmlOf(passed);
  assert.ok(anonymised !== null);
  const mine = anonymised.replace("</body>", "<p>lorem addendum</p></body>");
  const edited = play(passed, [
    { kind: "sent-edited", html: mine, edits: [{ kind: "retext", target: "p", to: "lorem addendum" }] },
  ]);
  const sendable = sendableAnonymised(edited);
  assert.equal(sendable?.html, mine, "the bytes the pane renders");
  assert.equal(sendable?.html, sentHtmlOf(edited), "and the same ones the pane is rendered from");
  // The SUMMARY still describes the pass the engine ran, not the hand edit -- which is why
  // `annotationsOf` puts "N of your own edits are in what is sent" on the slide.
  assert.deepEqual(sendable?.residualRisks, currentAnonymisedRisksOf(edited));
  assert.equal(sendableAnonymised(loadedDefect()), null, "and there is nothing sendable before a pass");
});

test("A HAND EDIT THAT PUTS THE ORIGINAL'S WORDS BACK CANNOT BE PREPARED AT ALL", () => {
  const passed = withPass(loadedDefect());
  const anonymised = sentFrameHtmlOf(passed);
  assert.ok(anonymised !== null);
  const leaking = anonymised.replace("</body>", "<p>Northwind revenue</p></body>");
  const edited = play(passed, [
    { kind: "sent-edited", html: leaking, edits: [{ kind: "retext", target: "p", to: "Northwind revenue" }] },
  ]);
  assert.deepEqual(reintroducedOriginals(edited), ["Northwind revenue"]);
  const readiness = preparable(edited);
  assert.equal(readiness.kind, "leaking");
  assert.equal(canPrepare(readiness), false);
  const leak = annotationsOf(edited).find((entry) => entry.tone === "leak");
  assert.match(leak?.detail ?? "", /Northwind revenue/);
  const markup = markupOf(edited);
  assert.match(markup, /own words are back on this slide/);
  assert.match(markup, /class="sasha-secondary sasha-prepare" disabled/);
  // Undoing the edit clears it, so a refusal is recoverable rather than a dead end.
  assert.equal(preparable(play(edited, [{ kind: "sent-reset" }])).kind, "ready");
});

test("the anonymiser's OWN output is never scanned for originals: there is nothing there to find", () => {
  // The check exists only because the right pane is editable. Running it over an untouched pass
  // would be work with no possible finding, on every render.
  assert.deepEqual(reintroducedOriginals(withPass(loadedDefect())), []);
});

test("RE-ANONYMISING DROPS EDITS MADE AGAINST THE OLD BYTES -- never silently", () => {
  const passed = withPass(loadedDefect());
  const anonymised = sentFrameHtmlOf(passed);
  assert.ok(anonymised !== null);
  const edited = play(passed, [
    { kind: "sent-edited", html: anonymised, edits: [{ kind: "removed", target: "h1" }] },
  ]);
  const again = withPass(play(edited, [{ kind: "reanonymise-requested" }]));
  assert.equal(discardedSentEdits(again), 1);
  assert.deepEqual(editsOnSide({ defect: again, side: "as-sent" }), [], "they do not apply to bytes they predate");
  assert.equal(sentHtmlOf(again), sentFrameHtmlOf(again), "so the sent bytes are the fresh anonymisation");
  const annotation = annotationsOf(again).find((entry) => entry.annotationId === "discarded_sent");
  assert.match(annotation?.detail ?? "", /anonymised again/);
  assert.match(markupOf(again), /1 of your edits to this slide were dropped/);
});

// --- the gates -------------------------------------------------------------

test("NOTHING IS SENDABLE until a preview has been prepared from the slide on screen", () => {
  const passed = withPass(loadedDefect());
  assert.equal(sendablePreview(passed), null);
  assert.equal(preparable(passed).kind, "ready");
  const prepared = preparedFrom(passed);
  assert.notEqual(sendablePreview(prepared), null);
});

test("AND AN EDIT AFTER PREPARING MAKES IT UNSENDABLE, with the reason on screen", () => {
  const prepared = preparedFrom(withPass(loadedDefect()));
  const retitled = withPass(play(prepared, [{ kind: "run-edited", runId: runIdAt(0), text: "Bolt Works autumn" }]));
  assert.equal(sendablePreview(retitled), null);
  assert.equal(previewIsStale(retitled), true);
  assert.match(markupOf(retitled), /Prepare it again/);
  assert.match(markupOf(retitled), /class="sasha-primary sasha-send" disabled/);
});

test("A HAND EDIT TO THE SENT SLIDE ALSO MAKES IT UNSENDABLE, even though the pass did not move", () => {
  // This is the case a generation counter alone would miss: the anonymisation is unchanged, so the
  // only thing that moved is the bytes -- which is why the gate compares the bytes themselves.
  const prepared = preparedFrom(withPass(loadedDefect()));
  const anonymised = sentFrameHtmlOf(prepared);
  assert.ok(anonymised !== null);
  const edited = play(prepared, [
    {
      kind: "sent-edited",
      html: anonymised.replace("</body>", "<p>lorem addendum</p></body>"),
      edits: [{ kind: "retext", target: "p", to: "lorem addendum" }],
    },
  ]);
  assert.equal(edited.generation, prepared.generation, "the pass is untouched");
  assert.equal(sendablePreview(edited), null, "and it is still unsendable");
  assert.equal(previewIsStale(edited), true);
});

test("CHANGING THE NOTE makes it unsendable too -- and must NOT re-anonymise the slide", () => {
  // The note is in the payload, so a prepared preview is stale. But `edited()` here would re-run the
  // pass on every keystroke AND throw away the user's hand edits while they typed the covering
  // note, so the staleness is caught by comparing the note the preview was BUILT with.
  const prepared = preparedFrom(withPass(loadedDefect()));
  const noted = play(prepared, [{ kind: "note-typed", text: "the table lost its gridlines" }]);
  assert.equal(needsPass(noted), false, "typing a note does not re-anonymise");
  assert.equal(noted.generation, prepared.generation);
  assert.equal(sendablePreview(noted), null);
  assert.equal(previewIsStale(noted), true);
});

test("changing the ENDPOINT does not, because where it goes is not what is sent", () => {
  const prepared = preparedFrom(withPass(loadedDefect()));
  const moved = play(prepared, [{ kind: "endpoint-typed", endpoint: "https://reports.example/v1/reports" }]);
  assert.notEqual(sendablePreview(moved), null);
});

test("a new slide throws away every edit: a run id and a selector both name THAT document", () => {
  const edited = play(loadedDefect(), [
    { kind: "run-edited", runId: runIdAt(0), text: "Bolt Works autumn" },
    { kind: "source-edited", html: "<body><h1>trimmed</h1></body>", edits: [{ kind: "removed", target: "p" }] },
  ]);
  const other = reduceDefect(edited, { kind: "slide-arrived", html: "<body><h1>Different</h1></body>" });
  assert.equal(replacementsFor(other).size, 0);
  assert.deepEqual(editsOnSide({ defect: other, side: "as-is" }), []);
  assert.deepEqual(editsOnSide({ defect: other, side: "as-sent" }), []);
});

test("every send verdict reaches the screen, including one nothing answered", () => {
  const unreachable = play(withPass(loadedDefect()), [
    { kind: "send-answered", submission: { kind: "unreachable", message: "nothing answered at that endpoint" } },
  ]);
  assert.match(markupOf(unreachable), /nothing answered at that endpoint/);
  const refused = play(withPass(loadedDefect()), [
    {
      kind: "send-answered",
      submission: { kind: "refused", status: 422, code: "unknown-field", message: "unknown field presentationId" },
    },
  ]);
  assert.match(markupOf(refused), /422 unknown-field/);
  const accepted = play(withPass(loadedDefect()), [
    {
      kind: "send-answered",
      submission: { kind: "accepted", id: "rep_1", deletionToken: "del_1", duplicate: false, storedBytes: 12 },
    },
  ]);
  assert.match(markupOf(accepted), /rep_1/);
  assert.match(markupOf(accepted), /del_1/);
});

/** The pass's own residual risks, for the test that the summary is NOT re-derived from edited bytes. */
function currentAnonymisedRisksOf(defect: Defect): readonly string[] {
  return defect.pass.kind === "run" ? defect.pass.slide.residualRisks : [];
}

/** The flow with its slide in. One place, so a test reads as the step it is about. */
function loadedDefect(): Defect {
  return reduceDefect(defectOnSlide({ fileId: "html_1", label: "option 1", seed: SEED }), {
    kind: "slide-arrived",
    html: HTML,
  });
}

/**
 * The pass the composition root would have run, run here. It is the REAL anonymiser over the real
 * replacements and over `sourceHtmlOf`, so an edit to the left-hand slide is anonymised in a test
 * exactly as it is in the window.
 */
function withPass(defect: Defect): Defect {
  const html = sourceHtmlOf(defect);
  if (html === null) return defect;
  return reduceDefect(defect, {
    kind: "pass-run",
    runs: extractTextRuns({ html }),
    slide: anonymiseSlideHtml({
      html,
      seed: defect.seed,
      identifiers: defect.identifiers,
      replacements: replacementsFor(defect),
    }),
  });
}

/**
 * A prepared report, built the way `report.tsx` builds one: from `sentHtmlOf` and the note as they
 * stand. Going through the same two values is what makes the staleness tests mean anything.
 */
function preparedFrom(defect: Defect): Defect {
  const sentHtml = sentHtmlOf(defect);
  if (sentHtml === null) throw new Error("nothing to prepare");
  return play(defect, [
    { kind: "preview-requested" },
    { kind: "preview-built", sentHtml, preview: { ...PREVIEW, note: defect.note } },
  ]);
}

function play(defect: Defect, events: readonly DefectEvent[]): Defect {
  return events.reduce(reduceDefect, defect);
}

/** The id of the nth run of `HTML`, read from the anonymiser rather than guessed. */
function runIdAt(position: number): string {
  const run = extractTextRuns({ html: HTML })[position];
  if (run === undefined) throw new Error(`no run at ${position}`);
  return run.id;
}

function markupOf(defect: Defect): string {
  return renderToStaticMarkup(createElement(DefectPanel, { defect, actions: INERT_DEFECT_ACTIONS }));
}

/** The numbering the surface uses, so a test can name the number a pin must carry. */
function numberedOf(
  annotations: readonly ReportAnnotation[],
): readonly Readonly<{ number: number; annotation: ReportAnnotation }>[] {
  return annotations.map((annotation, position) => ({ number: position + 1, annotation }));
}

function countOf(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

const PREVIEW: DefectReportPreview = {
  anonymised: {
    html: "<html></html>",
    carriers: [],
    textRuns: [],
    rejectedReplacements: [],
    shapeRisks: [],
    retainedIdentifiers: [],
    unrecognisedAttributes: [],
    residualRisks: [],
  },
  identifierPolicy: "rename",
  conversion: { requests: [], unsupported: [] },
  redactedIdentifierCount: 0,
  redactedUrlCount: 0,
  note: "",
  versions: { converter: "2026.10.04", addon: "0.1.0", protocol: "1" },
};
