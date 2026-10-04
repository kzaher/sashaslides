// The picker's whole state, as one tree with a pure reducer. React subscribes to it and renders it;
// nothing in the components decides anything. The outer `status` is a discriminated union so each
// render site is an exhaustive switch, and adding a status is a compile error everywhere it matters.

import type { ConversionResult, SlidesApiRequest, UnsupportedFeature } from "./converter-contract.ts";
import type { Proposal } from "./observer.ts";
import { WHOLE_SLIDE, assertNever, type Anomaly, type Region } from "./protocol.ts";
import { loadedSlideComments, type SlideCommentsLoad } from "./session-log.ts";
import type { SlideEdit } from "./slide-editor.ts";

export type PickerState =
  /**
   * Nothing is staged. The window says what it is waiting for and points back at the conversation,
   * which is the surface that is always there.
   *
   * THERE IS NO "reviewing" STATUS ANY MORE. Marking up a slide that is already in the deck was a
   * bug report, not art direction: review is PRE-INSERT, on the candidates, where Sasha can still
   * act on it (UI-CONTRACT.md). The deck-review mode was removed outright rather than demoted --
   * see README.md -- and with it `Review.tsx`, `review-state.ts` and `sashaCurrentPage`.
   *
   * THERE IS NO "reporting" STATUS EITHER. The defect report is a third HtmlService document of
   * its own (`report.tsx`), because the anonymiser is the heaviest code in the product and this
   * bundle has a hard size ceiling -- HtmlService has been observed corrupting an inlined blob of
   * ~560 KB. `Offer.report` is the phase of ASKING for that window.
   */
  | Readonly<{ status: "dormant" }>
  /**
   * SASHA DISCARDED THE UNINSERTED CANDIDATES. A cleared proposal still has its `READY` -- the
   * marker is not removed, only the candidates are, and `manifest.count` drops to 0 (PROTOCOL.md).
   * So this window CAN be opened onto a set that no longer exists, and a grid of nothing is
   * indistinguishable from a bug. It says so instead.
   */
  | Readonly<{ status: "cleared"; proposalId: string }>
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
  /**
   * THE ZOOM LEVEL -- every candidate at once, or one of them large. UI-CONTRACT.md, "The popup IS
   * the editor": this is a view and nothing more, so changing it never changes what the user may
   * do to a slide.
   */
  view: SlideView;
  /**
   * WHAT THE POINTER DOES ON A SLIDE, and it is `edit` from the first paint. Editing is the
   * DEFAULT STATE and not somewhere you navigate to -- the thing this field exists to stop is the
   * old behaviour, where annotation only became possible after clicking a cell to "enter" a
   * different screen.
   *
   * INDEPENDENT OF `view`, deliberately: every one of the four combinations is legal, so a user can
   * annotate from the grid or edit one slide large without the other choice moving. Two fields
   * rather than one enum of screens is what makes that true by construction.
   */
  tool: SlideTool;
  /** Which rendering of the candidate is on screen. The HTML is authoritative, so it is first. */
  rendering: SlideRendering;
  slides: readonly SlideFrame[];
  /**
   * THE CANDIDATES' COMMENT THREADS -- the unresolved counts' one source, and the SAME shape the
   * conversation holds. Both surfaces read `NN.html`'s own Drive comments and both derive the
   * number through session-log.ts's `unresolvedCountFor`, so the grid cell and the conversation
   * row cannot disagree about it (UI-CONTRACT.md).
   */
  comments: SlideCommentsLoad;
  /** Asking the host for the DEFECT-REPORT window. A refusal has to reach the screen. */
  report: OpenPhase;
  lastFailure: string | null;
}>;

/** Asking Apps Script to show another document. Mirrors the conversation's own `OpenPhase`. */
export type OpenPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "opening" }>
  | Readonly<{ kind: "opened" }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * THE VIEW: the grid, or one candidate up close. A ZOOM LEVEL -- UI-CONTRACT.md is explicit that it
 * is "nothing more" -- so it is deliberately not called a surface or a mode any more. Two values
 * rather than a boolean so every decision site is an exhaustive switch and a third zoom level is a
 * compile error, not a silent `else`.
 */
export type SlideView = "grid" | "single";

