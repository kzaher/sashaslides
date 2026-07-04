/** @jsxImportSource react */
/**
 * ConversationApp — REAL React 18 conversation viewer, driven by an
 * RxFeedback (RxJS) state system (see ./conversation-system.ts).
 *
 * Behaviour ported 1:1 from the previous preact ConversationView, plus
 * click-to-mark-and-focus: the selected send node's message is highlighted
 * ("◆ this step") and scrolled into view on mount / whenever the selection
 * changes.
 *
 * Mounted INTO the preact monitor by Detail.tsx via a react-dom/client root
 * (see the bridge in Detail.tsx). This file is compiled with the React JSX
 * runtime thanks to the jsx-import-source react pragma above, while the rest
 * of the client stays preact.
 */
import { useRef, useEffect, useCallback, useState } from "react";
import type { GraphSnapshot } from "../../api/wire.js";
import {
  createConversationSystem,
  fileToAttachment,
  type ConversationSystem,
  type ConversationState,
  type Attachment,
} from "./conversation-system.js";
import { useObservableState } from "./useSystem.js";
import { Markdown } from "./Markdown.js";
import { MAX_W } from "./Turns.js";
import { TaskThread } from "./TaskThread.js";

/** Stable DOM id for the composer textarea — Detail.tsx focuses this. */
export const COMPOSER_TEXTAREA_ID = "cv-composer-textarea";

/** True if the element is (at least partly) within the viewport — so we don't
 *  gratuitously scroll (the cause of the "click makes the page jump" bug). */
function isInView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
}

export interface ConversationAppProps {
  sessionId: string;
  cwd: string | null;
  /** id of the selected graph node (for remount identity / marking). */
  selectedNodeId: string;
  /** the selected send's composedPrompt / input.prompt — used to locate the
   *  matching transcript turn to mark + focus. */
  selectedPrompt: string | null;
  /** latest polled graph snapshot (parent App polls /api/graph @250ms). */
  graphSnapshot: GraphSnapshot;
  /** select a node in the tree (clicking a card in the thread marks+focuses it). */
  onSelect: (id: string) => void;
}

