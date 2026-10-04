// ONE CANDIDATE'S PICTURE, plus whatever the current TOOL puts on top of it. The grid's cells and
// the single-slide pane are the same component at two sizes -- which is the point of
// UI-CONTRACT.md's "The popup IS the editor": there is one place you work on slides, and the grid
// and the single view are two zoom levels of it rather than two screens with different powers.
//
// WHAT IS DECIDED HERE AND WHAT IS NOT. The tool decides what goes over the picture:
//
//   annotate -> `RegionOverlay`, the shared drag-a-box gesture (region-overlay.tsx)
//   edit     -> `RegionMarks`, the same boxes with NO pointer handlers, so the visual editor's own
//               chrome gets the pointer instead
//
// Neither decision depends on the zoom level, and that is enforced by the props: this component is
// never told which view it is in. It takes `tool` and a size class, and nothing else.
//
// THE EDITABLE FRAME IS OPT-IN, PER STAGE. `onEditFrame` is non-null for exactly one stage at a
// time -- the selected candidate, while the edit tool is live and the HTML pane is showing -- and
// only that stage's iframe is granted `sandbox="allow-same-origin"`. Every other stage stays in the
// strictest box, which is what the sandbox rules in UI-CONTRACT.md ask for: staged HTML of unknown
// provenance inside the user's logged-in Google session gets `allow-same-origin` only where
// something actually has to reach into it, and never `allow-scripts`.

import type { JSX } from "react";
import { assertNever, type Region } from "./protocol.ts";
import { RegionMarks, RegionOverlay, percentBox, type RegionMark } from "./region-overlay.tsx";
import { ScaledHtmlFrame } from "./scaled-frame.tsx";
import { previewElementsOf, type PreviewElement } from "./rendered-preview.ts";
import {
  converterFindingsOf,
  drawsRegions,
  type DraftAnomaly,
  type SlideFrame,
  type SlideRendering,
  type SlideTool,
} from "./picker-state.ts";

export function SlideStage({
  frame,
  rendering,
  tool,
  disabled,
  onEditFrame,
  onDraw,
}: {
  frame: SlideFrame;
  rendering: SlideRendering;
  tool: SlideTool;
  disabled: boolean;
  /**
   * The iframe element, for the visual editor to attach to -- null for every stage that is not the
   * one being edited. UI-CONTRACT.md: "The host supplies the iframe and decides when to persist."
   */
  onEditFrame: ((element: HTMLIFrameElement | null) => void) | null;
  onDraw: (spec: Readonly<{ index: number; region: Region }>) => void;
}): JSX.Element {
  return (
    <>
      <StageBody frame={frame} rendering={rendering} onEditFrame={onEditFrame} />
      <StageTool frame={frame} tool={tool} disabled={disabled} onDraw={onDraw} />
    </>
  );
}

/**
 * The marks a stage draws: what the CONVERTER flagged, then what the USER drew. One mapping,
 * used at both zoom levels.
 *
 * Both are drawn, but only the user's are rows in the mark-up list -- the converter's findings
 * are sent under the hood (`converterFindingsOf`). The user's boxes come LAST so they paint
 * over the machine's and their own mark is never the one that is hidden.
 */
export function marksOf({
  index,
  anomalies,
  conversion,
}: {
  index: number;
  anomalies: readonly DraftAnomaly[];
  conversion: SlideFrame["conversion"];
}): readonly RegionMark[] {
  const fromConverter = converterFindingsOf({ index, conversion }).map((finding) => ({
    markId: finding.findingId,
    region: finding.region,
    tone: "converter" as const,
  }));
  const fromUser = anomalies.map((anomaly) => ({
    markId: anomaly.anomalyId,
    region: anomaly.region,
    tone: anomaly.source,
  }));
  return [...fromConverter, ...fromUser];
}

/**
 * The picture itself. The rendering toggle is the window's ONE choice rather than per stage, so the
 * grid is either N documents or N converted projections -- comparing one candidate's HTML against
 * another's conversion would compare two different kinds of thing (UI-CONTRACT.md).
 */