/**
 * THE TOOL: what dragging on a slide does. `edit` is the default and `annotate` is the other
 * choice, picked from the toolbar -- NOT a screen you enter. It is orthogonal to `SlideView`, which
 * is the whole point: annotating the grid and editing one slide large are both legal.
 */
export type SlideTool = "edit" | "annotate";

/** The HTML is authoritative and is shown FIRST; the rendered pane is the lossy projection. */
export type SlideRendering = "html" | "rendered";

export type SlideFrame = Readonly<{
  index: number;
  label: string;
  name: string;
  html: HtmlLoad;
  conversion: ConversionLoad;
  anomalies: readonly DraftAnomaly[];
  /**
   * What the VISUAL EDITOR has done to this candidate, in the order it was done. It lives in the
   * state tree rather than inside the editor component for the same reason `Review.draft` does: a
   * Drive poll re-renders the whole tree, and anything held in component state would be lost.
   * The editor is the authority on the list; this is the picker's copy of it. See slide-editor.ts.
   */
  edits: readonly SlideEdit[];
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

/**
 * A mark-up in progress. `source` is why it exists; both kinds end up in PICK the same way.
 *
 * `sent` is the pre-insert review half: a mark-up the user SENDS becomes a native Drive comment on
 * the candidate's own `NN.html` (PROTOCOL.md -- "Comments live on the CANDIDATE, not the deck"),
 * which is what lets Sasha answer it, resolve it and revise the slide. Until it is sent it is a
 * local note that only travels in PICK; after it is sent it is a thread with an id, and the
 * unresolved count for this slide includes it.
 */
export type DraftAnomaly = Readonly<{
  anomalyId: string;
  note: string;
  region: Region;
  source: "user" | "converter";
  sent: AnomalySendPhase;
}>;

export type AnomalySendPhase =
  | Readonly<{ kind: "draft" }>
  | Readonly<{ kind: "sending" }>
  /** Drive accepted it; `commentId` is the thread Sasha replies to and resolves. */
  | Readonly<{ kind: "sent"; commentId: string }>
  | Readonly<{ kind: "failed"; message: string }>;

export type PickerEvent =
  | Readonly<{ kind: "proposal-offered"; proposal: Proposal; presentationId: string | null }>
  | Readonly<{ kind: "trouble"; message: string }>
  | Readonly<{ kind: "slide-selected"; index: number }>
  /** The ZOOM LEVEL changed. It never touches `tool`: a view is not a permission. */
  | Readonly<{ kind: "view-chosen"; view: SlideView }>
  /** The TOOL changed. It never touches `view`: a tool is not a zoom level. */
  | Readonly<{ kind: "tool-chosen"; tool: SlideTool }>
  | Readonly<{ kind: "rendering-chosen"; rendering: SlideRendering }>
  | Readonly<{ kind: "html-requested"; index: number }>
  | Readonly<{ kind: "html-arrived"; index: number; html: string }>
  | Readonly<{ kind: "html-failed"; index: number; message: string }>
  | Readonly<{ kind: "converted"; index: number; result: ConversionResult }>
  | Readonly<{ kind: "conversion-failed"; index: number; message: string }>
  | Readonly<{ kind: "anomaly-drawn"; index: number; anomalyId: string; region: Region }>
  | Readonly<{ kind: "anomaly-noted"; index: number; anomalyId: string; note: string }>
  | Readonly<{ kind: "anomaly-removed"; index: number; anomalyId: string }>
  /**
   * ZOOM IN ON ONE CANDIDATE: select it and show it large. `tool` is deliberately absent from this
   * transition -- "clicking a slide in the grid changes the VIEW; it does not change what you are
   * allowed to do" (UI-CONTRACT.md), and the reducer is where that is made impossible to get wrong.
   */
  | Readonly<{ kind: "candidate-zoomed"; index: number }>
  | Readonly<{ kind: "edits-changed"; index: number; edits: readonly SlideEdit[] }>
  | Readonly<{ kind: "submit-started"; picked: number | null; stage: SubmitStage }>
  | Readonly<{ kind: "submit-stage"; stage: SubmitStage }>
  | Readonly<{ kind: "submit-failed"; message: string }>
  | Readonly<{ kind: "settled"; proposalId: string; picked: number | null }>
  | Readonly<{ kind: "comments-requested" }>
  | Readonly<{ kind: "comments-arrived"; comments: SlideCommentsLoad }>
  | Readonly<{ kind: "comments-failed"; message: string }>
  /** Send one mark-up to Sasha, as a comment on the candidate itself. The pre-insert review path. */
  | Readonly<{ kind: "anomaly-send-started"; index: number; anomalyId: string }>
  | Readonly<{ kind: "anomaly-send-succeeded"; index: number; anomalyId: string; commentId: string }>
  | Readonly<{ kind: "anomaly-send-failed"; index: number; anomalyId: string; message: string }>
  | Readonly<{ kind: "report-requested" }>
  | Readonly<{ kind: "report-succeeded" }>
  | Readonly<{ kind: "report-failed"; message: string }>;

export const INITIAL_PICKER_STATE: PickerState = { status: "dormant" };

export function reducePicker(state: PickerState, event: PickerEvent): PickerState {
  switch (event.kind) {
    case "proposal-offered":
      // Re-announcing the proposal this tab is already showing must not throw away the user's
      // selection, their notes, or the HTML already fetched -- the observer re-announces it
      // whenever a viewer appears.
      //
      if (offerOf(state)?.proposal.proposalId === event.proposal.proposalId) return state;
      // `count === 0` is a CLEARED set, not a malformed one: `clear_slides` leaves `READY` behind.
      if (event.proposal.count === 0) return { status: "cleared", proposalId: event.proposal.proposalId };
      return { status: "picking", offer: freshOffer(event) };

    case "trouble":
      // A picker on screen outranks a background Drive hiccup: the user is mid-decision, and a
      // poll that failed must not throw away the mark-ups they have typed.
      return offerOf(state) === null ? { status: "trouble", message: event.message } : state;

    case "slide-selected":
      return mapOffer(state, (offer) => ({ ...offer, selectedIndex: clampIndex({ offer, index: event.index }) }));

    case "view-chosen":
      return mapOffer(state, (offer) => ({ ...offer, view: event.view }));

    case "tool-chosen":
      return mapOffer(state, (offer) => ({ ...offer, tool: event.tool }));

    case "rendering-chosen":
      return mapOffer(state, (offer) => ({ ...offer, rendering: event.rendering }));

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
          { anomalyId: event.anomalyId, note: "", region: event.region, source: "user", sent: { kind: "draft" } },
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

    case "candidate-zoomed":
      // `tool` is NOT in this update, and that is the contract: a zoom changes what you are looking
      // at and never what you may do to it.
      return mapOffer(state, (offer) => ({
        ...offer,
        selectedIndex: clampIndex({ offer, index: event.index }),
        view: "single",
      }));

    case "edits-changed":
      return mapFrame(state, event.index, (frame) => ({ ...frame, edits: event.edits }));

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

    case "comments-requested":
      return mapAnyOffer(state, (offer) => ({
        ...offer,
        comments: { kind: "loading", slides: loadedSlideComments(offer.comments) },
      }));

    case "comments-arrived":
      return mapAnyOffer(state, (offer) => ({ ...offer, comments: event.comments }));

    case "comments-failed":
      return mapAnyOffer(state, (offer) => ({
        ...offer,
        comments: { kind: "failed", message: event.message, slides: loadedSlideComments(offer.comments) },
      }));

    case "anomaly-send-started":
      return mapAnomaly(state, event, () => ({ kind: "sending" }));

    case "anomaly-send-succeeded":
      return mapAnomaly(state, event, () => ({ kind: "sent", commentId: event.commentId }));

    case "anomaly-send-failed":
      return mapAnomaly(state, event, () => ({ kind: "failed", message: event.message }));

    case "report-requested":
      return mapAnyOffer(state, (offer) => ({ ...offer, report: { kind: "opening" } }));

    case "report-succeeded":
      return mapAnyOffer(state, (offer) => ({ ...offer, report: { kind: "opened" } }));

    case "report-failed":
      return mapAnyOffer(state, (offer) => ({ ...offer, report: { kind: "failed", message: event.message } }));

    default:
      return assertNever(event);
  }
}

/** Every anomaly in the offer, as PICK's wire shape. May reference slides other than the picked one. */
export function anomaliesOf(offer: Offer): readonly Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const frame of offer.slides) {
    // The converter's own findings FIRST and with no ceremony: they are sent under the hood,
    // they have no row on screen and no Send button, and the user never had to do anything.
    for (const finding of converterFindingsOf(frame)) {
      anomalies.push({ index: frame.index, note: finding.note, region: finding.region });
    }
    for (const draft of frame.anomalies) {
      anomalies.push({ index: frame.index, note: draft.note === "" ? "(no note)" : draft.note, region: draft.region });
    }
  }
  return anomalies;
}

