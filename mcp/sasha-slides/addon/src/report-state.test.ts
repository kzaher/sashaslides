// THE DEFECT-REPORT WINDOW's outer machine: its three statuses, and how it chooses a candidate out
// of a target recorded by a document that has since been closed.
//
// The rule being protected is that the window never refuses to open and never comes up on a slide
// it cannot explain: every way of not finding the asked-for candidate is a named outcome with a
// sentence attached, because the user pressed the button on slide 3 and has to be told why they
// are looking at slide 1.

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DefectPanel } from "./Defect.tsx";
import { defectOnSlide, defectWithoutSlide } from "./defect-state.ts";
import { INERT_DEFECT_ACTIONS } from "./inert-actions.ts";
import type { SlideEntry } from "./protocol.ts";
import {
  chosenTarget,
  defectOf,
  describeChosenTarget,
  INITIAL_REPORT_SURFACE,
  reduceReportSurface,
  type ReportSurface,
  type ReportSurfaceEvent,
} from "./report-state.ts";

const SEED = "a".repeat(64);
const slides: readonly SlideEntry[] = [
  { index: 1, fileId: "html_1", name: "01.html", label: "option 1" },
  { index: 2, fileId: "html_2", name: "02.html", label: "option 2" },
  { index: 3, fileId: "html_3", name: "03.html", label: "option 3" },
];

// --- the three statuses ---------------------------------------------------

test("the window opens on a progress line, never on a blank page", () => {
  assert.equal(INITIAL_REPORT_SURFACE.status, "connecting");
  assert.match(markupOf(INITIAL_REPORT_SURFACE), /connecting to Google Slides/);
  const finding = replay([{ kind: "progress", what: "finding the slide to report on..." }]);
  assert.match(markupOf(finding), /finding the slide to report on/);
});

test("a start-up failure is a line on screen, not a spinner that cannot end", () => {
  const broken = replay([{ kind: "trouble", message: "sashaHello did not answer within 25000 ms" }]);
  assert.match(markupOf(broken), /sashaHello did not answer within 25000 ms/);
});

test("a flow already open outranks a late progress line or a late failure -- edits are not discarded", () => {
  const open = replay([{ kind: "opened", defect: defectOnSlide({ fileId: "html_2", label: "option 2", seed: SEED }) }]);
  assert.equal(open.status, "reporting");
  assert.equal(reduceReportSurface(open, { kind: "progress", what: "still looking" }), open);
  assert.equal(reduceReportSurface(open, { kind: "trouble", message: "a late hiccup" }), open);
});

test("re-opening keeps the flow the user is in", () => {
  const first = defectOnSlide({ fileId: "html_2", label: "option 2", seed: SEED });
  const open = replay([{ kind: "opened", defect: first }]);
  const again = reduceReportSurface(open, {
    kind: "opened",
    defect: defectOnSlide({ fileId: "html_3", label: "option 3", seed: SEED }),
  });
  assert.equal(defectOf(again), first);
});

test("the flow's own events reach the Defect reducer, and only while a flow is open", () => {
  const open = replay([
    { kind: "opened", defect: defectOnSlide({ fileId: "html_2", label: "option 2", seed: SEED }) },
  ]);
  const noted = reduceReportSurface(open, { kind: "defect", event: { kind: "note-typed", text: "the table bled" } });
  assert.equal(defectOf(noted)?.note, "the table bled");
  // Before a flow is open there is nothing to reduce, and the event is dropped rather than
  // conjuring a `Defect` with no slide and no seed.
  const early = reduceReportSurface(INITIAL_REPORT_SURFACE, {
    kind: "defect",
    event: { kind: "note-typed", text: "x" },
  });
  assert.equal(early, INITIAL_REPORT_SURFACE);
  assert.equal(defectOf(INITIAL_REPORT_SURFACE), null);
});

// --- choosing the candidate ----------------------------------------------

test("the recorded slide is used when it is still staged", () => {
  const target = chosenTarget({ requestedSlideIndex: 3, slides });
  assert.deepEqual(target, { kind: "chosen", slide: slides[2], asked: true });
  assert.equal(describeChosenTarget(target), "reporting on slide 3");
});

test("nothing recorded is a NORMAL answer: the first candidate, and the window says that is why", () => {
  const target = chosenTarget({ requestedSlideIndex: null, slides });
  assert.deepEqual(target, { kind: "chosen", slide: slides[0], asked: false });
  assert.match(describeChosenTarget(target), /the first candidate, because no particular one was asked for/);
});

test("a recorded slide that has since gone names itself rather than silently substituting", () => {
  const target = chosenTarget({ requestedSlideIndex: 9, slides });
  assert.deepEqual(target, { kind: "substituted", slide: slides[0], requestedSlideIndex: 9 });
  assert.equal(describeChosenTarget(target), "slide 9 is no longer staged, so this is slide 1 instead");
});

test("with nothing staged the window still opens, and says what it needs", () => {
  const target = chosenTarget({ requestedSlideIndex: 2, slides: [] });
  assert.deepEqual(target, { kind: "nothing-staged" });
  const open = replay([
    {
      kind: "opened",
      defect: defectWithoutSlide({ seed: SEED, message: "no candidate slide is staged to report on." }),
    },
  ]);
  assert.match(markupOf(open), /no candidate slide is staged to report on/);
});

test("the chosen candidate's explanation travels on the label the panel shows", () => {
  const target = chosenTarget({ requestedSlideIndex: 9, slides });
  assert.equal(target.kind, "substituted");
  if (target.kind !== "substituted") return;
  const open = replay([
    {
      kind: "opened",
      defect: defectOnSlide({
        fileId: target.slide.fileId,
        label: `${target.slide.label} -- ${describeChosenTarget(target)}`,
        seed: SEED,
      }),
    },
  ]);
  assert.match(markupOf(open), /slide 9 is no longer staged, so this is slide 1 instead/);
});

function replay(events: readonly ReportSurfaceEvent[]): ReportSurface {
  let surface = INITIAL_REPORT_SURFACE;
  for (const event of events) surface = reduceReportSurface(surface, event);
  return surface;
}

/**
 * The window's three statuses, rendered the way `report.tsx` renders them. `ReportSurfacePanel` is
 * declared inside that composition root (it is four lines of shell around `DefectPanel`), so the
 * shell is reproduced here rather than imported -- importing `report.tsx` would run its `main()`.
 */
function markupOf(surface: ReportSurface): string {
  switch (surface.status) {
    case "connecting":
      return surface.what;
    case "trouble":
      return `sasha-slides: ${surface.message}`;
    case "reporting":
      return renderToStaticMarkup(
        createElement(DefectPanel, { defect: surface.defect, actions: INERT_DEFECT_ACTIONS }),
      );
    default:
      throw new Error("unreachable");
  }
}
