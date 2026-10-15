// `BuildPreview`: every build segment of one slide played in turn in a box -- the Animate tab's
// "Preview" (contracts/presenter.ts `BuildPreviewProperties`). It is `TransitionPreview`'s twin: the
// same reducer in `mode: "buildPreview"`, the same hosts and the same rules as a show (built-in
// effects in-page, an approved scripted step in the sandboxed runner, an unapproved one shown at once
// with a notice). Clicks are taken as given: a segment that waits for a click in a show starts here as
// soon as the one before it ends. With no segments, or under reduced motion (the fully built slide is
// shown), it ends at once.
//
// A new `generation` remounts the inner component, which disposes the old system (its frame and
// animations with it) and plays again from build 0; `onEnded` fires once per generation, after the
// last segment.

import { useMemo, useRef, useState, type ReactElement } from "react";
import type { BuildPreviewProperties } from "../../contracts/presenter.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { createInPageStageRegistry } from "../in-page/in-page-run-feedback.ts";
import { initialBuildPreviewState } from "../presenter-reducer.ts";
import { currentBuildOf } from "../presenter-state.ts";
import { createPresenterSystem } from "../presenter-system.ts";
import { createBrowserPresenterEnvironment, windowOf } from "./browser-environment.ts";
import { PRESENTATION_SURFACE, PRESENTER_CLASS, PRESENTER_RULES } from "./presenter-stylesheet.ts";
import { ScreenContent } from "./slide-surfaces.tsx";
import { useLatest, usePresenterSystem } from "./use-presenter-system.ts";

export function BuildPreview(properties: BuildPreviewProperties): ReactElement {
  return <BuildPreviewRun key={properties.generation} {...properties} />;
}

function BuildPreviewRun(properties: BuildPreviewProperties): ReactElement {
  const dependencies = properties.dependencies;
  const box = useRef<HTMLDivElement>(null);
  const runnerLayer = useRef<HTMLDivElement>(null);
  const stages = useMemo(createInPageStageRegistry, []);
  const onEnded = useLatest(properties.onEnded);
  const [initial] = useState(() =>
    initialBuildPreviewState({
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
      data-build={currentBuildOf(state)}
      aria-label="Build preview"
    >
      <style>{PRESENTER_RULES}</style>
      <ScreenContent state={state} dependencies={dependencies} stages={stages} box={viewport} />
      <div ref={runnerLayer} className={PRESENTER_CLASS.runnerLayer} style={{ left: 0, top: 0, width: viewport.width, height: viewport.height }} />
    </div>
  );
}
