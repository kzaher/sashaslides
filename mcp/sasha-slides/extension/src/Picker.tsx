// The picker UI. Pure React: every component is a function of PickerState plus the callbacks
// content.ts hands it, and the only conditional rendering is an exhaustive switch over a
// discriminated union. No component fetches, decides or mutates anything -- the reducer in
// picker-state.ts owns all of that, and the feedback loops in content.ts own the side effects.

import { useCallback, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { PICKER_CSS } from "./picker-styles.ts";
import { assertNever, type Region } from "./protocol.ts";
import { previewElementsOf, type PreviewElement } from "./rendered-preview.ts";
import {
  anomaliesOf,
  selectedFrame,
  type DraftAnomaly,
  type Offer,
  type PickerState,
  type SlideFrame,
  type SlideView,
  type SubmitStage,
} from "./picker-state.ts";

/** Everything the UI is allowed to cause. Injected, so the tree renders in a test with no ports. */
export type PickerActions = Readonly<{
  selectSlide(index: number): void;
  chooseView(view: SlideView): void;
  drawAnomaly(spec: Readonly<{ index: number; region: Region }>): void;
  noteAnomaly(spec: Readonly<{ index: number; anomalyId: string; note: string }>): void;
  removeAnomaly(spec: Readonly<{ index: number; anomalyId: string }>): void;
  insertPicked(index: number): void;
  dismiss(): void;
}>;

export function Picker({ state, actions }: { state: PickerState; actions: PickerActions }): JSX.Element | null {
  switch (state.status) {
    case "dormant":
      // Renders nothing at all: an idle picker must not cover Google Slides' own UI.
      return null;
    case "trouble":
      return (
        <Shell>
          <p className="sasha-trouble">sasha-slides: {state.message}</p>
        </Shell>
      );
    case "settled":
      return (
        <Shell>
          <p className="sasha-settled">
            {state.picked === null
              ? `Dismissed ${state.proposalId}. Claude has been told nothing was chosen.`
              : `Inserted option ${state.picked}. Claude has been told.`}
          </p>
        </Shell>
      );
    case "picking":
      return (
        <Shell>
          <PickerDialog offer={state.offer} stage={null} actions={actions} />
        </Shell>
      );
    case "submitting":
      return (
        <Shell>
          <PickerDialog offer={state.offer} stage={state.stage} actions={actions} />
        </Shell>
      );
    default:
      return assertNever(state);
  }
}

export function PickerDialog({
  offer,
  stage,
  actions,
}: {
  offer: Offer;
  stage: SubmitStage | null;
  actions: PickerActions;
}): JSX.Element {
  const frame = selectedFrame(offer);
  const busy = stage !== null;
  return (
    <section className="sasha-dialog" role="dialog" aria-label="sasha-slides candidate slides">
      <DialogHeader offer={offer} stage={stage} />
      <SlideChips offer={offer} disabled={busy} onSelect={actions.selectSlide} />
      <ViewToggle view={offer.view} disabled={busy} onChoose={actions.chooseView} />
      {frame === null ? (
        <p className="sasha-trouble">option {offer.selectedIndex} is missing from the manifest</p>
      ) : (
        <SlidePane frame={frame} view={offer.view} disabled={busy} actions={actions} />
      )}
      {frame === null ? null : <AnomalyList frame={frame} disabled={busy} actions={actions} />}
      <DialogActions offer={offer} stage={stage} actions={actions} />
    </section>
  );
}

function DialogHeader({ offer, stage }: { offer: Offer; stage: SubmitStage | null }): JSX.Element {
  return (
    <header className="sasha-header">
      <strong>
        {offer.proposal.count} candidate slide{offer.proposal.count === 1 ? "" : "s"}
      </strong>
      <span className="sasha-dim">{offer.proposal.proposalId}</span>
      {stage === null ? null : <span className="sasha-busy">{STAGE_LABEL[stage]}</span>}
      {offer.lastFailure === null ? null : <span className="sasha-trouble">{offer.lastFailure}</span>}
      {offer.presentationId === null ? (
        <span className="sasha-trouble">this tab is not an editable presentation -- insert is unavailable</span>
      ) : null}
    </header>
  );
}

/** 1-based chips. The number on the chip is the number in PICK and the number the user says out loud. */
function SlideChips({
  offer,
  disabled,
  onSelect,
}: {
  offer: Offer;
  disabled: boolean;
  onSelect: (index: number) => void;
}): JSX.Element {
  return (
    <nav className="sasha-chips" aria-label="candidate slides">
      {offer.slides.map((frame) => (
        <button
          key={frame.index}
          type="button"
          disabled={disabled}
          aria-pressed={frame.index === offer.selectedIndex}
          className={frame.index === offer.selectedIndex ? "sasha-chip sasha-chip-on" : "sasha-chip"}
          onClick={() => onSelect(frame.index)}
        >
          <span className="sasha-chip-number">{frame.index}</span>
          <span className="sasha-chip-label">{frame.label === "" ? frame.name : frame.label}</span>
          {frame.anomalies.length === 0 ? null : (
            <span className="sasha-chip-flag">{frame.anomalies.length}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

function ViewToggle({
  view,
  disabled,
  onChoose,
}: {
  view: SlideView;
  disabled: boolean;
  onChoose: (view: SlideView) => void;
}): JSX.Element {
  return (
    <div className="sasha-toggle" role="group" aria-label="preview source">
      {VIEW_ORDER.map((candidate) => (
        <button
          key={candidate}
          type="button"
          disabled={disabled}
          aria-pressed={candidate === view}
          className={candidate === view ? "sasha-tab sasha-tab-on" : "sasha-tab"}
          onClick={() => onChoose(candidate)}
        >
          {VIEW_LABEL[candidate]}
        </button>
      ))}
    </div>
  );
}

function SlidePane({
  frame,
  view,
  disabled,
  actions,
}: {
  frame: SlideFrame;
  view: SlideView;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  return (
    <div className="sasha-pane">
      <div className="sasha-stage">
        {view === "html" ? <HtmlPane frame={frame} /> : <RenderedPane frame={frame} />}
        <AnomalyOverlay frame={frame} disabled={disabled} actions={actions} />
      </div>
    </div>
  );
}

/**
 * The authoritative view. `srcDoc` with an EMPTY `sandbox` gives the document no scripts, no
 * same-origin access and no form submission -- it is staged HTML of unknown provenance rendered
 * inside the user's logged-in Google session, so it gets the strictest box available.
 */
function HtmlPane({ frame }: { frame: SlideFrame }): JSX.Element {
  switch (frame.html.kind) {
    case "unrequested":
    case "loading":
      return <p className="sasha-dim sasha-placeholder">loading {frame.name}...</p>;
    case "failed":
      return <p className="sasha-trouble sasha-placeholder">{frame.html.message}</p>;
    case "loaded":
      return (
        <iframe
          className="sasha-frame"
          title={`candidate ${frame.index} as HTML`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={frame.html.html}
        />
      );
    default:
      return assertNever(frame.html);
  }
}

/** The lossy projection: the geometry the converter asked Slides for. See rendered-preview.ts. */
function RenderedPane({ frame }: { frame: SlideFrame }): JSX.Element {
  switch (frame.conversion.kind) {
    case "unconverted":
      return <p className="sasha-dim sasha-placeholder">converting...</p>;
    case "failed":
      return <p className="sasha-trouble sasha-placeholder">conversion failed: {frame.conversion.message}</p>;
    case "converted":
      return (
        <div className="sasha-rendered" aria-label={`candidate ${frame.index} as Slides elements`}>
          {previewElementsOf(frame.conversion.requests).map((element, position) => (
            <PreviewBox key={`${element.objectId}_${position}`} element={element} />
          ))}
        </div>
      );
    default:
      return assertNever(frame.conversion);
  }
}

function PreviewBox({ element }: { element: PreviewElement }): JSX.Element {
  return (
    <div className={`sasha-el sasha-el-${element.kind}`} style={percentBox(element.region)} title={element.label}>
      <span className="sasha-el-text">{element.text}</span>
    </div>
  );
}

/**
 * Drag anywhere on the preview to mark a region. The box is captured as a FRACTION of the pane, so
 * it means the same thing at any zoom and lands in PICK as the 0-1 box PROTOCOL.md specifies.
 */
function AnomalyOverlay({
  frame,
  disabled,
  actions,
}: {
  frame: SlideFrame;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  const surface = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Readonly<{ fromX: number; fromY: number; toX: number; toY: number }> | null>(null);

  const fractionOf = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const element = surface.current;
    if (element === null) return { x: 0, y: 0 };
    const box = element.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - box.left) / Math.max(1, box.width)),
      y: clamp01((event.clientY - box.top) / Math.max(1, box.height)),
    };
  }, []);

  return (
    <div
      ref={surface}
      className={disabled ? "sasha-overlay sasha-overlay-off" : "sasha-overlay"}
      onPointerDown={(event) => {
        if (disabled) return;
        const at = fractionOf(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ fromX: at.x, fromY: at.y, toX: at.x, toY: at.y });
      }}
      onPointerMove={(event) => {
        if (drag === null) return;
        const at = fractionOf(event);
        setDrag({ ...drag, toX: at.x, toY: at.y });
      }}
      onPointerUp={() => {
        if (drag === null) return;
        const region = regionOfDrag(drag);
        setDrag(null);
        if (region !== null) actions.drawAnomaly({ index: frame.index, region });
      }}
    >
      {frame.anomalies.map((anomaly) => (
        <div
          key={anomaly.anomalyId}
          className={`sasha-mark sasha-mark-${anomaly.source}`}
          style={percentBox(anomaly.region)}
        />
      ))}
      {drag === null ? null : <div className="sasha-mark sasha-mark-drag" style={percentBox(regionOfDragLoose(drag))} />}
    </div>
  );
}

function AnomalyList({
  frame,
  disabled,
  actions,
}: {
  frame: SlideFrame;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  return (
    <ul className="sasha-anomalies">
      {frame.anomalies.length === 0 ? (
        <li className="sasha-dim">drag on the preview to report a conversion anomaly</li>
      ) : null}
      {frame.anomalies.map((anomaly) => (
        <AnomalyRow key={anomaly.anomalyId} frame={frame} anomaly={anomaly} disabled={disabled} actions={actions} />
      ))}
    </ul>
  );
}

function AnomalyRow({
  frame,
  anomaly,
  disabled,
  actions,
}: {
  frame: SlideFrame;
  anomaly: DraftAnomaly;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  return (
    <li className="sasha-anomaly">
      <span className={`sasha-source sasha-source-${anomaly.source}`}>{anomaly.source}</span>
      <input
        className="sasha-note"
        type="text"
        disabled={disabled}
        placeholder="what went wrong here?"
        value={anomaly.note}
        onChange={(event) =>
          actions.noteAnomaly({ index: frame.index, anomalyId: anomaly.anomalyId, note: event.target.value })
        }
      />
      <span className="sasha-dim">{describeRegion(anomaly.region)}</span>
      <button
        type="button"
        className="sasha-drop"
        disabled={disabled}
        aria-label="remove this anomaly"
        onClick={() => actions.removeAnomaly({ index: frame.index, anomalyId: anomaly.anomalyId })}
      >
        x
      </button>
    </li>
  );
}

function DialogActions({
  offer,
  stage,
  actions,
}: {
  offer: Offer;
  stage: SubmitStage | null;
  actions: PickerActions;
}): JSX.Element {
  const reported = anomaliesOf(offer).length;
  return (
    <footer className="sasha-actions">
      <span className="sasha-dim">
        {reported === 0 ? "no anomalies reported" : `${reported} anomal${reported === 1 ? "y" : "ies"} will be reported`}
      </span>
      <button type="button" className="sasha-secondary" disabled={stage !== null} onClick={actions.dismiss}>
        Dismiss
      </button>
      <button
        type="button"
        className="sasha-primary"
        disabled={stage !== null || offer.presentationId === null}
        onClick={() => actions.insertPicked(offer.selectedIndex)}
      >
        Insert option {offer.selectedIndex}
      </button>
    </footer>
  );
}

function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <>
      <style>{PICKER_CSS}</style>
      <div className="sasha-shell">{children}</div>
    </>
  );
}

const VIEW_ORDER = ["html", "rendered"] as const;
const VIEW_LABEL: Readonly<Record<SlideView, string>> = {
  html: "HTML (authoritative)",
  rendered: "Converted slide",
};
const STAGE_LABEL: Readonly<Record<SubmitStage, string>> = {
  converting: "converting...",
  inserting: "inserting into the deck...",
  "writing-pick": "telling Claude...",
};
/** Smaller than this is a click, not a drag, and would make an unusable 0-area region. */
const MIN_DRAG_FRACTION = 0.01;

function percentBox(region: Region): Readonly<{ left: string; top: string; width: string; height: string }> {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.w * 100}%`,
    height: `${region.h * 100}%`,
  };
}

function regionOfDrag(drag: Readonly<{ fromX: number; fromY: number; toX: number; toY: number }>): Region | null {
  const region = regionOfDragLoose(drag);
  return region.w < MIN_DRAG_FRACTION || region.h < MIN_DRAG_FRACTION ? null : region;
}

function regionOfDragLoose(drag: Readonly<{ fromX: number; fromY: number; toX: number; toY: number }>): Region {
  return {
    x: Math.min(drag.fromX, drag.toX),
    y: Math.min(drag.fromY, drag.toY),
    w: Math.abs(drag.toX - drag.fromX),
    h: Math.abs(drag.toY - drag.fromY),
  };
}

function describeRegion(region: Region): string {
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  return `${percent(region.x)},${percent(region.y)} ${percent(region.w)}x${percent(region.h)}`;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
