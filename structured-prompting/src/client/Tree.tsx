/**
 * Left-pane tree view. Recursive `TreeNode` — each node renders its row
 * (chevron, status dot, kind label, duration/metric column) followed by
 * its containerId-grouped children one tier deeper.
 *
 * Tree nesting is by `containerId` (lexical lambda anchor), not
 * `parentId` (linear chain predecessor). A chain `a().b().c()` built off
 * the same Session shares one containerId, so all three render as
 * siblings under the anchor instead of as a 3-deep cascade.
 */
import { useMemo } from "preact/hooks";
import type { GraphNode, GraphSnapshot } from "../api/wire.js";
import type { MetricDef } from "./helpers.js";

interface TreeNodeProps {
  node: GraphNode;
  depth: number;
  graph: GraphSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
  sumMap: Map<string, number | null>;
  selfMap: Map<string, number | null>;
  metric: MetricDef;
}

export function TreeNode(props: TreeNodeProps): preact.JSX.Element {
  const { node, depth, graph, selectedId, onSelect, collapsed, onToggleCollapsed, sumMap, selfMap, metric } = props;
  const kids = useMemo(
    () => graph.nodes.filter(n => n.containerId === node.id && n.id !== node.id).sort((a, b) => a.createdAt - b.createdAt),
    [graph.version, node.id],
  );
  const isCollapsed = collapsed.has(node.id);
  const hasKids = kids.length > 0;
  const sum = sumMap.get(node.id);
  const self = selfMap.get(node.id);
  // showSelf: only when self differs meaningfully from sum (parallel
  // duration, or self-only contribution for tokens). 1ms tolerance for
  // duration so trivially-fast non-parallel nodes don't repeat the value.
  const showSelf = (() => {
    if (sum == null || self == null) return false;
    if (metric.id === "durationMs") return Math.abs(sum - self) > 1;
    return sum !== self && self !== 0;
  })();
  // Right-click on any node → select it AND scroll the AskPanel into
  // view so the reviewer can run a follow-up directly. setTimeout so the
  // Detail panel is rendered before we try to find the textarea.
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    onSelect(node.id);
    setTimeout(() => {
      const ta = document.querySelector(".ask-input") as HTMLTextAreaElement | null;
      if (ta && ta.scrollIntoView) {
        ta.scrollIntoView({ behavior: "smooth", block: "nearest" });
        ta.focus();
      }
    }, 50);
  };
  return (
    <div>
      <div
        class={"node tier" + Math.min(depth, 24) + (selectedId === node.id ? " selected" : "")}
        title={node.status}
        onClick={() => onSelect(node.id)}
        onContextMenu={onContext}
      >
        <span
          class={hasKids ? "chev" : "chev leaf"}
          onClick={(e) => { e.stopPropagation(); if (hasKids) onToggleCollapsed(node.id); }}
        >{hasKids ? (isCollapsed ? "▸" : "▾") : ""}</span>
        <span class={"status " + node.status}></span>
        {/* askFollowup nodes get a distinct ↪ glyph + the "ask" label so
            they don't read as a parallelChild when sitting next to one. */}
        {node.kind === "askFollowup"
          ? <span class="kind" style="color:#79c0ff">↪ ask</span>
          : <span class="kind">{node.kind}</span>}
        <span class="label">{node.label}</span>
        {sum != null && (
          <span class="dur">
            {metric.fmt(sum)}
            {showSelf && <span class="sep">·</span>}
            {showSelf && <span class="cum">{"self " + metric.fmt(self)}</span>}
          </span>
        )}
      </div>
      {!isCollapsed && kids.map(k => (
        <TreeNode
          key={k.id}
          node={k}
          depth={depth + 1}
          graph={graph}
          selectedId={selectedId}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          sumMap={sumMap}
          selfMap={selfMap}
          metric={metric}
        />
      ))}
    </div>
  );
}
