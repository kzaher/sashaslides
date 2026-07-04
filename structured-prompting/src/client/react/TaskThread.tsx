/** @jsxImportSource react */
/**
 * TaskThread — the unified TASK-scoped activity timeline.
 *
 * Where ConversationApp used to render ONE claude session's transcript, this
 * renders the WHOLE task: every graph node in the selected node's task subtree,
 * ordered in time, each with a presentation appropriate to its kind:
 *
 *   • send / askFollowup → a labelled, collapsible conversation section that
 *     inlines that session's transcript (each send has its OWN sessionId — the
 *     fix / verify / fix-summary steps are DIFFERENT sessions). The selected
 *     send is expanded + marked + scrolled-to; the composer targets it.
 *   • executeShell → a terminal card (command + stdout/stderr mono block, exit
 *     badge, duration, live spinner while running).
 *   • assert → pass/fail badge + message.
 *   • structural containers (pipe / try / parallelFork / …) → compact chips.
 *   • prompt-mutators / switches / session ops → tiny inline chips.
 *
 * Everything stays reactive through the same RxFeedback graph feed: the parent
 * hands a fresh `graphSnapshot` every 250ms, we recompute the ordered node list
 * from it, and each send-section's transcript is fetched by a per-session cache
 * that only refetches when that send node flips running→ok (or on first view).
 */
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import type { GraphNode, GraphSnapshot, NodeKind, NodeStatus, TranscriptTurn } from "../../api/wire.js";
import { TurnView, MAX_W } from "./Turns.js";
import { ConversationDiff } from "./ConversationDiff.js";
import { extractFileChanges } from "./file-changes.js";

// ── task-subtree scoping ─────────────────────────────────────────────────────

/** Kinds that act as a "task boundary" — the per-worktree unit we scope to. */
const TASK_BOUNDARY_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "parallelChild",
]);

/** Any container kind — falls back to the nearest of these if no task boundary. */
const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "parallelChild", "parallelFork", "pipe", "combineWith", "try",
  "tryMultipleTimes", "tryAttempt", "tryFallback", "combineBranch", "root",
]);

/**
 * Walk up from `selectedId` via containerId (then parentId as a fallback) to the
 * task boundary — the nearest `parallelChild`. If none exists on the way up, use
 * the nearest container kind. If nothing qualifies, the root.
 */
export function findTaskRootId(nodes: GraphNode[], selectedId: string, rootId: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let boundary: string | null = null;
  let firstContainer: string | null = null;
  let cur: GraphNode | undefined = byId.get(selectedId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (TASK_BOUNDARY_KINDS.has(cur.kind)) { boundary = cur.id; break; }
    if (firstContainer == null && CONTAINER_KINDS.has(cur.kind) && cur.id !== rootId) {
      firstContainer = cur.id;
    }
    const nextId = cur.containerId ?? cur.parentId;
    cur = nextId ? byId.get(nextId) : undefined;
  }
  return boundary ?? firstContainer ?? rootId;
}

/**
 * Collect every node whose ancestor chain (containerId, then parentId) reaches
 * `taskRootId`. The task root itself is excluded from the timeline body (it's a
 * structural wrapper) but its direct descendants form the thread.
 */
export function collectTaskNodes(nodes: GraphNode[], taskRootId: string): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inTask = (n: GraphNode): boolean => {
    let cur: GraphNode | undefined = n;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.id === taskRootId) return true;
      seen.add(cur.id);
      const nextId = cur.containerId ?? cur.parentId;
      cur = nextId ? byId.get(nextId) : undefined;
    }
    return false;
  };
  return nodes
    .filter((n) => n.id !== taskRootId && inTask(n))
    .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
}

// ── per-session transcript cache (reactive) ──────────────────────────────────

interface SessionTranscript {
  turns: TranscriptTurn[];
  cwd: string | null;
  loaded: boolean;
  error: string | null;
}

