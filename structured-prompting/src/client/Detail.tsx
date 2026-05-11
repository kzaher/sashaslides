/**
 * Right-pane detail view for the currently-selected node. Shows status
 * + duration, a cost rollup line when the subtree contains any send,
 * the composed-prompt reveal (for send / askFollowup), retry button,
 * raw input/output JSON, and the ask-followup textarea.
 */
import { useMemo } from "preact/hooks";
import type { GraphSnapshot } from "../api/wire.js";
import { fmtDur, computeRollup } from "./helpers.js";
import { ComposedPromptReveal } from "./ComposedPromptReveal.js";
import { RetryPanel } from "./RetryPanel.js";
import { AskPanel } from "./AskPanel.js";
import { JsonView } from "./JsonView.js";
import { LiveOutput } from "./LiveOutput.js";

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
      <RetryPanel node={node} />
      <div class="sect"><h2>input</h2><pre><JsonView value={node.input} /></pre></div>
      <div class="sect"><h2>output</h2><pre><JsonView value={node.output} /></pre></div>
      {node.error && <div class="sect"><h2>error</h2><pre><JsonView value={node.error} /></pre></div>}
      <AskPanel node={node} graph={graph} onSelect={onSelect} />
    </div>
  );
}
