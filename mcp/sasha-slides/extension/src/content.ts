// The content script: the composition root for the UI half. It connects the port, owns the
// PickerState store, runs the feedback loops that turn state into requests, and mounts React into a
// shadow root on the Google Slides page.
//
// Shape, as everywhere else in this repo: one state tree, a pure reducer, and feedback loops that
// are functions OF the state. React is a passive subscriber -- it renders the state and calls the
// actions, and decides nothing.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { Picker, type PickerActions } from "./Picker.tsx";
import {
  normalizeUnsupported,
  stubConvertHtmlToSlideRequests,
  type ConvertHtmlToSlideRequests,
} from "./converter-contract.ts";
import {
  INITIAL_PICKER_STATE,
  anomaliesOf,
  offerOf,
  reducePicker,
  selectedFrame,
  type PickerEvent,
  type PickerState,
} from "./picker-state.ts";
import { PROTOCOL_VERSION, assertNever } from "./protocol.ts";
import { insertRequests, newPageObjectId } from "./slide-insert.ts";
import {
  CONTENT_PORT_PREFIX,
  asWireMessage,
  presentationIdOf,
  type Downstream,
  type Upstream,
} from "./wire.ts";

const HOST_ELEMENT_ID = "sasha-slides-picker-host";
/** A reply that never comes must not freeze the picker; CDP-speed operations are sub-second. */
const REPLY_TIMEOUT_MS = 20_000;

// THE ONE WIRING LINE FOR THE CONVERTER. `mcp/sasha-slides/converter/` is another stream's; when it
// lands, this becomes `import { convertHtmlToSlideRequests } from "../../converter/index.ts"` and
// nothing else in the extension changes. The stub reports itself as unsupported so the anomaly UI
// is honest about what it is showing.
const convertHtmlToSlideRequests: ConvertHtmlToSlideRequests = stubConvertHtmlToSlideRequests();

const presentationId = presentationIdOf(location.href);
const sessionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

let state: PickerState = INITIAL_PICKER_STATE;
let root: Root | null = null;
let port: chrome.runtime.Port | null = null;
const waiting = new Set<(message: Downstream) => void>();

start();

function start(): void {
  port = connect();
  render();
  document.addEventListener("visibilitychange", () => {
    send({ type: "visibility", visible: document.visibilityState === "visible" });
  });
}

function connect(): chrome.runtime.Port {
  const opened = chrome.runtime.connect({ name: CONTENT_PORT_PREFIX + sessionId });
  opened.onMessage.addListener((message: unknown) => {
    const downstream = asDownstream(message);
    if (downstream === null) return;
    for (const resolve of [...waiting]) resolve(downstream);
    onDownstream(downstream);
  });
  // The service worker is terminated when idle, which takes both legs of the port with it. The
  // offscreen document and its state survive, so reconnecting with the same session id is a
  // complete recovery -- see wire.ts.
  opened.onDisconnect.addListener(() => {
    port = null;
    setTimeout(() => {
      if (port === null) port = connect();
    }, 500);
  });
  opened.postMessage({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    presentationId,
    visible: document.visibilityState === "visible",
  } satisfies Upstream);
  return opened;
}

function onDownstream(message: Downstream): void {
  switch (message.type) {
    case "proposal":
      dispatch({ kind: "proposal-offered", proposal: message.proposal, presentationId });
      return;
    case "trouble":
    case "broker-failed":
      dispatch({ kind: "trouble", message: message.message });
      return;
    case "slide-html":
      dispatch({ kind: "html-arrived", index: message.index, html: message.html });
      return;
    case "slide-html-failed":
      dispatch({ kind: "html-failed", index: message.index, message: message.message });
      return;
    case "decided":
      dispatch({ kind: "settled", proposalId: message.proposalId, picked: lastPicked() });
      return;
    case "offscreen-ready":
    case "inserted":
    case "insert-failed":
    case "decide-failed":
      // Answers to a request the submit sequence is already awaiting; it dispatches for them.
      return;
    default:
      return assertNever(message);
  }
}

function dispatch(event: PickerEvent): void {
  const next = reducePicker(state, event);
  if (next === state) return;
  state = next;
  render();
  pump();
}

/**
 * The feedback loops, as functions of the state: fetch the HTML of the slide being looked at, and
 * convert it once its HTML is in. Idempotent, because `dispatch` runs them after every change.
 */
function pump(): void {
  const offer = offerOf(state);
  if (offer === null) return;
  const frame = selectedFrame(offer);
  if (frame === null) return;
  if (frame.html.kind === "unrequested") {
    dispatch({ kind: "html-requested", index: frame.index });
    send({ type: "request-slide-html", proposalId: offer.proposal.proposalId, index: frame.index });
    return;
  }
  if (frame.html.kind === "loaded" && frame.conversion.kind === "unconverted") {
    convert({ index: frame.index, html: frame.html.html });
  }
}