/**
 * Fetch + cache one transcript per sessionId. `reloadKeys` maps sessionId → a
 * token that changes when that send node's status flips (running→ok), forcing a
 * refetch — otherwise we fetch a session ONCE and reuse it across polls.
 */
function useSessionTranscripts(
  sessions: Array<{ sessionId: string; reloadKey: string }>,
): Map<string, SessionTranscript> {
  const [cache, setCache] = useState<Map<string, SessionTranscript>>(() => new Map());
  // Track which (sessionId, reloadKey) pairs we've already kicked a fetch for,
  // so a 250ms re-render doesn't re-request an unchanged session.
  const fetchedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    for (const { sessionId, reloadKey } of sessions) {
      if (fetchedRef.current.get(sessionId) === reloadKey) continue;
      fetchedRef.current.set(sessionId, reloadKey);
      void (async () => {
        try {
          const r = await fetch("/api/transcript?session=" + encodeURIComponent(sessionId));
          if (!r.ok) throw new Error("HTTP " + r.status);
          const json = (await r.json()) as { turns: TranscriptTurn[]; cwd: string | null };
          if (!alive) return;
          setCache((prev) => {
            const next = new Map(prev);
            next.set(sessionId, { turns: json.turns, cwd: json.cwd, loaded: true, error: null });
            return next;
          });
        } catch (e) {
          if (!alive) return;
          setCache((prev) => {
            const next = new Map(prev);
            const existing = prev.get(sessionId);
            next.set(sessionId, {
              turns: existing?.turns ?? [], cwd: existing?.cwd ?? null,
              loaded: true, error: e instanceof Error ? e.message : String(e),
            });
            return next;
          });
        }
      })();
    }
    return () => { alive = false; };
    // Re-run when the set of (session,reloadKey) pairs changes.
  }, [sessions.map((s) => s.sessionId + ":" + s.reloadKey).join("|")]);

  return cache;
}

// ── presentation helpers ─────────────────────────────────────────────────────

const STATUS_COLOR: Record<NodeStatus, string> = {
  pending: "#6e7681", running: "#e3b341", ok: "#3fb950", error: "#f85149",
};

function fmtDur(started: number | null, finished: number | null): string {
  if (started == null) return "";
  const ms = (finished ?? Date.now()) - started;
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

function fmtClock(t: number | null): string {
  if (t == null) return "";
  try { return new Date(t).toLocaleTimeString(); } catch { return ""; }
}

/** True if the element is (at least partly) within the viewport — so we don't
 *  gratuitously scroll (the cause of the "click makes the page jump" bug).
 *  Mirrors ConversationApp.isInView. */
function isInView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
}

/** Callback that registers/unregisters a card's wrapper element into a nodeId→el
 *  registry, so the selection-scroll effect can find and reveal any card. */
type RegisterRef = (id: string) => (el: HTMLElement | null) => void;

/** The orange "selected" ring, shared across every card kind. */
const SELECTED_RING: React.CSSProperties = { boxShadow: "0 0 0 2px #d97757" };

function StatusDot({ status }: { status: NodeStatus }) {
  const c = STATUS_COLOR[status];
  const glow = status === "running" ? `, 0 0 6px ${c}` : "";
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: c, boxShadow: `0 0 0 1px ${c}66${glow}`, flexShrink: 0,
    }} className={status === "running" ? "cv-spinner" : undefined} />
  );
}

const cardWrap: React.CSSProperties = { margin: "10px auto", maxWidth: MAX_W, width: "100%" };

// ── executeShell terminal card ───────────────────────────────────────────────

