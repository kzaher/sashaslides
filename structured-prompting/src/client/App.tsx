/**
 * App root: polls `/api/graph` every 250 ms, holds local UI state
 * (selection, collapse set, metric choice), and lays out tree + detail
 * panes side-by-side.
 *
 * Connection-loss handling: a single failed poll might be transient (a
 * 250 ms tick that crossed a brief restart). After N consecutive
 * failures we surface a full-width red banner above the tree so the
 * reviewer notices that the displayed graph is FROZEN — the server
 * died, this snapshot is no longer live. Without that, you'd think
 * "running" nodes were still working when really nothing is.
 */
import { useState, useEffect, useMemo, useCallback } from "preact/hooks";
import type { GraphSnapshot } from "../api/wire.js";
import { METRICS, computeRollup } from "./helpers.js";
import { TreeNode } from "./Tree.js";
import { Detail } from "./Detail.js";

// Threshold of consecutive failed polls before we show the "server
// dead" banner. Set to 1 — surface immediately. The cost of a false
// positive (one transient hiccup → banner flashes for 250 ms) is
// trivially small compared to the cost of staring at frozen "running"
// nodes wondering why nothing's moving.
const DEAD_POLL_THRESHOLD = 1;

function fmtAge(ms: number): string {
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  if (ms < 3600_000) return Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s";
  return Math.floor(ms / 3600_000) + "h " + Math.floor((ms % 3600_000) / 60_000) + "m";
}

export function App() {
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [connErr, setConnErr] = useState<string | null>(null);
  // Consecutive failed polls + timestamp of last success. We surface the
  // banner only after DEAD_POLL_THRESHOLD failures so a 250 ms restart
  // blip doesn't flash a scary warning.
  const [failCount, setFailCount] = useState(0);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  // Tick `now` every second so the "stale Xs ago" counter updates while
  // the server is dead. Cheap; only triggers when the banner is visible.
  const [now, setNow] = useState(() => Date.now());
  // Selected per-row rollup metric. Default to wall-clock duration —
  // most universally meaningful; the dropdown lets the reviewer switch
  // to USD or token-class views to spot-check cost.
  const [metricId, setMetricId] = useState("durationMs");
  const metric = METRICS.find(m => m.id === metricId) || METRICS[0];

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const r = await fetch("/api/graph");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const g = await r.json() as GraphSnapshot;
        setGraph(g);
        setConnErr(null);
        setFailCount(0);
        setLastSuccessAt(Date.now());
      } catch (e) {
        setConnErr(String(e && (e as Error).message ? (e as Error).message : e));
        setFailCount(c => c + 1);
      }
      if (alive) setTimeout(tick, 250);
    };
    void tick();
    return () => { alive = false; };
  }, []);

  // Refresh the "stale Xs ago" counter once a second while the banner
  // is visible. No-op when polling is healthy.
  const serverDead = failCount >= DEAD_POLL_THRESHOLD;
  useEffect(() => {
    if (!serverDead) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [serverDead]);

  const { sumMap, selfMap } = useMemo(
    () => graph ? computeRollup(graph.nodes, metricId) : { sumMap: new Map(), selfMap: new Map() },
    [graph && graph.version, metricId],
  );

  const onToggleCollapsed = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    if (!graph) return;
    const parents = new Set<string>();
    for (const n of graph.nodes) {
      if ((n.parentId || "") !== "" && n.parentId !== graph.rootId) parents.add(n.parentId!);
    }
    const next = new Set<string>();
    for (const id of parents) if (id !== graph.rootId) next.add(id);
    setCollapsed(next);
  }, [graph && graph.version]);

  const rootNode = graph ? graph.nodes.find(n => n.id === graph.rootId) ?? null : null;

  // Server-dead banner: full-width red bar above the layout. Only shown
  // after DEAD_POLL_THRESHOLD consecutive failed polls so transient
  // hiccups don't flash a scary warning. Carries the underlying error
  // (e.g. "Failed to fetch") plus how long ago the last successful
  // update arrived — at-a-glance signal that the displayed graph is
  // FROZEN and any "running" nodes are ghosts.
  const banner = serverDead ? (
    <div style="background:#5a1d1d;border-bottom:2px solid #f85149;color:#ffdcdc;padding:10px 16px;font-size:13px;line-height:1.5">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">⚠</span>
        <b style="color:#fff">Monitor server unreachable — engine likely died.</b>
        <span style="color:#ffb3b3">{"(" + failCount + " failed polls, " + connErr + ")"}</span>
      </div>
      <div style="margin-top:4px;color:#ffd0d0">
        Showing the last snapshot from <b>{lastSuccessAt ? fmtAge(now - lastSuccessAt) + " ago" : "before this page loaded"}</b>.
        Any nodes shown as <code style="background:#3a0c0c;padding:1px 4px;border-radius:2px">running</code> are ghosts — nothing is actually executing.
        The server has to be restarted (the engine process exited).
      </div>
    </div>
  ) : null;

  return (
    <div style="display:flex;flex-direction:column;height:100vh">
      {banner}
      <div style="display:flex;flex:1;min-height:0">
      <div id="tree">
        <div id="banner">
          <div class="meta">
            <span>graph <b>{graph ? graph.id.slice(0, 8) : "—"}</b></span>
            <span>v <b>{graph ? graph.version : 0}</b></span>
            <span id="conn" style={connErr ? "color:var(--err)" : "color:var(--ok)"}>
              {connErr ? "⚠ " + connErr : "● live"}
            </span>
          </div>
          <h1>computation graph</h1>
        </div>
        <div id="toolbar">
          <button onClick={expandAll}>+ expand all</button>
          <button onClick={collapseAll}>− collapse all</button>
          {/* Metric dropdown — controls which value is summed per-subtree
              and shown next to every row. Token / cost columns let the
              reviewer spot the "where did the wave's $ go" subtree at a
              glance without opening every send node. */}
          <label style="margin-left:auto;display:flex;gap:6px;align-items:center;color:var(--muted);font-size:12px">
            summary:
            <select
              value={metricId}
              onChange={(e) => setMetricId((e.target as HTMLSelectElement).value)}
              style="background:var(--pending);color:var(--fg);border:1px solid #30363d;border-radius:3px;padding:2px 6px"
            >
              {METRICS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>
        <div id="treeBody">
          {rootNode && graph
            ? <TreeNode
                node={rootNode}
                depth={0}
                graph={graph}
                selectedId={selectedId}
                onSelect={setSelectedId}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
                sumMap={sumMap}
                selfMap={selfMap}
                metric={metric}
              />
            : <div style="color:var(--muted)">loading…</div>}
        </div>
      </div>
      <div id="detail">
        {graph && selectedId
          ? <Detail graph={graph} selectedId={selectedId} onSelect={setSelectedId} />

          : <h1>select a node</h1>}
      </div>
      </div>
    </div>
  );
}
