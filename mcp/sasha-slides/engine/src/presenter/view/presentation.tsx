// `Presentation`: the slideshow, full screen on black, with the Tidepool control bar and, when the
// caller opened one, the speaker view in a second window (contracts/presenter.ts
// `PresentationProperties`).
//
// The component is a passive view of the presenter system (presenter-system.ts) plus the page
// boundary: it turns keys, clicks and pointer movement into events, re-sends the document when
// the caller's changes, and hosts the two things effects need a place for -- the in-page transition
// stage and the runner layer the sandbox puts its frames in.
//
// Decisions:
//
//  * IT NEVER CALLS `requestFullscreen` OR `window.open`. Both must happen synchronously in a click
//    or key handler; the presenter receives the result (contracts/presenter.ts). S and the speaker
//    view button call the caller's `onSpeakerViewRequested` synchronously in their own handler and
//    adopt the window it returns (navigation-keys.ts, presenter-controls.tsx).
//  * KEYS ARE HEARD IN BOTH WINDOWS, so the speaker can drive the show from the speaker view.
//  * OBSERVABLE STATE IS ON THE ROOT as data attributes (screen, run phase, the latest fallback,
//    the rejected message count), for end-to-end drivers and the editor's diagnostics, never as a
//    second copy of state.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { PresentationProperties, PresenterEvent } from "../../contracts/presenter.ts";
import type { KeyChord } from "../../contracts/editor-events.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { createInPageStageRegistry } from "../in-page/in-page-run-feedback.ts";
import { presenterKeyIntent, type PresenterKeyIntent } from "../navigation-keys.ts";
import { currentSlideOf, initialShowState, type PresenterSystemState } from "../presenter-state.ts";
import { isBlankScreen } from "../presenter-queries.ts";
import { createPresenterSystem } from "../presenter-system.ts";
import { createBrowserPresenterEnvironment, windowOf } from "./browser-environment.ts";
import { PresenterControls } from "./presenter-controls.tsx";
import { PRESENTATION_SURFACE, PRESENTER_CLASS, PRESENTER_RULES } from "./presenter-stylesheet.ts";
import { ScreenContent, SlideViewport } from "./slide-surfaces.tsx";
import { SpeakerViewPortal } from "./speaker-view.tsx";
import { usePresenterSystem, useLatest } from "./use-presenter-system.ts";

export function Presentation(properties: PresentationProperties): ReactElement {
  const dependencies = properties.dependencies;
  const root = useRef<HTMLDivElement>(null);
  const runnerLayer = useRef<HTMLDivElement>(null);
  const stages = useMemo(createInPageStageRegistry, []);
  const onExit = useLatest(properties.onExit);
  const [initial] = useState(() =>
    initialShowState({
      document: properties.document,
      startSlideId: properties.startSlideId,
      idSeed: { sessionPrefix: dependencies.sessionPrefix, counter: 0 },
      now: dependencies.now(),
      reducedMotion: dependencies.prefersReducedMotion(),
    }),
  );
  const { state, dispatch } = usePresenterSystem({
    initial,
    create: () =>
      createPresenterSystem({
        dependencies,
        initial,
        environment: createBrowserPresenterEnvironment({
          hostWindow: windowOf(root.current),
          runnerLayer: () => runnerLayer.current,
          stages,
          onExit: (lastSlideId) => onExit.current(lastSlideId),
          onPreviewEnded: () => undefined,
        }),
      }),
  });
  useDocumentUpdates({ document: properties.document, dispatch });
  const [requested, setRequested] = useState<Readonly<{ window: Window }> | null>(null);
  const speakerWindow = useOpenSpeakerWindow({ speakerWindow: requested?.window ?? properties.speakerWindow, dispatch });
  const onSpeakerViewRequested = useLatest(properties.onSpeakerViewRequested);
  // Runs inside the click or key handler that asked, so the caller may open a window (see the header).
  const requestSpeakerView = useCallback((): void => {
    if (speakerWindow !== null && !speakerWindow.closed) {
      speakerWindow.focus();
      return;
    }
    const opened = onSpeakerViewRequested.current();
    if (opened === null) {
      dispatch({ kind: "speakerViewChanged", open: false });
      return;
    }
    // A new object on every request, so a window object that is handed out again still re-subscribes.
    setRequested({ window: opened });
  }, [speakerWindow, onSpeakerViewRequested, dispatch]);
  usePresenterKeys({ root, speakerWindow, dispatch, state, requestSpeakerView });
  const lastFallback = [...state.diagnostics].reverse().find((diagnostic) => diagnostic.kind === "fallback");
  return (
    <div
      ref={root}
      className={`${TIDEPOOL_CLASS.root} ${PRESENTER_CLASS.presentation}`}
      style={{ background: PRESENTATION_SURFACE.letterbox }}
      data-screen={state.screen.kind}
      data-slide-id={currentSlideOf(state)}
      data-run-phase={state.run?.phase ?? "none"}
      data-run-host={state.run?.host.kind ?? "none"}
      data-last-fallback={lastFallback?.reason ?? ""}
      data-rejected-messages={state.rejectedMessageCount}
      data-controls-visible={state.controlsVisible ? "true" : "false"}
      onPointerMove={() => dispatch({ kind: "pointerActivity" })}
    >
      <style>{PRESENTER_RULES}</style>
      <SlideViewport
        document={state.document}
        style={{}}
        onClick={() => dispatch({ kind: "stageClicked", button: "primary" })}
        onContextMenu={(event) => {
          event.preventDefault();
          dispatch({ kind: "stageClicked", button: "secondary" });
        }}
      >
        {(box) => (
          <>
            {box === null ? null : <ScreenContent state={state} dependencies={dependencies} stages={stages} box={box} />}
            {/* Always present, so runner frames created before the first measurement land here too. */}
            <div ref={runnerLayer} className={PRESENTER_CLASS.runnerLayer} style={box === null ? { inset: 0 } : { left: box.left, top: box.top, width: box.width, height: box.height }} />
          </>
        )}
      </SlideViewport>
      <PresenterControls state={state} dispatch={dispatch} visible={state.controlsVisible} onRequestSpeakerView={requestSpeakerView} />
      {speakerWindow === null || !state.speakerViewOpen ? null : (
        <SpeakerViewPortal speakerWindow={speakerWindow} state={state} dispatch={dispatch} dependencies={dependencies} />
      )}
    </div>
  );
}

