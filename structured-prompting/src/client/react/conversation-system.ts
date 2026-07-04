/**
 * The conversation viewer's RxFeedback system: State, Events, the pure
 * reducer, and the three side-effecting feedbacks (load transcript, run SSE
 * send, watch the graph for an in-flight node).
 *
 * This file is pure logic + RxJS — NO JSX — so it needs no react/preact
 * pragma. `ConversationApp.tsx` (React) consumes it via `useSystem`.
 */
import { Observable, Subject, from, of, EMPTY } from "rxjs";
import {
  map,
  distinctUntilChanged,
  switchMap,
  filter,
  catchError,
  mergeMap,
} from "rxjs/operators";
import type {
  GraphSnapshot,
  TranscriptTurn,
  TranscriptBlock,
  TranscriptReply,
} from "../../api/wire.js";
import { makeSystem, type RunningSystem } from "./rxfeedback.js";

export interface Attachment {
  media_type: string;
  data: string;
  name: string;
  dataUrl: string;
}

export type Status = "idle" | "loading" | "sending" | "inflight";

export interface ConversationState {
  sessionId: string;
  cwd: string | null;
  turns: TranscriptTurn[];
  status: Status;
  /** true once the first transcript load has resolved (success or empty). */
  loaded: boolean;
  loadError: string | null;
  sendError: string | null;
  /** live streaming text from the composer-initiated send, or null when idle. */
  streamingText: string | null;
  /** live streaming text from an engine-driven in-flight node, or null. */
  enginePartial: string | null;
  attachments: Attachment[];
  /** latest polled graph snapshot (fed in as an event by the view). */
  graphVersion: number;
  /** true while an engine node with this sessionId is `running`. */
  engineRunning: boolean;
}

/**
 * The event alphabet. Every state transition and every feedback outcome is
 * one of these — the reducer is a pure fold over this union.
 */
export type ConversationEvent =
  | { type: "loadRequested" }
  | { type: "transcriptLoaded"; turns: TranscriptTurn[]; cwd: string | null }
  | { type: "loadFailed"; error: string }
  | { type: "sendRequested"; message: string; images: Attachment[] }
  | { type: "delta"; text: string }
  | { type: "sendDone"; text: string }
  | { type: "sendFailed"; error: string }
  | { type: "attachmentAdded"; attachment: Attachment }
  | { type: "attachmentRemoved"; index: number }
  | { type: "graphSnapshot"; graph: GraphSnapshot }
  | { type: "inflightDetected"; partialText: string }
  | { type: "inflightCleared" };

export function initialState(sessionId: string, cwd: string | null): ConversationState {
  return {
    sessionId,
    cwd,
    turns: [],
    status: "idle",
    loaded: false,
    loadError: null,
    sendError: null,
    streamingText: null,
    enginePartial: null,
    attachments: [],
    graphVersion: -1,
    engineRunning: false,
  };
}