export function selectedFrame(offer: Offer): SlideFrame | null {
  return offer.slides[offer.selectedIndex - 1] ?? null;
}

/**
 * WHETHER DRAGGING ON A SLIDE DRAWS A MARK-UP BOX. A predicate over `SlideTool` rather than a bare
 * `tool === "annotate"` at each call site, so a third tool is a compile error HERE instead of a
 * surface that silently stops offering the gesture (typescript skill, exhaustiveness).
 */
export function drawsRegions(tool: SlideTool): boolean {
  switch (tool) {
    case "annotate":
      return true;
    case "edit":
      return false;
    default:
      return assertNever(tool);
  }
}

/** Whether the visual editor wants the pointer. Same contract as `drawsRegions`, same reason. */
export function editsSlides(tool: SlideTool): boolean {
  switch (tool) {
    case "edit":
      return true;
    case "annotate":
      return false;
    default:
      return assertNever(tool);
  }
}

/**
 * WHETHER THE EDIT TOOL CAN ACTUALLY REACH THIS CANDIDATE, and when it cannot, why -- as a union,
 * so the slot renders a reason rather than an empty box (UI-CONTRACT.md: "A surface that cannot
 * reach the server says so").
 *
 * Two honest refusals. The CONVERTED pane is a projection of the conversion and editing it would
 * edit the lossy copy, which the invariants forbid outright ("an edit edits the HTML, never the
 * conversion"). A candidate whose document has not arrived has nothing to edit yet.
 */
