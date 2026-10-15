// WHAT FILLS THE PRESENTER'S SCREEN, as a function of state: a slide letterboxed and scaled to fit,
// the in-page transition stage, the outgoing slide under a sandboxed run, a blank screen, or the
// end screen. Shared by the audience view, the speaker view and the transition preview, so all
// three draw a slide the same way (the injected `StaticSlide`, the same one the editor's filmstrip
// uses).
//
// THE IN-PAGE STAGE is the only place the presenter hands DOM to a transition: four elements in the
// order the authoring interface promises (incoming beneath, outgoing above it, the overlay on top),
// registered under the run's id for the in-page feedback, unregistered when the run ends. Slides on
// the stage render at scale 1 inside a stage scaled as a whole, so a transition's percentages and
// pixels are slide units, exactly as in the runner. The layers carry no z-index of their own except
// the overlay, so a transition that lifts the incoming slide with `style.zIndex = "2"` puts it on top
// (the documented ink-wipe example does exactly that).
//
// EVERY SLIDE IS DRAWN AT A BUILD POSITION (contracts/presenter.ts): the slide on screen at its
// `build`, a run's two sides at `fromBuild` and `toBuild` (builds/run-slides.ts), so a build segment
// and a transition out of a built slide draw what the audience last saw.

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot } from "../../contracts/document.ts";
import type { AssetId, SlideId } from "../../contracts/ids.ts";
import type { PresenterDependencies, TransitionRun } from "../../contracts/presenter.ts";
import type { AssetAddressResolver } from "../../contracts/render.ts";
import type { InPageStageRegistry } from "../in-page/in-page-run-feedback.ts";
import { slideAtBuild } from "../builds/build-states.ts";
import { slideOnSide } from "../builds/run-slides.ts";
import { hostRunnerId } from "../presenter-queries.ts";
import { deckSlideNumber, slideById, type PresenterSystemState } from "../presenter-state.ts";
import { EndScreen } from "./end-screen.tsx";
import { PRESENTATION_SURFACE, PRESENTER_CLASS } from "./presenter-stylesheet.ts";

/** Where the slide sits inside a viewport, in client pixels, and its scale. */
export type ViewportBox = Readonly<{ left: number; top: number; width: number; height: number; scale: number }>;

export function fitSlide(options: Readonly<{ width: number; height: number; pageHeight: number; slideWidth: number }>): ViewportBox {
  const scale = Math.max(0, Math.min(options.width / options.slideWidth, options.height / options.pageHeight));
  const width = options.slideWidth * scale;
  const height = options.pageHeight * scale;
  return { left: (options.width - width) / 2, top: (options.height - height) / 2, width, height, scale };
}

