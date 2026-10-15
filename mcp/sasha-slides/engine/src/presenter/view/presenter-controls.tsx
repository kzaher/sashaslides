// THE PRESENTER'S CONTROL BAR: previous, "n / m", next, speaker view, exit -- a Tidepool pill bar
// (ink-pill primary for the forward action, secondary pills for the rest) that fades out after 2.5
// seconds without pointer movement (the reducer's `controlsVisible`).
//
// THE SPEAKER VIEW BUTTON CANNOT OPEN A WINDOW ITSELF: popup blockers refuse `window.open` outside
// the click's own handler, and the presenter never calls it (contracts/presenter.ts). Its click
// handler calls `onRequestSpeakerView` synchronously, which reaches the caller's
// `onSpeakerViewRequested` inside the same click; the speaker view's own copy of the bar has none.

import type { ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { PresenterEvent } from "../../contracts/presenter.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { currentSlideOf, type PresenterSystemState } from "../presenter-state.ts";
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

function Chevron(properties: Readonly<{ pointing: "left" | "right" }>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={properties.pointing === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}
