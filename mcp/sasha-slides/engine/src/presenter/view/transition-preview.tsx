// `TransitionPreview`: the transition INTO a slide from the slide before it (deck order, skipped or
// not), played once in a box -- the properties panel's "Preview" and the script dialog's "Run"
// (contracts/presenter.ts `TransitionPreviewProperties`). Same reducer, same hosts and the same
// rules as a show: a built-in runs in-page, an approved script in the sandboxed runner, and an
// unapproved or missing script, or reduced motion, plays the host's 150 millisecond fade.
//
// A new `generation` remounts the inner component, which disposes the old system (its frame and
// animations with it) and plays again from the start; `onEnded` fires once per generation, when the
// run finishes, falls back, or there was nothing to play.

import { useMemo, useRef, useState, type ReactElement } from "react";
import type { TransitionPreviewProperties } from "../../contracts/presenter.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { createInPageStageRegistry } from "../in-page/in-page-run-feedback.ts";
import { initialPreviewState } from "../presenter-reducer.ts";
import { createPresenterSystem } from "../presenter-system.ts";
import { createBrowserPresenterEnvironment, windowOf } from "./browser-environment.ts";
import { PRESENTATION_SURFACE, PRESENTER_CLASS, PRESENTER_RULES } from "./presenter-stylesheet.ts";
import { ScreenContent } from "./slide-surfaces.tsx";
import { useLatest, usePresenterSystem } from "./use-presenter-system.ts";

export function TransitionPreview(properties: TransitionPreviewProperties): ReactElement {
  return <PreviewRun key={properties.generation} {...properties} />;
}

function PreviewRun(properties: TransitionPreviewProperties): ReactElement {
  const dependencies = properties.dependencies;
  const box = useRef<HTMLDivElement>(null);
  const runnerLayer = useRef<HTMLDivElement>(null);
  const stages = useMemo(createInPageStageRegistry, []);
  const onEnded = useLatest(properties.onEnded);
  const [initial] = useState(() =>
    initialPreviewState({
      document: properties.document,
      slideId: properties.slideId,
      idSeed: { sessionPrefix: dependencies.sessionPrefix, counter: 0 },
      now: dependencies.now(),
      reducedMotion: dependencies.prefersReducedMotion(),
    }),
  );
  const { state } = usePresenterSystem({
    initial,
    create: () =>
      createPresenterSystem({
        dependencies,
        initial,
        environment: createBrowserPresenterEnvironment({
          hostWindow: windowOf(box.current),
          runnerLayer: () => runnerLayer.current,
          stages,
          onExit: () => undefined,
          onPreviewEnded: () => onEnded.current(),
        }),
      }),
  });
  const page = state.document.pageSize;
  const scale = properties.width / page.width;
  const viewport = { left: 0, top: 0, width: properties.width, height: page.height * scale, scale };
  return (
    <div
      ref={box}
      className={`${TIDEPOOL_CLASS.root} ${PRESENTER_CLASS.preview}`}
      style={{ width: viewport.width, height: viewport.height, background: PRESENTATION_SURFACE.letterbox }}
      data-preview-ended={state.previewEnded ? "true" : "false"}
      data-run-phase={state.run?.phase ?? "none"}
      aria-label="Transition preview"
    >
      <style>{PRESENTER_RULES}</style>
      <ScreenContent state={state} dependencies={dependencies} stages={stages} box={viewport} />
      <div ref={runnerLayer} className={PRESENTER_CLASS.runnerLayer} style={{ left: 0, top: 0, width: viewport.width, height: viewport.height }} />
    </div>
  );
}
