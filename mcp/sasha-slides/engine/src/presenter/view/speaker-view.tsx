// THE SPEAKER VIEW: the same React tree and the same state as the audience view, rendered by portal
// into a window the CALLER opened inside its own click or key handler (the presenter never opens
// windows). It shows the slide the audience is on, the next slide, the speaker notes (read only),
// the elapsed time and the clock, "n / m", and the same controls -- all in Tidepool on the calm
// ground, since the speaker view is chrome around slides, not a slide.
//
// The other window starts empty, so the portal brings its own stylesheet (the shared Tidepool
// sheet plus the presenter's rules) into that window's head, and takes it away again on unmount.
// Slides are drawn with `PlacedSlide`, never the in-page transition stage: the stage is registered
// by run id for the audience window, and a second registration would steal the animation.
//
// The current slide is drawn at the build position the audience sees, with "build 2 of 5" beside
// its counter while it has clicks; the next slide is drawn as it will arrive, at build 0.

import { useLayoutEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { plainText } from "../../contracts/document.ts";
import type { PresenterDependencies, PresenterEvent } from "../../contracts/presenter.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { currentBuildOf, currentSlideOf, deckSlideNumber, slideById, type PresenterSystemState } from "../presenter-state.ts";
import { PresenterControls, buildCounterText, slideCounterText } from "./presenter-controls.tsx";
import { PRESENTER_CLASS, SPEAKER_VIEW_STYLE_TEXT } from "./presenter-stylesheet.ts";
import { PlacedSlide, SlideViewport } from "./slide-surfaces.tsx";

export function SpeakerViewPortal(
  properties: Readonly<{
    speakerWindow: Window;
    state: PresenterSystemState;
    dispatch: (event: PresenterEvent) => void;
    dependencies: PresenterDependencies;
  }>,
): ReactElement {
  const speakerWindow = properties.speakerWindow;
  const title = properties.state.document.title;
  useLayoutEffect(() => {
    const document = speakerWindow.document;
    const style = document.createElement("style");
    style.textContent = SPEAKER_VIEW_STYLE_TEXT;
    document.head.appendChild(style);
    const previousTitle = document.title;
    document.title = `Speaker view: ${title}`;
    return () => {
      style.remove();
      document.title = previousTitle;
    };
  }, [speakerWindow, title]);
  return createPortal(<SpeakerView {...properties} />, speakerWindow.document.body);
}

export function SpeakerView(
  properties: Readonly<{ state: PresenterSystemState; dispatch: (event: PresenterEvent) => void; dependencies: PresenterDependencies }>,
): ReactElement {
  const state = properties.state;
  const document = state.document;
  const current = currentSlideOf(state);
  const nextSlideId = state.playlist[state.playlist.indexOf(current) + 1] ?? null;
  const currentSlide = slideById(document, current);
  const notes = currentSlide === null ? "" : plainText({ body: currentSlide.speakerNotes, slideNumber: deckSlideNumber(document, current) }).trim();
  const noHandlers = { onClick: undefined, onContextMenu: undefined, style: {} };
  const buildText = buildCounterText(state);
  return (
    <div className={`${TIDEPOOL_CLASS.root} ${TIDEPOOL_CLASS.calmGround} ${PRESENTER_CLASS.speakerView}`} data-speaker-view="true">
      <header className={`${TIDEPOOL_CLASS.panel} ${PRESENTER_CLASS.speakerHeader}`}>
        <div>
          <strong>Speaker view</strong> <span className={TIDEPOOL_CLASS.muted}>{document.title}</span>
        </div>
        <div className={PRESENTER_CLASS.timers}>
          <span className={TIDEPOOL_CLASS.subtle}>Elapsed</span>
          <span className={PRESENTER_CLASS.timer} data-timer="elapsed">
            {formatElapsed(state.now - state.startedAt)}
          </span>
          <span className={TIDEPOOL_CLASS.subtle}>Clock</span>
          <span className={PRESENTER_CLASS.timer} data-timer="clock">
            {formatClock(state.now)}
          </span>
        </div>
      </header>
      <div className={PRESENTER_CLASS.speakerGrid}>
        <section className={`${TIDEPOOL_CLASS.panel} ${PRESENTER_CLASS.speakerCurrent}`} aria-label="Current slide">
          <h2 className={PRESENTER_CLASS.speakerHeading}>
            Current slide · {slideCounterText(state)}
            {buildText === null ? null : <span data-build-counter="true"> · {buildText}</span>}
          </h2>
          <div className={PRESENTER_CLASS.speakerSlideBox}>
            <SlideViewport document={document} {...noHandlers}>
              {(box) => (box === null ? null : <PlacedSlide dependencies={properties.dependencies} document={document} slideId={current} build={currentBuildOf(state)} box={box} />)}
            </SlideViewport>
          </div>
        </section>
        <div className={PRESENTER_CLASS.speakerSide}>
          <section className={TIDEPOOL_CLASS.panel} aria-label="Next slide">
            <h2 className={PRESENTER_CLASS.speakerHeading}>Next</h2>
            <div className={PRESENTER_CLASS.speakerSlideBox}>
              {nextSlideId === null ? (
                <p className={TIDEPOOL_CLASS.muted}>End of presentation</p>
              ) : (
                <SlideViewport document={document} {...noHandlers}>
                  {(box) => (box === null ? null : <PlacedSlide dependencies={properties.dependencies} document={document} slideId={nextSlideId} build={0} box={box} />)}
                </SlideViewport>
              )}
            </div>
          </section>
          <section className={TIDEPOOL_CLASS.panel} aria-label="Speaker notes">
            <h2 className={PRESENTER_CLASS.speakerHeading}>Speaker notes</h2>
            <div className={PRESENTER_CLASS.speakerNotes} data-speaker-notes="true">
              {notes === "" ? <span className={TIDEPOOL_CLASS.subtle}>No speaker notes for this slide.</span> : notes}
            </div>
          </section>
        </div>
      </div>
      <PresenterControls state={state} dispatch={properties.dispatch} visible={true} onRequestSpeakerView={null} />
    </div>
  );
}

/** "4:07", or "1:02:09" past an hour. */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}

/** The wall clock at `now` in the viewer's locale, hours and minutes. */
export function formatClock(now: number): string {
  return new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