/** Pure reducer: (state, event) => state. No side effects. */
export function reduce(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case "loadRequested":
      return { ...state, status: state.turns.length ? state.status : "loading" };
    case "transcriptLoaded":
      return {
        ...state,
        turns: event.turns,
        cwd: event.cwd ?? state.cwd,
        loaded: true,
        loadError: null,
        // A load only settles the status back to idle if we weren't mid-send /
        // mid-inflight (those own the status until their own terminal event).
        status: state.status === "loading" ? "idle" : state.status,
      };
    case "loadFailed":
      return { ...state, loaded: true, loadError: event.error };
    case "sendRequested": {
      // Optimistically append the user's turn so it shows instantly.
      const blocks: TranscriptBlock[] = [];
      if (event.message) blocks.push({ type: "text", text: event.message });
      for (const a of event.images) blocks.push({ type: "image", dataUrl: a.dataUrl });
      const userTurn: TranscriptTurn = {
        role: "user",
        uuid: null,
        timestamp: new Date().toISOString(),
        cwd: state.cwd,
        blocks,
      };
      return {
        ...state,
        turns: [...state.turns, userTurn],
        attachments: [],
        status: "sending",
        sendError: null,
        streamingText: "",
      };
    }
    case "delta":
      return { ...state, streamingText: event.text };
    case "sendDone": {
      const assistantTurn: TranscriptTurn = {
        role: "assistant",
        uuid: null,
        timestamp: new Date().toISOString(),
        cwd: state.cwd,
        blocks: [{ type: "text", text: event.text }],
      };
      return {
        ...state,
        turns: [...state.turns, assistantTurn],
        streamingText: null,
        status: "idle",
      };
    }
    case "sendFailed":
      return { ...state, streamingText: null, status: "idle", sendError: event.error };
    case "attachmentAdded":
      return { ...state, attachments: [...state.attachments, event.attachment] };
    case "attachmentRemoved":
      return { ...state, attachments: state.attachments.filter((_, i) => i !== event.index) };
    case "graphSnapshot":
      return { ...state, graphVersion: event.graph.version };
    case "inflightDetected":
      return {
        ...state,
        engineRunning: true,
        enginePartial: event.partialText,
        status: state.status === "sending" ? "sending" : "inflight",
      };
    case "inflightCleared":
      return {
        ...state,
        engineRunning: false,
        enginePartial: null,
        status: state.status === "inflight" ? "idle" : state.status,
      };
    default:
      return state;
  }
}

// ── Feedbacks (side effects) ────────────────────────────────────────────────

/** Read a File into a base64 attachment (image-only). */
export function fileToAttachment(file: File): Promise<Attachment | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve({
        media_type: file.type,
        data: comma >= 0 ? url.slice(comma + 1) : url,
        name: file.name || "image",
        dataUrl: url,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function fetchTranscript(sessionId: string): Promise<ConversationEvent> {
  try {
    const r = await fetch("/api/transcript?session=" + encodeURIComponent(sessionId));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = (await r.json()) as TranscriptReply;
    return { type: "transcriptLoaded", turns: json.turns, cwd: json.cwd };
  } catch (e) {
    return { type: "loadFailed", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Feedback (a): whenever a `loadRequested`-derived load is needed, GET the
 * transcript and emit `transcriptLoaded` / `loadFailed`.
 *
 * We express "a load is pending" as an explicit request-token queue rather
 * than deriving it from state, because a re-fetch can be triggered by several
 * causes (initial mount, an inflight node just finished, a send just settled)
 * and we don't want to entangle those into a single state flag. The system
 * exposes a `loadTrigger$` Subject the feedback listens on.
 */
export function loadFeedback(
  sessionId: string,
  loadTrigger$: Observable<void>,
): (state$: Observable<ConversationState>) => Observable<ConversationEvent> {
  return () =>
    loadTrigger$.pipe(switchMap(() => from(fetchTranscript(sessionId))));
}

/**
 * Feedback (b): whenever a `sendRequested` is dispatched, POST
 * /api/session-send and stream the SSE ReadableStream, emitting `delta` per
 * accumulated chunk and `sendDone` / `sendFailed` at the end. Uses the
 * `send$` Subject (fed by the reducer-side dispatch) carrying the request.
 */
export interface SendRequest {
  message: string;
  images: Array<{ media_type: string; data: string }>;
  sessionId: string;
  cwd: string | null;
}

function sendSSE(req: SendRequest): Observable<ConversationEvent> {
  return new Observable<ConversationEvent>((subscriber) => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/session-send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: req.sessionId,
            cwd: req.cwd ?? undefined,
            message: req.message,
            images: req.images,
          }),
        });
        if (!resp.ok || !resp.body) {
          const t = await resp.text().catch(() => "");
          throw new Error(t || "HTTP " + resp.status);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finalText = "";
        let done = false;
        while (!done && !cancelled) {
          const { value, done: rdDone } = await reader.read();
          if (rdDone) break;
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf("\n\n");
          while (nl >= 0) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (dataLine) {
              const payload = dataLine.slice(5).trim();
              try {
                const evt = JSON.parse(payload) as { type: string; text?: string; error?: string };
                if (evt.type === "delta") {
                  finalText = evt.text ?? finalText;
                  subscriber.next({ type: "delta", text: evt.text ?? "" });
                } else if (evt.type === "done") {
                  finalText = evt.text ?? finalText;
                  done = true;
                } else if (evt.type === "error") {
                  throw new Error(evt.error || "stream error");
                }
              } catch (e) {
                if (e instanceof Error && e.message !== payload) throw e;
              }
            }
            nl = buf.indexOf("\n\n");
          }
        }
        if (!cancelled) subscriber.next({ type: "sendDone", text: finalText });
        subscriber.complete();
      } catch (e) {
        if (!cancelled) {
          subscriber.next({ type: "sendFailed", error: e instanceof Error ? e.message : String(e) });
          subscriber.complete();
        }
      }
    })();
    return () => { cancelled = true; };
  });
}

