// THE PRESENTER'S CONTROL BAR: previous, "n / m", next, speaker view, exit -- a Tidepool pill bar
// (ink-pill primary for the forward action, secondary pills for the rest) that fades out after 2.5
// seconds without pointer movement (the reducer's `controlsVisible`).
//
// THE SPEAKER VIEW BUTTON CANNOT OPEN A WINDOW ITSELF: popup blockers refuse `window.open` outside
// the click's own handler, and the presenter never calls it (contracts/presenter.ts). Its click
// handler calls `onRequestSpeakerView` synchronously, which reaches the caller's
// `onSpeakerViewRequested` inside the same click; the speaker view's own copy of the bar has none.
//
// "BUILD 2 OF 5" sits beside the slide counter while the slide has clicks to build, so a presenter
// can tell a click that builds from a click that leaves the slide.

import type { ReactElement } from "react";
import { buildClickCount } from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { PresenterEvent } from "../../contracts/presenter.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { slideBuildSegments } from "../builds/build-states.ts";
import { currentBuildOf, currentSlideOf, slideById, type PresenterSystemState } from "../presenter-state.ts";
import { PRESENTER_CLASS } from "./presenter-stylesheet.ts";

export function PresenterControls(
  properties: Readonly<{
    state: PresenterSystemState;
    dispatch: (event: PresenterEvent) => void;
    visible: boolean;
    /** null: no speaker view button (the speaker view's own bar). */
    onRequestSpeakerView: (() => void) | null;
  }>,
): ReactElement {
  const state = properties.state;
  const dispatch = properties.dispatch;
  const buildText = buildCounterText(state);
  return (
    <div
      className={`${TIDEPOOL_CLASS.card} ${PRESENTER_CLASS.controls}`}
      data-visible={properties.visible ? "true" : "false"}
      role="toolbar"
      aria-label="Presentation controls"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label="Previous slide" onClick={() => dispatch({ kind: "navigationRequested", navigation: { kind: "previous" } })}>
        <Chevron pointing="left" />
      </button>
      <span className={PRESENTER_CLASS.slideCounter} aria-live="polite">
        {slideCounterText(state)}
      </span>
      {buildText === null ? null : <span className={`${PRESENTER_CLASS.buildCounter} ${TIDEPOOL_CLASS.subtle}`}>{buildText}</span>}
      <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label="Next slide" onClick={() => dispatch({ kind: "navigationRequested", navigation: { kind: "next" } })}>
        <Chevron pointing="right" />
      </button>
      {properties.onRequestSpeakerView === null ? null : (
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} aria-pressed={state.speakerViewOpen} onClick={properties.onRequestSpeakerView}>
          Speaker view
        </button>
      )}
      <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={() => dispatch({ kind: "exitRequested" })}>
        Exit
      </button>
    </div>
  );
}

/** "3 / 12", or "End" on the end screen. */
export function slideCounterText(state: PresenterSystemState): string {
  switch (state.screen.kind) {
    case "end":
      return `End / ${state.playlist.length}`;
    case "slide":
    case "transition":
    case "blank":
      return `${state.playlist.indexOf(currentSlideOf(state)) + 1} / ${state.playlist.length}`;
    default:
      return assertNever(state.screen);
  }
}

/** "build 2 of 5" while the current slide has clicks to build; null when it has none (or on the end screen). */
export function buildCounterText(state: PresenterSystemState): string | null {
  const clicks = buildClicksOf(state);
  return clicks === null ? null : `build ${clicks.done} of ${clicks.total}`;
}

/** The current slide's clicks done and in all; null when it has none or none is on screen. */
export function buildClicksOf(state: PresenterSystemState): Readonly<{ done: number; total: number }> | null {
  switch (state.screen.kind) {
    case "end":
      return null;
    case "slide":
    case "transition":
    case "blank":
      break;
    default:
      return assertNever(state.screen);
  }
  const slide = slideById(state.document, currentSlideOf(state));
  if (slide === null) return null;
  const clicks = buildClickCount({ segments: slideBuildSegments(slide), completed: currentBuildOf(state) });
  return clicks.total === 0 ? null : clicks;
}

function Chevron(properties: Readonly<{ pointing: "left" | "right" }>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={properties.pointing === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}