/** Measures itself and hands its children the letterboxed slide box. */
export function SlideViewport(
  properties: Readonly<{
    document: DocumentSnapshot;
    style: CSSProperties;
    onClick: MouseEventHandler<HTMLDivElement> | undefined;
    onContextMenu: MouseEventHandler<HTMLDivElement> | undefined;
    /** Called with null until the viewport has been measured. */
    children: (box: ViewportBox | null) => ReactNode;
  }>,
): ReactElement {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Readonly<{ width: number; height: number }> | null>(null);
  useLayoutEffect(() => {
    const viewport = element.current;
    if (viewport === null) return undefined;
    const measure = (): void => setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    // The observer of the viewport's own window: a speaker view lives in another window.
    const Observer = viewport.ownerDocument.defaultView?.ResizeObserver;
    if (Observer === undefined) return undefined;
    const observer = new Observer(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  const page = properties.document.pageSize;
  return (
    <div ref={element} className={PRESENTER_CLASS.viewport} style={properties.style} onClick={properties.onClick} onContextMenu={properties.onContextMenu}>
      {properties.children(size === null || size.width === 0 ? null : fitSlide({ width: size.width, height: size.height, pageHeight: page.height, slideWidth: page.width }))}
    </div>
  );
}

/** One slide at a build position, scaled into `box`. */
export function PlacedSlide(
  properties: Readonly<{ dependencies: PresenterDependencies; document: DocumentSnapshot; slideId: SlideId; build: number; box: ViewportBox }>,
): ReactElement | null {
  const assetAddress = useAssetAddress(properties.dependencies);
  const stored = slideById(properties.document, properties.slideId);
  if (stored === null) return null;
  const slide = slideAtBuild({ slide: stored, completed: properties.build });
  const StaticSlide = properties.dependencies.StaticSlide;
  return (
    <div className={PRESENTER_CLASS.placedSlide} style={boxStyle(properties.box)} data-slide-id={slide.id} data-build={properties.build}>
      <StaticSlide slide={slide} document={properties.document} slideNumber={deckSlideNumber(properties.document, slide.id)} scale={properties.box.scale} assetAddress={assetAddress} />
    </div>
  );
}

/** Whatever the screen shows right now (see the header). */
export function ScreenContent(
  properties: Readonly<{ state: PresenterSystemState; dependencies: PresenterDependencies; stages: InPageStageRegistry; box: ViewportBox }>,
): ReactElement | null {
  const screen = properties.state.screen;
  const common = { dependencies: properties.dependencies, document: properties.state.document, box: properties.box };
  switch (screen.kind) {
    case "slide":
      return <PlacedSlide {...common} slideId={screen.slideId} build={screen.build} />;
    case "transition": {
      const run = properties.state.run;
      if (run === null) return <PlacedSlide {...common} slideId={screen.toSlideId} build={0} />;
      if (hostRunnerId(run.host) === null) return <InPageStage {...common} run={run} stages={properties.stages} />;
      // A sandboxed run: the outgoing slide stays until the runner's frame shows (SPEC.md section 11).
      return run.fromSlideId === null ? null : <PlacedSlide {...common} slideId={run.fromSlideId} build={run.fromBuild} />;
    }
    case "blank":
      return <div className={PRESENTER_CLASS.blank} style={{ background: BLANK_COLOURS[screen.colour] }} aria-label={`${screen.colour} screen`} />;
    case "end":
      return <EndScreen />;
    default:
      return assertNever(screen);
  }
}

const BLANK_COLOURS: Readonly<Record<"black" | "white", string>> = {
  black: PRESENTATION_SURFACE.blankBlack,
  white: PRESENTATION_SURFACE.blankWhite,
};

function InPageStage(
  properties: Readonly<{ dependencies: PresenterDependencies; document: DocumentSnapshot; run: TransitionRun; box: ViewportBox; stages: InPageStageRegistry }>,
): ReactElement {
  const stage = useRef<HTMLDivElement>(null);
  const outgoing = useRef<HTMLDivElement>(null);
  const incoming = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const assetAddress = useAssetAddress(properties.dependencies);
  const runId = properties.run.runId;
  const stages = properties.stages;
  useLayoutEffect(() => {
    if (stage.current === null || incoming.current === null || overlay.current === null) return undefined;
    const registration = stages.register(runId, { stage: stage.current, outgoing: outgoing.current, incoming: incoming.current, overlay: overlay.current });
    return () => registration[Symbol.dispose]();
  }, [runId, stages]);
  const document = properties.document;
  const page = document.pageSize;
  const layerStyle: CSSProperties = { width: page.width, height: page.height };
  const StaticSlide = properties.dependencies.StaticSlide;
  const slideOf = (side: "outgoing" | "incoming"): ReactElement | null => {
    const slide = slideOnSide({ run: properties.run, document, side });
    return slide === null ? null : <StaticSlide slide={slide} document={document} slideNumber={deckSlideNumber(document, slide.id)} scale={1} assetAddress={assetAddress} />;
  };
  return (
    <div className={PRESENTER_CLASS.placedSlide} style={boxStyle(properties.box)} data-run-id={runId}>
      <div ref={stage} className={PRESENTER_CLASS.stage} style={{ ...layerStyle, transform: `scale(${properties.box.scale})` }}>
        <div ref={incoming} className={PRESENTER_CLASS.stageLayer} style={layerStyle}>
          {slideOf("incoming")}
        </div>
        {properties.run.fromSlideId === null ? null : (
          <div ref={outgoing} className={PRESENTER_CLASS.stageLayer} style={layerStyle}>
            {slideOf("outgoing")}
          </div>
        )}
        <div ref={overlay} className={PRESENTER_CLASS.stageLayer} style={{ ...layerStyle, zIndex: 3, pointerEvents: "none" }} />
      </div>
    </div>
  );
}

function useAssetAddress(dependencies: PresenterDependencies): AssetAddressResolver {
  const assetStore = dependencies.assetStore;
  return useCallback((assetId: AssetId) => assetStore.addressFor(assetId), [assetStore]);
}

function boxStyle(box: ViewportBox): CSSProperties {
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}
