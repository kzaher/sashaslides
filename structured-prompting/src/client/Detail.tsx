/**
 * Right-pane detail view for the currently-selected node. Shows status
 * + duration, a cost rollup line when the subtree contains any send,
 * the composed-prompt reveal (for send / askFollowup), retry button,
 * raw input/output JSON, and the ask-followup textarea.
 */
import { useMemo, useState } from "preact/hooks";
import type { GraphSnapshot } from "../api/wire.js";
import { fmtDur, computeRollup } from "./helpers.js";
import { ComposedPromptReveal } from "./ComposedPromptReveal.js";
import { RetryPanel } from "./RetryPanel.js";
import { AskPanel } from "./AskPanel.js";
import { InjectPanel } from "./InjectPanel.js";
import { JsonView } from "./JsonView.js";
import { LiveOutput } from "./LiveOutput.js";
import { Diff } from "./Diff.js";
import { ReactConversationBridge } from "./react/ReactBridge.js";
import { COMPOSER_TEXTAREA_ID } from "./react/ConversationApp.js";
import { findTaskRootId, collectTaskNodes } from "./react/TaskThread.js";

export function Detail(props: { graph: GraphSnapshot; selectedId: string; onSelect: (id: string) => void }) {
  const { graph, selectedId, onSelect } = props;
  const node = graph.nodes.find(n => n.id === selectedId);
  if (!node) return <h1>node gone</h1>;

  // Detail panel always shows duration as the primary metric (it's the
  // most universally informative). The dropdown's metric controls only
  // the tree column. Cost / token sums are shown alongside as a
  // separate line if any send descendant contributed.
  const { sumMap: durSumMap, selfMap: durSelfMap } = useMemo(
    () => computeRollup(graph.nodes, "durationMs"),
    [graph.version],
  );
  const { sumMap: usdSumMap } = useMemo(
    () => computeRollup(graph.nodes, "costUsd"),
    [graph.version],
  );
  const { sumMap: inSumMap } = useMemo(
    () => computeRollup(graph.nodes, "inputTokens"),
    [graph.version],
  );
  const { sumMap: outSumMap } = useMemo(
    () => computeRollup(graph.nodes, "outputTokens"),
    [graph.version],
  );
  const sumMs = durSumMap.get(node.id) ?? null;
  const selfMs = durSelfMap.get(node.id) ?? null;
  const showSelf = sumMs != null && selfMs != null && Math.abs(sumMs - selfMs) > 1;
  const usd = (usdSumMap.get(node.id) as number) || 0;
  const inT = (inSumMap.get(node.id) as number) || 0;
  const outT = (outSumMap.get(node.id) as number) || 0;

  // composedPrompt lives on output for finished sends AND on input
  // while still running (engine.materializeAndCall writes it BEFORE
  // awaiting the CLI). Same applies to askFollowup nodes.
  const carriesPrompt = node.kind === "send" || node.kind === "askFollowup";
  const composedFromOutput = carriesPrompt
    ? (node.output as { composedPrompt?: unknown } | null)?.composedPrompt
    : undefined;
  const composedFromInput = carriesPrompt
    ? (node.input as { composedPrompt?: unknown } | null)?.composedPrompt
    : undefined;
  const composed = typeof composedFromOutput === "string"
    ? composedFromOutput
    : typeof composedFromInput === "string" ? composedFromInput : null;

  // CLI command to load this send's model session for inspection (stamped on
  // the node output by the engine, via the driver). Lets you open the exact
  // conversation and check whether it actually carried prior history.
  const resumeCmdRaw = node.kind === "send"
    ? (node.output as { resumeCommand?: unknown } | null)?.resumeCommand
    : undefined;
  const resumeCmd = typeof resumeCmdRaw === "string" && resumeCmdRaw ? resumeCmdRaw : null;

  // Recover the session's cwd for follow-ups: the resumeCommand is
  // `(cd <cwd> && claude --resume <id>)`; also fall back to any cwd stamped
  // on the node's input/output.
  const cwdFromResume = resumeCmd
    ? (/\(cd\s+(.+?)\s+&&\s+claude/.exec(resumeCmd)?.[1] ?? null)
    : null;
  const cwdFromNode = (() => {
    const io = (node.output ?? node.input) as { cwd?: unknown } | null;
    return io && typeof io.cwd === "string" ? io.cwd : null;
  })();
  const sessionCwd = cwdFromResume ?? cwdFromNode;

  // The unified TASK thread is the detail body whenever the selected node lives
  // in a task subtree that contains at least one model session — including when
  // the selection is a NON-session node (executeShell / assert / structural), so
  // clicking a script card in the thread keeps the thread visible and just
  // marks that card. We resolve a representative session (the send nearest the
  // selection, else the last send in the task) as the composer target.
  const hasSession = !!node.sessionId && (node.kind === "send" || node.kind === "askFollowup");
  const threadSessionId = useMemo(() => {
    if (hasSession) return node.sessionId!;
    const taskRootId = findTaskRootId(graph.nodes, node.id, graph.rootId);
    const taskNodes = collectTaskNodes(graph.nodes, taskRootId);
    const sends = taskNodes.filter(n => (n.kind === "send" || n.kind === "askFollowup") && n.sessionId);
    if (sends.length === 0) return null;
    // Prefer the last send at or before the selected node in time; else the last.
    const selT = node.startedAt ?? node.createdAt;
    let pick = sends[sends.length - 1];
    for (const s of sends) {
      if ((s.startedAt ?? s.createdAt) <= selT) pick = s;
    }
    return pick.sessionId!;
  }, [graph.version, node.id, hasSession]);
  const showThread = !!threadSessionId;
  const [showRaw, setShowRaw] = useState(false);
  const focusComposer = () => {
    const el = document.getElementById(COMPOSER_TEXTAREA_ID);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); (el as HTMLTextAreaElement).focus(); }
  };

  if (showThread) {
    return (
      <div>
        <h1>{node.kind + " — " + node.label}</h1>
        <div class="meta">
          <span>status <b>{node.status}</b></span>
          <span>sum <b>{fmtDur(sumMs)}</b></span>
          {node.model && <span>model <b>{node.model}</b></span>}
          {node.sessionId && <span>session <b>{node.sessionId.slice(0, 8)}</b></span>}
          {!hasSession && <span style="color:var(--muted)">task thread</span>}
        </div>
        {(usd > 0 || inT > 0 || outT > 0) && (
          <div class="meta">
            <span>cost <b>{"$" + usd.toFixed(4)}</b></span>
            <span>in <b>{inT.toLocaleString()}</b> tok</span>
            <span>out <b>{outT.toLocaleString()}</b> tok</span>
          </div>
        )}
        <div style="display:flex;gap:10px;align-items:center;margin:6px 0 2px">
          <button
            onClick={focusComposer}
            style="background:#1f6feb;border:none;color:#fff;border-radius:6px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer"
            title="Scroll to and focus the conversation composer below."
          >↳ continue conversation</button>
          <button
            onClick={() => setShowRaw(v => !v)}
            class="revealBtn"
            style="margin-left:0"
          >{showRaw ? "hide raw node data" : "show raw node data"}</button>
        </div>
        {resumeCmd && (
          <div style="margin:2px 0 6px">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px">load session in CLI</div>
            <pre
              title="Click to select, then copy — opens this exact model session in the provider CLI."
              style={{
                userSelect: "all", cursor: "text", margin: "0", padding: "6px 10px",
                background: "#0d1117", border: "1px solid #30363d", borderRadius: "6px",
                color: "#58a6ff", overflow: "auto", fontSize: "12px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >{resumeCmd}</pre>
          </div>
        )}
        <ReactConversationBridge
          sessionId={threadSessionId!}
          cwd={sessionCwd}
          selectedNodeId={node.id}
          selectedPrompt={composed}
          graphSnapshot={graph}
          onSelect={onSelect}
        />
        {showRaw && (
          <div>
            {composed != null && <ComposedPromptReveal text={composed} />}
            {node.diff && <Diff diff={node.diff} />}
            <div class="sect"><h2>input</h2><pre><JsonView value={node.input} /></pre></div>
            <div class="sect"><h2>output</h2><pre><JsonView value={node.output} /></pre></div>
            {node.error && <div class="sect"><h2>error</h2><pre><JsonView value={node.error} /></pre></div>}
            <RetryPanel node={node} />
            <InjectPanel node={node} graph={graph} onSelect={onSelect} />
            <AskPanel node={node} graph={graph} onSelect={onSelect} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>{node.kind + " — " + node.label}</h1>
      <div class="meta">
        <span>status <b>{node.status}</b></span>
        <span>sum <b>{fmtDur(sumMs)}</b></span>
        {showSelf && <span>self <b>{fmtDur(selfMs)}</b></span>}
        {node.model && <span>model <b>{node.model}</b></span>}
        {node.sessionId && <span>session <b>{node.sessionId.slice(0, 8)}</b></span>}
      </div>
      {(usd > 0 || inT > 0 || outT > 0) && (
        <div class="meta">
          <span>cost <b>{"$" + usd.toFixed(4)}</b></span>
          <span>in <b>{inT.toLocaleString()}</b> tok</span>
          <span>out <b>{outT.toLocaleString()}</b> tok</span>
        </div>
      )}
      <LiveOutput node={node} />
      {composed != null && <ComposedPromptReveal text={composed} />}
      {resumeCmd && (
        <div class="sect">
          <h2>load session in CLI</h2>
          <pre
            title="Click to select, then copy — opens this exact model session in the provider CLI so you can read its real history."
            style={{
              userSelect: "all", cursor: "text", margin: "0", padding: "8px 10px",
              background: "#0d1117", border: "1px solid #30363d", borderRadius: "6px",
              color: "#58a6ff", overflow: "auto", fontSize: "12px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >{resumeCmd}</pre>
        </div>
      )}
      <RetryPanel node={node} />
      {node.diff && <Diff diff={node.diff} />}
      <div class="sect"><h2>input</h2><pre><JsonView value={node.input} /></pre></div>
      <div class="sect"><h2>output</h2><pre><JsonView value={node.output} /></pre></div>
      {node.error && <div class="sect"><h2>error</h2><pre><JsonView value={node.error} /></pre></div>}
      <InjectPanel node={node} graph={graph} onSelect={onSelect} />
      <AskPanel node={node} graph={graph} onSelect={onSelect} />
    </div>
  );
}