export function editorReachOf({
  rendering,
  frame,
}: {
  rendering: SlideRendering;
  frame: SlideFrame | null;
}): EditorReach {
  if (frame === null) return { kind: "no-candidate" };
  switch (rendering) {
    case "rendered":
      return { kind: "projection" };
    case "html":
      return htmlReachOf(frame);
    default:
      return assertNever(rendering);
  }
}

/** Whether the editor is actually attached. A predicate, so a new `EditorReach` arm is a compile error. */
export function editorIsLive(reach: EditorReach): boolean {
  switch (reach.kind) {
    case "reachable":
      return true;
    case "projection":
    case "unloaded":
    case "no-candidate":
      return false;
    default:
      return assertNever(reach);
  }
}

export type EditorReach =
  | Readonly<{ kind: "reachable" }>
  /** The converted projection is on screen. The HTML is authoritative; the projection is not edited. */
  | Readonly<{ kind: "projection" }>
  | Readonly<{ kind: "unloaded"; message: string }>
  | Readonly<{ kind: "no-candidate" }>;

/** Why the editor is not live, in words. Exhaustive, so a new arm has to be explained. */
export function describeEditorReach(reach: EditorReach): string {
  switch (reach.kind) {
    case "reachable":
      return "Click anything on the slide to move, resize, recolour or retype it.";
    case "projection":
      return (
        "The converted slide is a projection of the conversion, and an edit edits the HTML -- " +
        "switch the rendering back to HTML to edit this candidate."
      );
    case "unloaded":
      return reach.message;
    case "no-candidate":
      return "there is no candidate selected to edit";
    default:
      return assertNever(reach);
  }
}

/**
 * A candidate's document, or null when it is not in yet. A switch rather than a bare
 * `kind === "loaded"` at each call site, so a new `HtmlLoad` variant has to say whether it carries
 * bytes instead of silently reading as "nothing".
 */
export function loadedHtmlOf(frame: SlideFrame | null): string | null {
  if (frame === null) return null;
  switch (frame.html.kind) {
    case "loaded":
      return frame.html.html;
    case "unrequested":
    case "loading":
    case "failed":
      return null;
    default:
      return assertNever(frame.html);
  }
}

