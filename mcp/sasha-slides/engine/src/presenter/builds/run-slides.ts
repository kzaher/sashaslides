// THE TWO SLIDES A RUN DRAWS, each at its build position (contracts/presenter.ts "A SLIDE IS SHOWN
// AT A BUILD POSITION"): the outgoing slide as the audience last saw it, the incoming slide as it
// arrives. The in-page stage, the in-page host's element records and the sandbox's prepare message
// all ask here, so the three can never draw different slides for the same run.

import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { TransitionRun } from "../../contracts/presenter.ts";
import { slideById } from "../presenter-state.ts";
import { slideAtBuild } from "./build-states.ts";

/** The slide a run draws on one side, at that side's build position; null when it is gone or starting from black. */
export function slideOnSide(
  options: Readonly<{ run: TransitionRun; document: DocumentSnapshot; side: "outgoing" | "incoming" }>,
): SlideSnapshot | null {
  const run = options.run;
  switch (options.side) {
    case "outgoing": {
      const slide = run.fromSlideId === null ? null : slideById(options.document, run.fromSlideId);
      return slide === null ? null : slideAtBuild({ slide, completed: run.fromBuild });
    }
    case "incoming": {
      const slide = slideById(options.document, run.toSlideId);
      return slide === null ? null : slideAtBuild({ slide, completed: run.toBuild });
    }
    default:
      return assertNever(options.side);
  }
}