/** The caller's newer document replaces the presenter's (the reducer recomputes the playlist). */
function useDocumentUpdates(options: Readonly<{ document: PresentationProperties["document"]; dispatch: (event: PresenterEvent) => void }>): void {
  const first = useRef(options.document);
  const { document, dispatch } = options;
  useEffect(() => {
    if (document === first.current) return;
    dispatch({ kind: "documentChanged", document });
  }, [document, dispatch]);
}

/** The window the caller opened, while it stays open; `speakerViewChanged` follows it. */
function useOpenSpeakerWindow(options: Readonly<{ speakerWindow: Window | null; dispatch: (event: PresenterEvent) => void }>): Window | null {
  const { speakerWindow, dispatch } = options;
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setClosed(false);
    if (speakerWindow === null || speakerWindow.closed) {
      dispatch({ kind: "speakerViewChanged", open: false });
      return undefined;
    }
    dispatch({ kind: "speakerViewChanged", open: true });
    const onClosed = (): void => {
      setClosed(true);
      dispatch({ kind: "speakerViewChanged", open: false });
    };
    speakerWindow.addEventListener("pagehide", onClosed);
    return () => speakerWindow.removeEventListener("pagehide", onClosed);
  }, [speakerWindow, dispatch]);
  return closed ? null : speakerWindow;
}

/** Keys from the audience window and the speaker window (see the header). */
function usePresenterKeys(
  options: Readonly<{
    root: Readonly<{ current: HTMLDivElement | null }>;
    speakerWindow: Window | null;
    dispatch: (event: PresenterEvent) => void;
    state: PresenterSystemState;
    requestSpeakerView: () => void;
  }>,
): void {
  const state = useLatest(options.state);
  const requestSpeakerView = useLatest(options.requestSpeakerView);
  const { root, speakerWindow, dispatch } = options;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const chord: KeyChord = { key: event.key, code: event.code, modifiers: { shift: event.shiftKey, alt: event.altKey, primary: event.ctrlKey || event.metaKey } };
      const intent = presenterKeyIntent(chord);
      if (opensSpeakerView(intent)) {
        event.preventDefault();
        requestSpeakerView.current();
        return;
      }
      const blank = isBlankScreen(state.current.screen);
      if (!blank && !isPresenterKey(intent)) return;
      event.preventDefault();
      dispatch({ kind: "keyPressed", chord });
    };
    const windows = [windowOf(root.current), ...(speakerWindow === null ? [] : [speakerWindow])];
    for (const target of windows) target.addEventListener("keydown", onKeyDown);
    return () => {
      for (const target of windows) target.removeEventListener("keydown", onKeyDown);
    };
  }, [root, speakerWindow, dispatch, state, requestSpeakerView]);
}

function opensSpeakerView(intent: PresenterKeyIntent): boolean {
  switch (intent.kind) {
    case "speakerView":
      return true;
    case "navigate":
    case "enter":
    case "typeDigit":
    case "blank":
    case "exit":
    case "notHandled":
      return false;
    default:
      return assertNever(intent);
  }
}

function isPresenterKey(intent: PresenterKeyIntent): boolean {
  switch (intent.kind) {
    case "navigate":
    case "enter":
    case "typeDigit":
    case "blank":
    case "exit":
    case "speakerView":
      return true;
    case "notHandled":
      return false;
    default:
      return assertNever(intent);
  }
}
