// THE DEFECT-REPORT WINDOW'S OUTER STATE: three statuses around `Defect` (defect-state.ts), the
// same way `PickerState` used to wrap it.
//
// WHY IT IS A WINDOW OF ITS OWN NOW. It was a fourth mode of the slides window. The anonymiser
// (`src/anonymise/`, ~47 KB of bundled JavaScript) plus `Defect.tsx` plus `report-endpoint.ts` are
// the heaviest code in the product, and the slides window has a HARD CEILING: this repo has
// recorded HtmlService corrupting a ~560 KB inlined blob with "Uncaught SyntaxError: Invalid or
// unexpected token", and the bundle cannot be base64'd because the sandbox's content-security
// policy forbids `unsafe-eval`. Splitting the report out is what brings that bundle back under the
// size HtmlService relays intact -- the same reasoning that took the sidebar from 439 KB to 256 KB.
//
// It is also the right shape for the surface: "before and after, run by run, side by side" is a
// three-column table that wants a wide window, and it does not want the grid above it.
//
// WHICH CANDIDATE IT OPENS ON comes through the SERVER, because the documents share nothing: the
// caller records the target with `sashaOpenDefectReport` and this window reads it once with
// `sashaTakeReportTarget`. Nothing was recorded is a NORMAL answer -- `chosenTarget` then picks the
// first candidate of the newest staged proposal and says so.

import { reduceDefect, type Defect, type DefectEvent } from "./defect-state.ts";
import type { SlideEntry } from "./protocol.ts";
import { assertNever } from "./protocol.ts";

export type ReportSurface =
  /** `sashaHello` has not answered yet, or the candidates are still being found. */
  | Readonly<{ status: "connecting"; what: string }>
  | Readonly<{ status: "trouble"; message: string }>
  | Readonly<{ status: "reporting"; defect: Defect }>;

export type ReportSurfaceEvent =
  | Readonly<{ kind: "progress"; what: string }>
  | Readonly<{ kind: "trouble"; message: string }>
  /**
   * The flow is ready. The `Defect` is built by the composition root because it owns the randomness
   * -- the anonymiser's seed must be fresh per report and is never generated in a reducer -- and
   * because it is what knows which candidate was chosen.
   */
  | Readonly<{ kind: "opened"; defect: Defect }>
  /** Everything that happens INSIDE the report flow, wrapped. One case instead of twenty. */
  | Readonly<{ kind: "defect"; event: DefectEvent }>;

export const INITIAL_REPORT_SURFACE: ReportSurface = {
  status: "connecting",
  what: "connecting to Google Slides...",
};

export function reduceReportSurface(surface: ReportSurface, event: ReportSurfaceEvent): ReportSurface {
  switch (event.kind) {
    case "progress":
      // A flow already open outranks a progress line: the window polls nothing, so the only way
      // this arrives late is a straggling start-up step, and it must not blank the table.
      return surface.status === "reporting" ? surface : { status: "connecting", what: event.what };

    case "trouble":
      // Same rule, and for a stronger reason: the report flow has its own visible failure states
      // for everything it does, and replacing an open table with a banner would throw away the
      // user's edits.
      return surface.status === "reporting" ? surface : { status: "trouble", message: event.message };

    case "opened":
      // Idempotent in the sense that matters: re-opening while already reporting keeps the flow the
      // user is in, so a second start-up path cannot discard their edits.
      return surface.status === "reporting" ? surface : { status: "reporting", defect: event.defect };

    case "defect": {
      const defect = defectOf(surface);
      if (defect === null || surface.status !== "reporting") return surface;
      const next = reduceDefect(defect, event.event);
      return next === defect ? surface : { ...surface, defect: next };
    }

    default:
      return assertNever(event);
  }
}

/** The report flow's state, or null while the window is still finding its candidate. */
export function defectOf(surface: ReportSurface): Defect | null {
  switch (surface.status) {
    case "reporting":
      return surface.defect;
    case "connecting":
    case "trouble":
      return null;
    default:
      return assertNever(surface);
  }
}

/**
 * WHICH CANDIDATE TO REPORT ON, out of what the server recorded and what is actually staged.
 *
 * The recorded target is a HINT, not an instruction: it was written by another document that has
 * since been closed, and the proposal may have been answered or cleared in between. So it is
 * checked against the candidates that are really there, and every way of not finding one is a
 * named outcome rather than a silent fallback -- the window has to be able to say WHY it is
 * showing slide 1 when the user pressed the button on slide 3.
 */
export function chosenTarget({
  requestedSlideIndex,
  slides,
}: {
  requestedSlideIndex: number | null;
  slides: readonly SlideEntry[];
}): ChosenTarget {
  const first = slides[0];
  if (first === undefined) return { kind: "nothing-staged" };
  if (requestedSlideIndex === null) return { kind: "chosen", slide: first, asked: false };
  const asked = slides.find((slide) => slide.index === requestedSlideIndex);
  if (asked !== undefined) return { kind: "chosen", slide: asked, asked: true };
  return { kind: "substituted", slide: first, requestedSlideIndex };
}

export type ChosenTarget =
  /** `asked` false means nothing was recorded, so this is the window's own choice. */
  | Readonly<{ kind: "chosen"; slide: SlideEntry; asked: boolean }>
  /** The recorded slide is not in the staged set any more. Say which, and go on with the first. */
  | Readonly<{ kind: "substituted"; slide: SlideEntry; requestedSlideIndex: number }>
  | Readonly<{ kind: "nothing-staged" }>;

/** What the window says about the candidate it landed on. Exhaustive, so every arm is explained. */
export function describeChosenTarget(target: ChosenTarget): string {
  switch (target.kind) {
    case "chosen":
      return target.asked
        ? `reporting on slide ${target.slide.index}`
        : `reporting on slide ${target.slide.index} -- the first candidate, because no particular one was asked for`;
    case "substituted":
      return (
        `slide ${target.requestedSlideIndex} is no longer staged, so this is slide ${target.slide.index} ` +
        "instead"
      );
    case "nothing-staged":
      return "nothing is staged to report on";
    default:
      return assertNever(target);
  }
}