function convert({ index, html }: { index: number; html: string }): void {
  try {
    const converted = convertHtmlToSlideRequests({
      html,
      presentationId: presentationId ?? "",
      pageObjectId: newPageObjectId({ random: Math.random }),
    });
    dispatch({
      kind: "converted",
      index,
      result: { requests: converted.requests, unsupported: normalizeUnsupported([...converted.unsupported]) },
    });
  } catch (cause) {
    dispatch({
      kind: "conversion-failed",
      index,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

const actions: PickerActions = {
  selectSlide(index) {
    dispatch({ kind: "slide-selected", index });
  },
  chooseView(view) {
    dispatch({ kind: "view-chosen", view });
  },
  drawAnomaly({ index, region }) {
    dispatch({ kind: "anomaly-drawn", index, anomalyId: `user_${index}_${Date.now().toString(36)}`, region });
  },
  noteAnomaly({ index, anomalyId, note }) {
    dispatch({ kind: "anomaly-noted", index, anomalyId, note });
  },
  removeAnomaly({ index, anomalyId }) {
    dispatch({ kind: "anomaly-removed", index, anomalyId });
  },
  insertPicked(index) {
    void submit({ picked: index });
  },
  dismiss() {
    void submit({ picked: null });
  },
};

/**
 * Convert -> insert -> write PICK, in that order, because PROTOCOL.md wants the render artifact in
 * place before the server is told the decision. A dismissal skips straight to PICK with
 * `picked: null`, which is what the server is blocked on.
 */
async function submit({ picked }: { picked: number | null }): Promise<void> {
  const offer = offerOf(state);
  if (offer === null) return;
  const proposalId = offer.proposal.proposalId;
  dispatch({ kind: "submit-started", picked, stage: picked === null ? "writing-pick" : "converting" });

  const insertedObjectIds = picked === null ? [] : await insertPicked({ proposalId, picked });
  if (insertedObjectIds === null) return;

  dispatch({ kind: "submit-stage", stage: "writing-pick" });
  const decided = offerOf(state);
  send({
    type: "decide",
    proposalId,
    picked,
    insertedObjectIds,
    anomalies: decided === null ? [] : anomaliesOf(decided),
  });
  const answer = await awaitReply(
    (message) =>
      (message.type === "decided" || message.type === "decide-failed") && message.proposalId === proposalId,
  );
  if (answer === null || answer.type === "decide-failed") {
    dispatch({
      kind: "submit-failed",
      message: answer === null ? "the extension did not answer in time" : answer.message,
    });
    return;
  }
  dispatch({ kind: "settled", proposalId, picked });
}

/** The object ids Slides created, or null when the insert failed (the reducer has been told). */
async function insertPicked({
  proposalId,
  picked,
}: {
  proposalId: string;
  picked: number;
}): Promise<readonly string[] | null> {
  const offer = offerOf(state);
  const frame = offer === null ? null : offer.slides[picked - 1];
  if (offer === null || frame === null || frame === undefined) {
    dispatch({ kind: "submit-failed", message: `option ${picked} is no longer available` });
    return null;
  }
  if (offer.presentationId === null) {
    dispatch({ kind: "submit-failed", message: "this tab has no presentation to insert into" });
    return null;
  }
  if (frame.html.kind !== "loaded") {
    dispatch({ kind: "submit-failed", message: `option ${picked}'s HTML has not loaded yet` });
    return null;
  }
  // Converted again here rather than reused: the page id has to be the one actually created, and
  // the cached conversion was made against a preview id.
  const pageObjectId = newPageObjectId({ random: Math.random });
  const converted = convertHtmlToSlideRequests({
    html: frame.html.html,
    presentationId: offer.presentationId,
    pageObjectId,
  });

  dispatch({ kind: "submit-stage", stage: "inserting" });
  send({
    type: "insert",
    proposalId,
    index: picked,
    presentationId: offer.presentationId,
    pageObjectId,
    requests: insertRequests({ pageObjectId, converted: converted.requests }),
  });
  const answer = await awaitReply(
    (message) =>
      (message.type === "inserted" || message.type === "insert-failed") && message.proposalId === proposalId,
  );
  if (answer === null || answer.type === "insert-failed") {
    dispatch({
      kind: "submit-failed",
      message: answer === null ? "the insert did not answer in time" : answer.message,
    });
    return null;
  }
  return answer.type === "inserted" ? answer.objectIds : [];
}

function awaitReply(matches: (message: Downstream) => boolean): Promise<Downstream | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(listen);
      resolve(null);
    }, REPLY_TIMEOUT_MS);
    function listen(message: Downstream): void {
      if (!matches(message)) return;
      clearTimeout(timer);
      waiting.delete(listen);
      resolve(message);
    }
    waiting.add(listen);
  });
}

function lastPicked(): number | null {
  return state.status === "submitting" ? state.picked : null;
}

function send(message: Upstream): void {
  const open = port;
  if (open === null) return;
  try {
    open.postMessage(message);
  } catch {
    /* the service worker was terminated; onDisconnect reconnects */
  }
}

/**
 * Mounted into a shadow root so Google Slides' stylesheet cannot reach the picker and the picker's
 * cannot reach the page. The host element is created once and reused across renders.
 */
function render(): void {
  if (root === null) {
    const existing = document.getElementById(HOST_ELEMENT_ID);
    const host = existing ?? document.createElement("div");
    host.id = HOST_ELEMENT_ID;
    if (existing === null) document.documentElement.append(host);
    root = createRoot(host.shadowRoot ?? host.attachShadow({ mode: "open" }));
  }
  root.render(createElement(Picker, { state, actions }));
}

function asDownstream(message: unknown): Downstream | null {
  const record = asWireMessage(message);
  if (record === null) return null;
  switch (record["type"]) {
    case "offscreen-ready":
    case "proposal":
    case "trouble":
    case "slide-html":
    case "slide-html-failed":
    case "inserted":
    case "insert-failed":
    case "decided":
    case "decide-failed":
    case "broker-failed":
      // A parse-boundary guard: the value crossed a port, so this compares a string rather than
      // switching over the closed union. Everything above it then has a narrowed Downstream.
      return record as unknown as Downstream;
    default:
      return null;
  }
}