/**
 * The next candidate whose HTML has not been asked for, or null when every one is in flight or in.
 *
 * EVERY candidate, not just the selected one. The grid shows all N at once, so all N documents are
 * needed; the sidebar only ever showed one pane and loaded lazily. They are loaded ONE AT A TIME
 * -- each arrival re-runs the pump, which picks the next -- because `google.script.run` is a round
 * trip to Google per call and firing N at once only makes the first one slower.
 */
export function nextHtmlToLoad(offer: Offer): SlideFrame | null {
  for (const frame of offer.slides) if (needsHtml(frame)) return frame;
  return null;
}

/** The next candidate that has its HTML and no conversion yet. Same one-at-a-time chain. */
export function nextToConvert(offer: Offer): SlideFrame | null {
  for (const frame of offer.slides) if (frame.html.kind === "loaded" && needsConversion(frame)) return frame;
  return null;
}

/**
 * Whether a frame's HTML wants fetching. A predicate over the union rather than a bare
 * `kind === "unrequested"` so adding an `HtmlLoad` variant is a compile error here instead of a
 * silently skipped fetch -- the same contract `needsPage` has in review-state.ts.
 */
export function needsHtml(frame: SlideFrame): boolean {
  switch (frame.html.kind) {
    case "unrequested":
      return true;
    case "loading":
    case "loaded":
    case "failed":
      return false;
    default:
      return assertNever(frame.html);
  }
}

/** Same contract as `needsHtml`, for the conversion. */
export function needsConversion(frame: SlideFrame): boolean {
  switch (frame.conversion.kind) {
    case "unconverted":
      return true;
    case "converted":
    case "failed":
      return false;
    default:
      return assertNever(frame.conversion);
  }
}

export function offerOf(state: PickerState): Offer | null {
  switch (state.status) {
    case "picking":
    case "submitting":
      return state.offer;
    case "dormant":
    case "cleared":
    case "trouble":
    case "settled":
      return null;
    default:
      return assertNever(state);
  }
}

/**
 * Whether the candidates' comment read should run. A predicate over the union, so a new
 * `SlideCommentsLoad` variant is a compile error here instead of a silently skipped fetch -- and
 * the grid's badges would be the thing that silently went stale.
 */
export function needsComments(offer: Offer): boolean {
  switch (offer.comments.kind) {
    case "unrequested":
      return true;
    case "loading":
    case "loaded":
    case "failed":
      return false;
    default:
      return assertNever(offer.comments);
  }
}

/** One mark-up by id, or null. The composition root needs its text to build the comment body. */
export function anomalyIn({
  offer,
  index,
  anomalyId,
}: {
  offer: Offer;
  index: number;
  anomalyId: string;
}): DraftAnomaly | null {
  const frame = offer.slides.find((candidate) => candidate.index === index);
  if (frame === undefined) return null;
  return frame.anomalies.find((anomaly) => anomaly.anomalyId === anomalyId) ?? null;
}

/**
 * Whether a mark-up can be sent to Sasha. An exhaustive switch over the send phase AND a text
 * check, because an empty comment says nothing -- `feedbackCommentContent` would refuse it anyway
 * and the refusal is better made before the button is pressed.
 */
export function isSendableAnomaly(anomaly: DraftAnomaly): boolean {
  if (anomaly.note.trim() === "") return false;
  switch (anomaly.sent.kind) {
    case "draft":
    case "failed":
      return true;
    case "sending":
    case "sent":
      return false;
    default:
      return assertNever(anomaly.sent);
  }
}

/** The edit tool's reach when the HTML pane is showing: the document's own load state, in words. */
function htmlReachOf(frame: SlideFrame): EditorReach {
  switch (frame.html.kind) {
    case "loaded":
      return { kind: "reachable" };
    case "unrequested":
    case "loading":
      return { kind: "unloaded", message: `${frame.name} is still being read from Drive` };
    case "failed":
      return { kind: "unloaded", message: frame.html.message };
    default:
      return assertNever(frame.html);
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
    // The GRID first: comparing the candidates against each other is the whole reason this window
    // exists, so nobody has to click to see what they were offered.
    view: "grid",
    // EDIT FROM THE FIRST PAINT. UI-CONTRACT.md: "Editing is the default state, not a thing you
    // navigate to." Nothing anywhere promotes a tool on the user's behalf.
    tool: "edit",
    // The HTML is authoritative, so it is what the user sees first.
    rendering: "html",
    slides: proposal.slides.map((slide) => ({
      index: slide.index,
      label: slide.label,
      name: slide.name,
      html: { kind: "unrequested" },
      conversion: { kind: "unconverted" },
      anomalies: [],
      edits: [],
    })),
    comments: { kind: "unrequested" },
    report: { kind: "idle" },
    lastFailure: null,
  };
}