export function sendFeedback(
  send$: Observable<SendRequest>,
): (state$: Observable<ConversationState>) => Observable<ConversationEvent> {
  // switchMap: a new send supersedes any in-flight one (there is only ever
  // one composer stream at a time).
  return () => send$.pipe(switchMap((req) => sendSSE(req).pipe(
    catchError((e) => of<ConversationEvent>({ type: "sendFailed", error: e instanceof Error ? e.message : String(e) })),
  )));
}

/**
 * Feedback (c): graph → in-flight detection. Given a stream of polled graph
 * snapshots, find a `running` node whose sessionId matches, and emit
 * `inflightDetected` (with its `output.partialText`) or `inflightCleared`.
 *
 * This is a state→event feedback: it reads the graph off state (fed in via
 * `graphSnapshot` events), so it's driven by the same reactive loop.
 */
export function inflightFeedback(
  sessionId: string,
  graph$: Observable<GraphSnapshot>,
): (state$: Observable<ConversationState>) => Observable<ConversationEvent> {
  return () =>
    graph$.pipe(
      map((graph) => {
        const running = graph.nodes.find(
          (n) => n.sessionId === sessionId && n.status === "running",
        );
        if (!running) return { running: false, partial: "" };
        const out = running.output as { partialText?: unknown } | null;
        const partial = typeof out?.partialText === "string" ? out.partialText : "";
        return { running: true, partial };
      }),
      // Only emit when the running-flag or the partial text actually changes.
      distinctUntilChanged((a, b) => a.running === b.running && a.partial === b.partial),
      mergeMap((s): Observable<ConversationEvent> =>
        s.running
          ? of<ConversationEvent>({ type: "inflightDetected", partialText: s.partial })
          : of<ConversationEvent>({ type: "inflightCleared" }),
      ),
    );
}

/**
 * A running conversation system bundles the RxFeedback loop with the external
 * Subjects the view pokes: `loadTrigger$` (request a transcript re-fetch),
 * `send$` (kick off a send), and `graph$` (feed a fresh graph snapshot). All
 * three are the effect inputs; events flow back through the reducer.
 */
export interface ConversationSystem extends RunningSystem<ConversationState, ConversationEvent> {
  requestLoad: () => void;
  requestSend: (req: SendRequest) => void;
  pushGraph: (graph: GraphSnapshot) => void;
}

export function createConversationSystem(sessionId: string, cwd: string | null): ConversationSystem {
  const loadTrigger$ = new Subject<void>();
  const send$ = new Subject<SendRequest>();
  const graph$ = new Subject<GraphSnapshot>();

  const running = makeSystem<ConversationState, ConversationEvent>(
    initialState(sessionId, cwd),
    reduce,
    [
      loadFeedback(sessionId, loadTrigger$),
      sendFeedback(send$),
      inflightFeedback(sessionId, graph$),
      // A tiny structural feedback: when a send is requested (from the view),
      // also drive it into send$ so the SSE feedback fires. The view calls
      // requestSend directly, so this is a no-op passthrough kept for shape.
      () => EMPTY,
    ],
  );

  return {
    ...running,
    requestLoad: () => loadTrigger$.next(),
    requestSend: (req) => send$.next(req),
    pushGraph: (graph) => graph$.next(graph),
  };
}
