/**
 * Pure helpers shared across the monitor UI: duration formatting, the
 * per-row METRICS dropdown, per-node metric extraction, and the
 * subtree-rollup function used by both the tree column and the detail
 * panel sums.
 */
import type { GraphNode } from "../api/wire.js";

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

export interface MetricDef {
  id: string;
  label: string;
  fmt: (v: number | null | undefined) => string;
}

/**
 * Per-node metric formatters. Each metric appears in the tree-column
 * dropdown, the per-row column, and the detail-panel sum. costUsd uses 4
 * decimals so a $0.0042 send doesn't round to "$0".
 */
export const METRICS: MetricDef[] = [
  { id: "durationMs",        label: "duration (s)",   fmt: (v) => fmtDur(v) },
  { id: "costUsd",           label: "cost (USD)",     fmt: (v) => v == null ? "—" : "$" + Number(v).toFixed(4) },
  { id: "inputTokens",       label: "input tokens",   fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
  { id: "outputTokens",      label: "output tokens",  fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
  { id: "cacheReadTokens",   label: "cache-read tok", fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
  { id: "cacheCreateTokens", label: "cache-write tok",fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
];

/**
 * Per-node value for a given metric. Sends carry the entire token + USD
 * payload on `output.usage`; non-send nodes return 0 except for duration
 * (always wall-time of self).
 */
export function nodeValue(node: GraphNode, metric: string): number | null {
  if (metric === "durationMs") {
    if (node.startedAt == null) return null;
    return (node.finishedAt ?? Date.now()) - node.startedAt;
  }
  const out = node.output as { usage?: Record<string, number> } | null;
  const u = out && out.usage;
  if (!u) return 0;
  switch (metric) {
    case "costUsd":           return u.costUsd ?? 0;
    case "inputTokens":       return u.inputTokens ?? 0;
    case "outputTokens":      return u.outputTokens ?? 0;
    case "cacheReadTokens":   return u.cacheReadInputTokens ?? 0;
    case "cacheCreateTokens": return u.cacheCreationInputTokens ?? 0;
  }
  return 0;
}

/**
 * Roll up a single metric over the visible-tree subtree of every node.
 * Subtree relation is `containerId === parent.id`, matching the lexical
 * lambda nesting the UI displays — rollups for a parallelFork sum across
 * all parallelChildren, etc.
 *
 * For duration the rollup is the elapsed wall-time of the node itself;
 * `selfMap` subtracts the union of children's intervals so a parallel fork
 * that spends 10 s in 7 children doesn't double-count. For tokens and USD
 * the rollup is a plain SUM (every send's contribution is real spend, no
 * parallel-discount).
 */
export function computeRollup(nodes: GraphNode[], metric: string) {
  const sumMap = new Map<string, number | null>();
  const selfMap = new Map<string, number | null>();
  const byContainer = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const c = n.containerId == null ? "__root__" : n.containerId;
    if (!byContainer.has(c)) byContainer.set(c, []);
    byContainer.get(c)!.push(n);
  }
  const now = Date.now();

  function durSum(node: GraphNode): number | null {
    return node.finishedAt != null && node.startedAt != null
      ? node.finishedAt - node.startedAt
      : (node.startedAt != null ? now - node.startedAt : null);
  }

  // Recursive sum over the subtree (visible children = nodes whose
  // containerId === this node's id). Cache to avoid re-walking shared
  // ancestors.
  const cache = new Map<string, number>();
  function subtreeSum(node: GraphNode): number {
    if (cache.has(node.id)) return cache.get(node.id)!;
    const own = nodeValue(node, metric) ?? 0;
    let sum = typeof own === "number" ? own : 0;
    const kids = byContainer.get(node.id) || [];
    for (const k of kids) {
      if (k.id === node.id) continue;
      sum += subtreeSum(k);
    }
    cache.set(node.id, sum);
    return sum;
  }

  for (const n of nodes) {
    if (metric === "durationMs") {
      const wall = durSum(n);
      sumMap.set(n.id, wall);
      const kids = (byContainer.get(n.id) || []).filter(c => c.id !== n.id && c.startedAt != null);
      if (kids.length === 0) { selfMap.set(n.id, wall); continue; }
      const intervals = kids
        .map(c => [c.startedAt!, c.finishedAt == null ? now : c.finishedAt] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      let unionLen = 0;
      let curS = intervals[0][0];
      let curE = intervals[0][1];
      for (let i = 1; i < intervals.length; i++) {
        const [s, e] = intervals[i];
        if (s <= curE) curE = Math.max(curE, e);
        else { unionLen += (curE - curS); curS = s; curE = e; }
      }
      unionLen += (curE - curS);
      selfMap.set(n.id, wall == null ? null : Math.max(0, wall - unionLen));
    } else {
      sumMap.set(n.id, subtreeSum(n));
      const own = nodeValue(n, metric);
      selfMap.set(n.id, typeof own === "number" ? own : 0);
    }
  }
  return { sumMap, selfMap };
}