/**
 * THE CONVERSION IS RECORDED; IT DOES NOT BECOME MARK-UPS.
 *
 * The converter's `unsupported` list used to be seeded straight into `frame.anomalies` -- the
 * list the window renders as the USER's annotations -- so opening a four-candidate proposal
 * showed thirteen "CONVERTER" rows nobody wrote, each with its own note field and Send button,
 * above the one box the user had actually drawn. The two kinds of thing were indistinguishable.
 *
 * The findings still reach Sasha and still appear on the slide; they just do it from here
 * rather than from a row. `converterFindingsOf` reads them for `PICK.anomalies` (under the
 * hood, no button) and `marksOf` draws them in the converter tone.
 */
function withConversion({ frame, result }: { frame: SlideFrame; result: ConversionResult }): SlideFrame {
  return {
    ...frame,
    conversion: { kind: "converted", requests: result.requests, unsupported: result.unsupported },
    anomalies: frame.anomalies.filter((anomaly) => anomaly.source === "user"),
  };
}

/**
 * What the converter itself flagged on one candidate, as mark-up-shaped values.
 *
 * Derived on read rather than stored, so a re-conversion cannot leave a stale finding behind
 * and the user can never edit or delete one -- it is the converter's statement, not theirs.
 */
export function converterFindingsOf(
  frame: Readonly<{ index: number; conversion: SlideFrame["conversion"] }>,
): readonly ConverterFinding[] {
  if (frame.conversion.kind !== "converted") return [];
  return frame.conversion.unsupported.map((feature, position) => ({
    findingId: `converter_${String(frame.index)}_${String(position)}`,
    note: feature.note === "" ? feature.feature : `${feature.feature}: ${feature.note}`,
    region: feature.region,
  }));
}

/** One thing the converter could not express, and where on the slide it is. */
export type ConverterFinding = Readonly<{ findingId: string; note: string; region: Region }>;

function mapOffer(state: PickerState, change: (offer: Offer) => Offer): PickerState {
  // Deliberately only while picking: the UI is read-only once a submit is in flight.
  return state.status === "picking" ? { status: "picking", offer: change(state.offer) } : state;
}

function mapFrame(state: PickerState, index: number, change: (frame: SlideFrame) => SlideFrame): PickerState {
  return mapAnyOffer(state, (offer) => ({
    ...offer,
    slides: offer.slides.map((frame) => (frame.index === index ? change(frame) : frame)),
  }));
}

/**
 * Change the offer in `picking` OR `submitting`. `mapOffer` is deliberately picking-only -- the UI
 * is read-only once a submit is in flight -- but a BACKGROUND load (the comment read) and a
 * cross-surface request still have to land while a submit runs, or the badges freeze on the slide
 * the user is inserting.
 */
function mapAnyOffer(state: PickerState, change: (offer: Offer) => Offer): PickerState {
  switch (state.status) {
    case "picking":
      return { status: "picking", offer: change(state.offer) };
    case "submitting":
      return { ...state, offer: change(state.offer) };
    case "dormant":
    case "cleared":
    case "trouble":
    case "settled":
      return state;
    default:
      return assertNever(state);
  }
}

function mapAnomaly(
  state: PickerState,
  target: Readonly<{ index: number; anomalyId: string }>,
  change: (sent: AnomalySendPhase) => AnomalySendPhase,
): PickerState {
  return mapFrame(state, target.index, (frame) => ({
    ...frame,
    anomalies: frame.anomalies.map((anomaly) =>
      anomaly.anomalyId === target.anomalyId ? { ...anomaly, sent: change(anomaly.sent) } : anomaly,
    ),
  }));
}

function clampIndex({ offer, index }: { offer: Offer; index: number }): number {
  return Math.min(Math.max(1, Math.trunc(index)), offer.proposal.count);
}

export { WHOLE_SLIDE };
