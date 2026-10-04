// The picker's whole state, as one tree with a pure reducer. React subscribes to it and renders it;
// nothing in the components decides anything. The outer `status` is a discriminated union so each
// render site is an exhaustive switch, and adding a status is a compile error everywhere it matters.

import type { ConversionResult, SlidesApiRequest, UnsupportedFeature } from "./converter-contract.ts";
import type { Proposal } from "./observer.ts";
import { WHOLE_SLIDE, assertNever, type Anomaly, type Region } from "./protocol.ts";

export type PickerState =
  /** Nothing is staged. The picker renders nothing at all -- it must not sit on top of Slides. */
  | Readonly<{ status: "dormant" }>
  | Readonly<{ status: "trouble"; message: string }>
  | Readonly<{ status: "picking"; offer: Offer }>
  | Readonly<{ status: "submitting"; offer: Offer; picked: number | null; stage: SubmitStage }>
  | Readonly<{ status: "settled"; proposalId: string; picked: number | null }>;

export type SubmitStage = "converting" | "inserting" | "writing-pick";

export type Offer = Readonly<{
  proposal: Proposal;
  /** The deck this tab has open. null means "insert has nowhere to go", which the UI must say. */
  presentationId: string | null;
  /** 1-based, so "option 3" is 3 here and on the chip the user clicked. */
  selectedIndex: number;
  view: SlideView;
  slides: readonly SlideFrame[];
  lastFailure: string | null;
}>;

/** The HTML is authoritative and is shown FIRST; the rendered pane is the lossy projection. */
export type SlideView = "html" | "rendered";

export type SlideFrame = Readonly<{
  index: number;
  label: string;
  name: string;
  html: HtmlLoad;
  conversion: ConversionLoad;
  anomalies: readonly DraftAnomaly[];
}>;

export type HtmlLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded"; html: string }>
  | Readonly<{ kind: "failed"; message: string }>;

export type ConversionLoad =
  | Readonly<{ kind: "unconverted" }>
  | Readonly<{ kind: "converted"; requests: readonly SlidesApiRequest[]; unsupported: readonly UnsupportedFeature[] }>
  | Readonly<{ kind: "failed"; message: string }>;

/** An anomaly in progress. `source` is why it exists; both kinds end up in PICK the same way. */
export type DraftAnomaly = Readonly<{
  anomalyId: string;
  note: string;
  region: Region;
  source: "user" | "converter";
}>;

export type PickerEvent =
  | Readonly<{ kind: "proposal-offered"; proposal: Proposal; presentationId: string | null }>
  | Readonly<{ kind: "trouble"; message: string }>
  | Readonly<{ kind: "slide-selected"; index: number }>
  | Readonly<{ kind: "view-chosen"; view: SlideView }>
  | Readonly<{ kind: "html-requested"; index: number }>
  | Readonly<{ kind: "html-arrived"; index: number; html: string }>
  | Readonly<{ kind: "html-failed"; index: number; message: string }>
  | Readonly<{ kind: "converted"; index: number; result: ConversionResult }>
  | Readonly<{ kind: "conversion-failed"; index: number; message: string }>
  | Readonly<{ kind: "anomaly-drawn"; index: number; anomalyId: string; region: Region }>
  | Readonly<{ kind: "anomaly-noted"; index: number; anomalyId: string; note: string }>
  | Readonly<{ kind: "anomaly-removed"; index: number; anomalyId: string }>
  | Readonly<{ kind: "submit-started"; picked: number | null; stage: SubmitStage }>
  | Readonly<{ kind: "submit-stage"; stage: SubmitStage }>
  | Readonly<{ kind: "submit-failed"; message: string }>
  | Readonly<{ kind: "settled"; proposalId: string; picked: number | null }>;

export const INITIAL_PICKER_STATE: PickerState = { status: "dormant" };