function StageBody({
  frame,
  rendering,
  onEditFrame,
}: {
  frame: SlideFrame;
  rendering: SlideRendering;
  onEditFrame: ((element: HTMLIFrameElement | null) => void) | null;
}): JSX.Element {
  switch (rendering) {
    case "html":
      return <StageHtml frame={frame} onEditFrame={onEditFrame} />;
    case "rendered":
      return <StageRendered frame={frame} />;
    default:
      return assertNever(rendering);
  }
}

function StageHtml({
  frame,
  onEditFrame,
}: {
  frame: SlideFrame;
  onEditFrame: ((element: HTMLIFrameElement | null) => void) | null;
}): JSX.Element {
  switch (frame.html.kind) {
    case "unrequested":
    case "loading":
      return <span className="sasha-dim sasha-placeholder">loading {frame.name}...</span>;
    case "failed":
      return <span className="sasha-trouble sasha-placeholder">{frame.html.message}</span>;
    case "loaded":
      // Two call sites rather than `onFrame={onEditFrame ?? undefined}`: `exactOptionalPropertyTypes`
      // makes an explicit `undefined` a different thing from an absent prop, and the whole point of
      // the split is that only the edited stage asks for `allow-same-origin`.
      //
      // THE KEYS ARE LOAD-BEARING. Without them React reconciles the two branches as the SAME
      // `ScaledHtmlFrame` instance -- same type, same position -- so the iframe element survives the
      // switch. Two things then go wrong: `sandbox` is only honoured at load, so a frame that was
      // editable keeps its same-origin access after it stops being the edited one; and the host's
      // `onFrame` is never called with null, so the picker's state keeps pointing at the PREVIOUS
      // candidate's iframe and the editor attaches to the wrong slide. Distinct keys force an
      // unmount, which fires the old ref with null and loads the new frame under the right sandbox.
      return onEditFrame === null ? (
        <ScaledHtmlFrame key="inert" html={frame.html.html} title={`candidate ${frame.index} as HTML`} />
      ) : (
        <ScaledHtmlFrame
          key="editable"
          html={frame.html.html}
          title={`candidate ${frame.index} as HTML, open in the editor`}
          onFrame={onEditFrame}
          editable
        />
      );
    default:
      return assertNever(frame.html);
  }
}

/** The lossy projection: the geometry the converter asked Slides for. See rendered-preview.ts. */
function StageRendered({ frame }: { frame: SlideFrame }): JSX.Element {
  switch (frame.conversion.kind) {
    case "unconverted":
      return <span className="sasha-dim sasha-placeholder">converting...</span>;
    case "failed":
      return <span className="sasha-trouble sasha-placeholder">conversion failed: {frame.conversion.message}</span>;
    case "converted":
      return (
        <span className="sasha-rendered" aria-label={`candidate ${frame.index} as Slides elements`}>
          {previewElementsOf(frame.conversion.requests).map((element, position) => (
            <StagePreviewBox key={`${element.objectId}_${position}`} element={element} />
          ))}
        </span>
      );
    default:
      return assertNever(frame.conversion);
  }
}

function StagePreviewBox({ element }: { element: PreviewElement }): JSX.Element {
  return (
    <span className={`sasha-el sasha-el-${element.kind}`} style={percentBox(element.region)} title={element.label}>
      <span className="sasha-el-text">{element.text}</span>
    </span>
  );
}

/**
 * WHAT THE TOOL PUTS OVER THE PICTURE, and the one place the two tools differ visually. The drag
 * surface is granted ONLY to `annotate`: the editor draws its own chrome over the frame and a
 * transparent overlay above it would swallow every one of its pointer events.
 */
function StageTool({
  frame,
  tool,
  disabled,
  onDraw,
}: {
  frame: SlideFrame;
  tool: SlideTool;
  disabled: boolean;
  onDraw: (spec: Readonly<{ index: number; region: Region }>) => void;
}): JSX.Element {
  const marks = marksOf({ index: frame.index, anomalies: frame.anomalies, conversion: frame.conversion });
  if (!drawsRegions(tool)) return <RegionMarks marks={marks} />;
  return (
    <RegionOverlay
      marks={marks}
      disabled={disabled}
      label={`drag a box on candidate ${frame.index} to mark what is wrong`}
      onRegion={({ region }) => onDraw({ index: frame.index, region })}
    />
  );
}