export function ConversationApp(props: ConversationAppProps): React.ReactElement {
  const { sessionId, cwd, selectedNodeId, selectedPrompt, graphSnapshot, onSelect } = props;

  // Create the RxFeedback system ONCE per mount (Detail keys on nodeId, so a
  // node switch remounts this component and rebuilds the system fresh).
  const systemRef = useRef<ConversationSystem | null>(null);
  if (systemRef.current === null) {
    systemRef.current = createConversationSystem(sessionId, cwd);
  }
  const system = systemRef.current;
  useEffect(() => () => system.unsubscribe(), [system]);

  const state = useObservableState<ConversationState>(system.state$, () => ({
    sessionId, cwd, turns: [], status: "idle", loaded: false, loadError: null,
    sendError: null, streamingText: null, enginePartial: null, attachments: [],
    graphVersion: -1, engineRunning: false,
  }));

  // Kick the initial transcript load once, on mount.
  useEffect(() => { system.requestLoad(); }, [system]);

  // Feed each fresh graph snapshot into the system so the inflight feedback
  // can detect a running node for this session. When such a node transitions
  // running→done, re-load the transcript to capture the finalized turn.
  const wasEngineRunning = useRef(false);
  useEffect(() => {
    system.pushGraph(graphSnapshot);
  }, [system, graphSnapshot.version]);
  useEffect(() => {
    if (wasEngineRunning.current && !state.engineRunning) system.requestLoad();
    wasEngineRunning.current = state.engineRunning;
  }, [system, state.engineRunning]);

  // Local composer draft (kept in React, not the system — pure UI text).
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef<HTMLDivElement | null>(null);

  const busy = state.status === "sending" || state.engineRunning;

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const results = await Promise.all(arr.map(fileToAttachment));
    for (const a of results) if (a) system.dispatch({ type: "attachmentAdded", attachment: a });
  }, [system]);

  const send = useCallback(() => {
    const message = draft.trim();
    if ((!message && state.attachments.length === 0) || busy) return;
    const images = state.attachments.map((a) => ({ media_type: a.media_type, data: a.data }));
    // Reducer appends the optimistic user turn + clears attachments.
    system.dispatch({ type: "sendRequested", message, images: state.attachments });
    // Fire the SSE effect.
    system.requestSend({ message, images, sessionId, cwd: state.cwd });
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [draft, state.attachments, state.cwd, busy, system, sessionId]);

  // Follow new streamed content — but ONLY if the user is already near the
  // bottom, so it never yanks them down while they're reading higher up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [state.streamingText]);

  // ── click-to-mark-and-focus ──────────────────────────────────────────────
  // The marked turn now lives inside the selected send's conversation section
  // (TaskThread wires the ref down). Scroll it into view whenever the selection
  // changes (once the section's transcript has loaded — graphVersion advances).
  const setMarkedTurnRef = useCallback((el: HTMLDivElement | null) => {
    markedRef.current = el;
    if (el && !isInView(el)) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  useEffect(() => {
    const el = markedRef.current;
    if (el && !isInView(el)) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedNodeId]);

  const avatar = (
    <div style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 6, background: "#d97757", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#fff", fontWeight: 600 }}>✳</div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 130px)", minHeight: 400 }}>
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: "auto", padding: "8px 4px 16px" }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files); }}
      >
        {/* The whole TASK's activity timeline: model conversations interleaved
            with executeShell terminals, asserts, and structural chips. Reactive
            through the graph snapshot fed on every 250ms poll. */}
        <TaskThread
          graphSnapshot={graphSnapshot}
          selectedNodeId={selectedNodeId}
          selectedPrompt={selectedPrompt}
          selectedSessionId={sessionId}
          onSelect={onSelect}
          markedTurnRef={setMarkedTurnRef}
        />
        {/* Composer-initiated streaming response (targets the selected session). */}
        {state.streamingText != null && !state.engineRunning && (
          <div style={{ display: "flex", gap: 10, margin: "14px auto", maxWidth: MAX_W, width: "100%" }}>
            {avatar}
            <div style={{ flex: 1, minWidth: 0, color: "#e6edf3" }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
                <span className="cv-spinner">◐</span> Claude is responding…
              </div>
              {state.streamingText ? <Markdown src={state.streamingText} /> : <span style={{ color: "#8b949e" }}>…</span>}
            </div>
          </div>
        )}
        {state.sendError && <div style={{ color: "#f85149", margin: "8px auto", maxWidth: MAX_W }}>send error: {state.sendError}</div>}
      </div>

      {/* Sticky composer */}
      <div style={{ borderTop: "1px solid #30363d", padding: "8px 4px 4px", background: dragOver ? "#132a4a" : "transparent" }}>
        {state.attachments.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 6px", width: "100%", boxSizing: "border-box" }}>
            {state.attachments.map((a: Attachment, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={a.dataUrl} style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 6, border: "1px solid #30363d" }} title={a.name} />
                <button
                  onClick={() => system.dispatch({ type: "attachmentRemoved", index: i })}
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", background: "#f85149", color: "#fff", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
                  title="remove"
                >×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", margin: 0, width: "100%", boxSizing: "border-box" }}>
          <label
            style={{ flexShrink: 0, cursor: "pointer", color: "#8b949e", border: "1px solid #30363d", borderRadius: 8, padding: "8px 10px", fontSize: 15, background: "#161b22" }}
            title="attach image"
          >
            📎
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files; if (f) void addFiles(f); e.target.value = ""; }}
            />
          </label>
          <textarea
            id={COMPOSER_TEXTAREA_ID}
            ref={textareaRef}
            value={draft}
            placeholder={busy ? "waiting for the current response to settle…" : "Continue the conversation… (Enter to send, Shift+Enter for newline; paste or drop images to attach)"}
            rows={1}
            disabled={busy}
            onChange={(e) => {
              const ta = e.target;
              setDraft(ta.value);
              ta.style.height = "auto";
              ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const it of Array.from(items)) {
                if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
              }
              if (files.length) { e.preventDefault(); void addFiles(files); }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            style={{ flex: 1, minWidth: 0, boxSizing: "border-box", background: "#0d1117", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 10, padding: "9px 12px", font: "inherit", fontSize: 13, resize: "none", lineHeight: 1.5, maxHeight: 200, overflow: "auto" }}
          />
          <button
            onClick={send}
            disabled={busy || (!draft.trim() && state.attachments.length === 0)}
            style={{ flexShrink: 0, border: "none", borderRadius: 10, padding: "9px 16px", font: "inherit", fontSize: 13, cursor: busy ? "default" : "pointer", background: busy || (!draft.trim() && state.attachments.length === 0) ? "#30363d" : "#1f6feb", color: "#fff" }}
          >{state.status === "sending" ? "…" : "Send"}</button>
        </div>
        <div style={{ margin: "4px 0 0", width: "100%", boxSizing: "border-box", fontSize: 10, color: "#6e7681" }}>
          continues session <b>{sessionId.slice(0, 8)}</b> (resume, no fork){state.cwd ? " · cwd " + state.cwd : ""}
        </div>
      </div>
    </div>
  );
}