function ShellCard({ node, marked, onSelect, registerRef }: { node: GraphNode; marked: boolean; onSelect: (id: string) => void; registerRef: RegisterRef }) {
  const out = (node.output ?? {}) as {
    cmd?: string; stdout?: string; stderr?: string; stdoutSoFar?: string;
    stderrSoFar?: string; stdoutTail?: string; exitCode?: number | null;
  };
  const err = node.error;
  const errData = (err?.data ?? {}) as { exitCode?: number | null; cmd?: string; stderrTail?: string };
  const cmd = out.cmd ?? errData.cmd
    ?? (node.label.startsWith("executeShell: ") ? node.label.slice("executeShell: ".length) : node.label);
  const running = node.status === "running";
  const stdout = out.stdout ?? out.stdoutSoFar ?? out.stdoutTail ?? "";
  const stderr = out.stderr ?? out.stderrSoFar ?? errData.stderrTail ?? "";
  const exit = out.exitCode ?? errData.exitCode ?? (node.status === "ok" ? 0 : null);
  const bodyLen = stdout.length + stderr.length;
  const [open, setOpen] = useState(bodyLen < 1200);
  const ring = marked ? SELECTED_RING : {};

  return (
    <div style={cardWrap} ref={registerRef(node.id)}>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          border: "1px solid #30363d", borderRadius: 8, overflow: "hidden",
          background: "#0a0e14", cursor: "pointer", ...ring,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#12161d", borderBottom: "1px solid #30363d" }}>
          <StatusDot status={node.status} />
          <span style={{ color: "#d2a8ff", fontSize: 12 }}>▶ terminal</span>
          <code style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11.5, color: "#e6edf3", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={cmd}>{cmd}</code>
          {exit != null && (
            <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px", background: exit === 0 ? "#132e1a" : "#3a0c0c", color: exit === 0 ? "#3fb950" : "#f85149" }}>exit {exit}</span>
          )}
          <span style={{ fontSize: 10, color: "#6e7681" }}>{fmtDur(node.startedAt, node.finishedAt)}</span>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            style={{ background: "transparent", border: "none", color: "#58a6ff", cursor: "pointer", fontSize: 11, padding: 0 }}
          >{open ? "▾" : "▸"}</button>
        </div>
        {open && (
          <pre style={{ margin: 0, padding: "8px 10px", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", overflow: "auto", maxHeight: "40vh", color: "#c9d1d9", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", background: "#0a0e14" }}>
            {stdout}
            {stderr && <span style={{ color: "#ffb3b3" }}>{(stdout ? "\n" : "") + stderr}</span>}
            {running && <span style={{ color: "#e3b341" }}>{(bodyLen ? "\n" : "") + "● running…"}</span>}
            {!bodyLen && !running && <span style={{ color: "#6e7681" }}>(no output)</span>}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── assert card ──────────────────────────────────────────────────────────────

function AssertCard({ node, marked, onSelect, registerRef }: { node: GraphNode; marked: boolean; onSelect: (id: string) => void; registerRef: RegisterRef }) {
  const ok = node.status === "ok";
  const failed = node.status === "error";
  const ring = marked ? SELECTED_RING : {};
  return (
    <div style={cardWrap} ref={registerRef(node.id)}>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 10px", cursor: "pointer",
          border: `1px solid ${failed ? "#f85149" : ok ? "#238636" : "#30363d"}`,
          borderRadius: 8, background: failed ? "#20090a" : ok ? "#0d1a10" : "#0d1117", ...ring,
        }}
      >
        <span style={{ fontSize: 14, color: failed ? "#f85149" : ok ? "#3fb950" : "#8b949e" }}>{failed ? "✗" : ok ? "✓" : "◔"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "#e6edf3" }}>
            <b>assert</b>{node.label && node.label !== "assert" ? " — " + node.label : ""}
            <span style={{ marginLeft: 8, fontSize: 10, color: "#6e7681" }}>{fmtDur(node.startedAt, node.finishedAt)}</span>
          </div>
          {failed && node.error && (
            <div style={{ fontSize: 11.5, color: "#ffb3b3", marginTop: 3, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{node.error.message}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── structural container chip ────────────────────────────────────────────────

function ContainerChip({ node, marked, onSelect, registerRef }: { node: GraphNode; marked: boolean; onSelect: (id: string) => void; registerRef: RegisterRef }) {
  const ring = marked ? SELECTED_RING : {};
  return (
    <div style={{ margin: "8px auto", maxWidth: MAX_W, width: "100%" }} ref={registerRef(node.id)}>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 7, padding: "3px 10px", cursor: "pointer",
          border: "1px dashed #30363d", borderRadius: 20, background: "#0d1117", fontSize: 11, color: "#8b949e", ...ring,
        }}
      >
        <StatusDot status={node.status} />
        <span style={{ color: "#c9d1d9", fontWeight: 600 }}>{node.kind}</span>
        <span style={{ color: "#6e7681" }}>{node.label && node.label !== node.kind ? node.label : ""}</span>
      </div>
    </div>
  );
}

// ── tiny inline chip (prompt mutators, switches, session ops) ─────────────────

const TINY_ICON: Partial<Record<NodeKind, string>> = {
  prependToNextPrompt: "⊕ prepend",
  appendToNextPrompt: "⊕ append",
  switchModel: "⇄ model",
  switchCwd: "⇄ cwd",
  newSession: "◇ new session",
  materializeError: "⚠ materialize",
  fork: "⑂ fork",
  compact: "⇲ compact",
};

function TinyChip({ node, marked, onSelect, registerRef }: { node: GraphNode; marked: boolean; onSelect: (id: string) => void; registerRef: RegisterRef }) {
  const ring = marked ? SELECTED_RING : {};
  const base = TINY_ICON[node.kind] ?? node.kind;
  let extra = "";
  if (node.kind === "switchModel" && node.model) extra = "→" + node.model;
  else if (node.label && node.label !== node.kind) extra = " " + node.label;
  return (
    <div style={{ margin: "4px auto", maxWidth: MAX_W, width: "100%" }} ref={registerRef(node.id)}>
      <span
        onClick={() => onSelect(node.id)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 8px", cursor: "pointer",
          borderRadius: 4, background: "#161b22", border: "1px solid #21262d", fontSize: 10.5,
          color: "#8b949e", fontFamily: "ui-monospace,Menlo,monospace", ...ring,
        }}
        title={node.kind + (node.error ? " — " + node.error.message : "")}
      >
        <StatusDot status={node.status} />{base}{extra}
      </span>
    </div>
  );
}

// ── conversation section (send / askFollowup) ────────────────────────────────

/**
 * A friendly, human step-title for a send/askFollowup section.
 *
 * The raw node label is a truncated prompt ("The BEFORE-state pptx…"), which is
 * meaningless as a conversation title. Derive a clear step name from the role the
 * prompt plays in a bug_solving task instead:
 *   • "The BEFORE-state pptx…"                 → "Apply fix"
 *   • "verifying the fix for slide_04" / "Read analysis.md" → "Verify slide_04" / "Verify"
 *   • "All per-slide verdicts…"                → "Write fix-summary"
 * Falls back to the (truncated) label only when nothing matches.
 */
function sendTitle(node: GraphNode): string {
  let raw = (node.label && node.label !== node.kind ? node.label : "").trim();
  if (!raw) return node.kind === "askFollowup" ? "Follow-up" : "Send";
  // The node label is prefixed with the kind ("send: …" / "askFollowup: …") and
  // uses the prompt's own casing — strip that prefix before matching, otherwise
  // every `lc.startsWith(...)` below misses on the "send: " lead-in.
  raw = raw.replace(/^(send|askfollowup)\s*:\s*/i, "").trim();
  const lc = raw.toLowerCase();

  // Try to pull a slide id (slide_NN / slide NN) out of the text for verify steps.
  const slideMatch = raw.match(/slide[_\s-]?(\d+)/i);
  const slide = slideMatch ? "slide_" + slideMatch[1] : "";

  if (lc.includes("before-state pptx") || lc.includes("apply the fix") || lc.includes("apply fix")) {
    return "Apply fix";
  }
  if (lc.includes("all per-slide verdicts") || lc.includes("fix-summary") || lc.includes("fix summary") || lc.includes("write /works")) {
    return "Write fix-summary";
  }
  if (lc.includes("verifying the fix") || lc.includes("verify the fix") || lc.includes("read analysis.md") || lc.startsWith("verify")) {
    return slide ? "Verify " + slide : "Verify";
  }
  // Generic slide-scoped step.
  if (slide) return "Step — " + slide;
  // Last resort: NEVER show the truncated prompt text — use a neutral label.
  return "Model step";
}

function ConversationSection({
  node, transcript, marked, expanded, onToggle, onSelect, markedTurnRef, selectedPrompt, registerRef,
}: {
  node: GraphNode;
  transcript: SessionTranscript | undefined;
  marked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  markedTurnRef: (el: HTMLDivElement | null) => void;
  selectedPrompt: string | null;
  registerRef: RegisterRef;
}) {
  const turns = transcript?.turns ?? [];
  const sid = node.sessionId ?? "";
  const running = node.status === "running";
  const enginePartial = (() => {
    const out = node.output as { partialText?: unknown } | null;
    return typeof out?.partialText === "string" ? out.partialText : "";
  })();

  // Locate the marked turn inside THIS section (the selected send's prompt).
  const markedIdx = useMemo(() => {
    if (!marked || !selectedPrompt) return -1;
    const needle = selectedPrompt.trim();
    if (!needle) return -1;
    let exact = -1, contains = -1;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.role !== "user") continue;
      const text = t.blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
      if (!text) continue;
      if (text === needle) exact = i; else if (text.includes(needle) || needle.includes(text)) contains = i;
    }
    return exact >= 0 ? exact : contains;
  }, [marked, selectedPrompt, turns]);

  const diffsAfter = useMemo(() => turns.map((t) => extractFileChanges(t.blocks)), [turns]);

  // Split the transcript into (a) the SENT MESSAGE — the first user turn that
  // carries actual prompt text (not a tool_result-only turn) — which stays
  // ALWAYS visible, and (b) the rest (Claude's response / thinking / tool_use /
  // tool_result turns + inter-message diffs) which the header toggle collapses.
  const sentIdx = useMemo(() => {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.role !== "user") continue;
      if (t.blocks.every((b) => b.type === "tool_result")) continue;
      return i;
    }
    return -1;
  }, [turns]);

  // The whole section is enclosed by a SINGLE orange border when marked (the
  // "◆ this step" mark). Unmarked sections use the neutral gray outline. The
  // internal message→actions split is shown by a horizontal divider only.
  const outlineColor = marked ? "#d97757" : "#30363d";
  const outline: React.CSSProperties = marked
    ? { border: "1px solid #d97757", boxShadow: "0 0 12px 2px rgba(217,119,87,0.30)" }
    : { border: "1px solid #30363d" };

  return (
    <div
      ref={registerRef(node.id)}
      style={{
        margin: "12px auto", maxWidth: MAX_W, width: "100%", boxSizing: "border-box",
        height: "auto", borderRadius: 10, overflow: "hidden", background: "#0d1117", ...outline,
      }}
    >
      {/* Header row — toggles the STEPS (Claude actions) below the message. */}
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer",
          background: marked ? "rgba(217,119,87,0.10)" : "#12161d",
        }}
      >
        <StatusDot status={node.status} />
        <span style={{ fontSize: 13 }}>💬</span>
        <span style={{ fontSize: 12.5, color: "#e6edf3", fontWeight: 600 }} title={node.label}>{sendTitle(node)}</span>
        <span style={{ flex: 1 }} />
        {sid && <span style={{ fontSize: 10.5, color: "#6e7681", fontFamily: "ui-monospace,Menlo,monospace" }}>session {sid.slice(0, 8)}</span>}
        {node.model && <span style={{ fontSize: 10, color: "#8b949e" }}>· {node.model}</span>}
        <span style={{ fontSize: 10, color: "#6e7681" }}>· {fmtDur(node.startedAt, node.finishedAt)}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          title={expanded ? "collapse steps" : "expand steps"}
          style={{ background: "transparent", border: "none", color: "#58a6ff", cursor: "pointer", fontSize: 12, padding: 0 }}
        >{expanded ? "▾" : "▸"}</button>
      </div>

      {/* The SENT MESSAGE — always visible, regardless of collapse state. */}
      <div style={{ padding: "6px 10px 10px", background: "#0d1117" }}>
        {!transcript?.loaded && <div style={{ color: "#8b949e", padding: 12, fontSize: 12 }}>loading conversation…</div>}
        {transcript?.error && <div style={{ color: "#f85149", padding: 8, fontSize: 12 }}>transcript error: {transcript.error}</div>}
        {transcript?.loaded && turns.length === 0 && !transcript.error && !running && (
          <div style={{ color: "#8b949e", padding: 12, fontSize: 12 }}>No transcript on disk for this session yet.</div>
        )}
        {sentIdx >= 0 && (
          <TurnView
            turn={turns[sentIdx]}
            marked={sentIdx === markedIdx}
            innerRef={sentIdx === markedIdx ? markedTurnRef : undefined}
            noRing
          />
        )}
      </div>

      {/* The CLAUDE ACTIONS — everything after the sent message. Collapsible via
          the header toggle; delimited from the message by a single horizontal
          divider along the bottom of the message. Same bg, no extra box. */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${outlineColor}`, padding: "6px 10px 10px", background: "#0d1117" }}>
          {/* A file-change diff produced right after the sent prompt belongs in
              the actions area (the message itself is hoisted out above). */}
          {sentIdx >= 0 && sentIdx < turns.length - 1 && diffsAfter[sentIdx].length > 0 && (
            <ConversationDiff changes={diffsAfter[sentIdx]} />
          )}
          {turns.map((turn, i) => {
            if (i === sentIdx) return null;
            return (
              <div key={i}>
                <TurnView
                  turn={turn}
                  marked={i === markedIdx}
                  innerRef={i === markedIdx ? markedTurnRef : undefined}
                />
                {i < turns.length - 1 && diffsAfter[i].length > 0 && <ConversationDiff changes={diffsAfter[i]} />}
              </div>
            );
          })}
          {running && (
            <div style={{ display: "flex", gap: 10, margin: "10px 0" }}>
              <div style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 6, background: "#d97757", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#fff", fontWeight: 600 }}>✳</div>
              <div style={{ flex: 1, minWidth: 0, color: "#e6edf3" }}>
                <div style={{ fontSize: 11, color: "#e3b341", marginBottom: 4 }}>● the engine is driving this session…</div>
                {enginePartial
                  ? <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55, fontFamily: "inherit", color: "#e6edf3" }}>{enginePartial}</pre>
                  : <span style={{ color: "#8b949e" }}>waiting for first token…</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── the timeline ─────────────────────────────────────────────────────────────

export interface TaskThreadProps {
  graphSnapshot: GraphSnapshot;
  selectedNodeId: string;
  selectedPrompt: string | null;
  /** the selected send's sessionId (the composer targets this session). */
  selectedSessionId: string;
  onSelect: (id: string) => void;
  /** ref-setter for the marked turn element (parent scrolls it into view). */
  markedTurnRef: (el: HTMLDivElement | null) => void;
}

export function TaskThread(props: TaskThreadProps): React.ReactElement {
  const { graphSnapshot, selectedNodeId, selectedPrompt, onSelect, markedTurnRef } = props;
  const nodes = graphSnapshot.nodes;

  const taskRootId = useMemo(
    () => findTaskRootId(nodes, selectedNodeId, graphSnapshot.rootId),
    [nodes, selectedNodeId, graphSnapshot.rootId],
  );
  const timeline = useMemo(() => collectTaskNodes(nodes, taskRootId), [nodes, taskRootId, graphSnapshot.version]);

  // The set of send/askFollowup sessions in this task, keyed by reload-token
  // (sessionId + status) so a running→ok flip refetches exactly that session.
  const sessionKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ sessionId: string; reloadKey: string }> = [];
    for (const n of timeline) {
      if ((n.kind === "send" || n.kind === "askFollowup") && n.sessionId && !seen.has(n.sessionId)) {
        seen.add(n.sessionId);
        out.push({ sessionId: n.sessionId, reloadKey: n.status });
      }
    }
    return out;
  }, [timeline]);

  const transcripts = useSessionTranscripts(sessionKeys);

  // ── node-card ref registry ────────────────────────────────────────────────
  // EVERY rendered card (send section, shell, assert, container, tiny) registers
  // its wrapper element here keyed by node.id, so the selection-scroll effect can
  // find and reveal ANY selected node's card — not just send sections.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerRef = useCallback<RegisterRef>((id) => (el) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // When the selection changes (any node clicked in the left tree) — or when a
  // fresh graph snapshot may have just mounted that node's card — scroll the
  // selected node's card into view GENTLY: only if it's off-screen, and with
  // block:"nearest" so an in-flow reveal never yanks the page to center. Run
  // after layout (rAF) so a just-mounted ref is already registered.
  useEffect(() => {
    let raf = 0;
    raf = requestAnimationFrame(() => {
      const el = cardRefs.current.get(selectedNodeId);
      if (el && !isInView(el)) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedNodeId, graphSnapshot.version]);

  // Per-section expand/collapse state. Default: the SELECTED send expanded,
  // everything else collapsed. Toggling is remembered per node id.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isExpanded = useCallback((node: GraphNode): boolean => {
    if (node.id in overrides) return overrides[node.id];
    return node.id === selectedNodeId;
  }, [overrides, selectedNodeId]);
  const toggle = useCallback((id: string, cur: boolean) => {
    setOverrides((prev) => ({ ...prev, [id]: !cur }));
  }, []);

  if (timeline.length === 0) {
    return <div style={{ color: "#8b949e", textAlign: "center", padding: 20 }}>no task activity yet…</div>;
  }

  return (
    <>
      {timeline.map((node) => {
        const marked = node.id === selectedNodeId;
        switch (node.kind) {
          case "send":
          case "askFollowup": {
            const expanded = isExpanded(node);
            return (
              <ConversationSection
                key={node.id}
                node={node}
                transcript={node.sessionId ? transcripts.get(node.sessionId) : undefined}
                marked={marked}
                expanded={expanded}
                onToggle={() => toggle(node.id, expanded)}
                onSelect={onSelect}
                markedTurnRef={marked ? markedTurnRef : () => {}}
                selectedPrompt={props.selectedPrompt}
                registerRef={registerRef}
              />
            );
          }
          case "executeShell":
            return <ShellCard key={node.id} node={node} marked={marked} onSelect={onSelect} registerRef={registerRef} />;
          case "assert":
            return <AssertCard key={node.id} node={node} marked={marked} onSelect={onSelect} registerRef={registerRef} />;
          case "pipe":
          case "combineWith":
          case "parallelFork":
          case "parallelChild":
          case "try":
          case "tryMultipleTimes":
          case "tryAttempt":
          case "tryFallback":
          case "combineBranch":
            return <ContainerChip key={node.id} node={node} marked={marked} onSelect={onSelect} registerRef={registerRef} />;
          default:
            return <TinyChip key={node.id} node={node} marked={marked} onSelect={onSelect} registerRef={registerRef} />;
        }
      })}
    </>
  );
}