export function reducePicker(state: PickerState, event: PickerEvent): PickerState {
  switch (event.kind) {
    case "proposal-offered":
      // Re-announcing the proposal this tab is already showing must not throw away the user's
      // selection, their notes, or the HTML already fetched -- the offscreen document broadcasts it
      // again whenever any tab connects.
      if (offerOf(state)?.proposal.proposalId === event.proposal.proposalId) return state;
      return { status: "picking", offer: freshOffer(event) };

    case "trouble":
      // A picker on screen outranks a background Drive hiccup: the user is mid-decision.
      return offerOf(state) === null ? { status: "trouble", message: event.message } : state;

    case "slide-selected":
      return mapOffer(state, (offer) => ({ ...offer, selectedIndex: clampIndex({ offer, index: event.index }) }));

    case "view-chosen":
      return mapOffer(state, (offer) => ({ ...offer, view: event.view }));

    case "html-requested":
      return mapFrame(state, event.index, (frame) => ({ ...frame, html: { kind: "loading" } }));

    case "html-arrived":
      return mapFrame(state, event.index, (frame) => ({ ...frame, html: { kind: "loaded", html: event.html } }));

    case "html-failed":
      return mapFrame(state, event.index, (frame) => ({ ...frame, html: { kind: "failed", message: event.message } }));

    case "converted":
      return mapFrame(state, event.index, (frame) => withConversion({ frame, result: event.result }));

    case "conversion-failed":
      return mapFrame(state, event.index, (frame) => ({
        ...frame,
        conversion: { kind: "failed", message: event.message },
      }));

    case "anomaly-drawn":
      return mapFrame(state, event.index, (frame) => ({
        ...frame,
        anomalies: [
          ...frame.anomalies,
          { anomalyId: event.anomalyId, note: "", region: event.region, source: "user" },
        ],
      }));

    case "anomaly-noted":
      return mapFrame(state, event.index, (frame) => ({
        ...frame,
        anomalies: frame.anomalies.map((anomaly) =>
          anomaly.anomalyId === event.anomalyId ? { ...anomaly, note: event.note } : anomaly,
        ),
      }));

    case "anomaly-removed":
      return mapFrame(state, event.index, (frame) => ({
        ...frame,
        anomalies: frame.anomalies.filter((anomaly) => anomaly.anomalyId !== event.anomalyId),
      }));

    case "submit-started": {
      const offer = offerOf(state);
      if (offer === null) return state;
      return { status: "submitting", offer: { ...offer, lastFailure: null }, picked: event.picked, stage: event.stage };
    }

    case "submit-stage":
      return state.status === "submitting" ? { ...state, stage: event.stage } : state;

    case "submit-failed": {
      const offer = offerOf(state);
      if (offer === null) return state;
      // Back to picking with the reason on screen: a failed insert must not lose the user's notes.
      return { status: "picking", offer: { ...offer, lastFailure: event.message } };
    }

    case "settled":
      return { status: "settled", proposalId: event.proposalId, picked: event.picked };

    default:
      return assertNever(event);
  }
}

/** Every anomaly in the offer, as PICK's wire shape. May reference slides other than the picked one. */
export function anomaliesOf(offer: Offer): readonly Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const frame of offer.slides) {
    for (const draft of frame.anomalies) {
      // A converter-flagged region the user never commented on is still worth reporting -- the
      // converter already said it could not express it.
      const note = draft.note === "" && draft.source === "user" ? "(no note)" : draft.note;
      if (note === "") continue;
      anomalies.push({ index: frame.index, note, region: draft.region });
    }
  }
  return anomalies;
}

export function selectedFrame(offer: Offer): SlideFrame | null {
  return offer.slides[offer.selectedIndex - 1] ?? null;
}

export function offerOf(state: PickerState): Offer | null {
  switch (state.status) {
    case "picking":
    case "submitting":
      return state.offer;
    case "dormant":
    case "trouble":
    case "settled":
      return null;
    default:
      return assertNever(state);
  }
}

function freshOffer({
  proposal,
  presentationId,
}: {
  proposal: Proposal;
  presentationId: string | null;
}): Offer {
  return {
    proposal,
    presentationId,
    selectedIndex: 1,
    // The HTML is authoritative, so it is what the user sees first.
    view: "html",
    slides: proposal.slides.map((slide) => ({
      index: slide.index,
      label: slide.label,
      name: slide.name,
      html: { kind: "unrequested" },
      conversion: { kind: "unconverted" },
      anomalies: [],
    })),
    lastFailure: null,
  };
}

/**
 * The converter's `unsupported` list becomes pre-seeded anomalies, so the thing the converter
 * already knows it could not express is on screen as a box the user can comment on instead of
 * something they have to spot themselves.
 */
function withConversion({ frame, result }: { frame: SlideFrame; result: ConversionResult }): SlideFrame {
  const seeded: DraftAnomaly[] = result.unsupported.map((feature, position) => ({
    anomalyId: `converter_${frame.index}_${position}`,
    note: feature.note === "" ? feature.feature : `${feature.feature}: ${feature.note}`,
    region: feature.region,
    source: "converter",
  }));
  const userDrawn = frame.anomalies.filter((anomaly) => anomaly.source === "user");
  return {
    ...frame,
    conversion: { kind: "converted", requests: result.requests, unsupported: result.unsupported },
    anomalies: [...seeded, ...userDrawn],
  };
}

function mapOffer(state: PickerState, change: (offer: Offer) => Offer): PickerState {
  // Deliberately only while picking: the UI is read-only once a submit is in flight.
  return state.status === "picking" ? { status: "picking", offer: change(state.offer) } : state;
}

function mapFrame(state: PickerState, index: number, change: (frame: SlideFrame) => SlideFrame): PickerState {
  const offer = offerOf(state);
  if (offer === null) return state;
  const updated: Offer = {
    ...offer,
    slides: offer.slides.map((frame) => (frame.index === index ? change(frame) : frame)),
  };
  switch (state.status) {
    case "picking":
      return { status: "picking", offer: updated };
    case "submitting":
      return { ...state, offer: updated };
    case "dormant":
    case "trouble":
    case "settled":
      return state;
    default:
      return assertNever(state);
  }
}

function clampIndex({ offer, index }: { offer: Offer; index: number }): number {
  return Math.min(Math.max(1, Math.trunc(index)), offer.proposal.count);
}

export { WHOLE_SLIDE };
