/**
 * Browser-side monitor UI, written as Preact components so reveal
 * toggles and tree-collapse state survive the 250 ms polling cadence.
 *
 * The whole thing ships as a single string that server.ts concatenates
 * into the HTML response; we don't bundle or minify it (the dependency
 * surface is two ESM imports from esm.sh). Kept separate from
 * server.ts purely so we don't have to escape backticks and dollar-
 * interpolation inside an outer template literal.
 */

export const CLIENT_SCRIPT = `
import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useMemo, useCallback } from "https://esm.sh/preact@10/hooks";

// ---- small helpers --------------------------------------------------------
function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

/** Structural vs followup classification:
 *   child.createdAt >= parent.startedAt → structural (engine-spawned sub-
 *                                          tree, indent one level)
 *   otherwise                             → chain followup (same depth;
 *                                          .a().b() should not cascade).
 *  If parent hasn't started yet we treat all children as followups so
 *  not-yet-running trees stay flat instead of exploding indentation. */
function isStructuralChild(parent, child) {
  if (parent.startedAt == null) return false;
  return child.createdAt >= parent.startedAt;
}

function computeDurations(nodes) {
  const sumMap = new Map();
  const selfMap = new Map();
  const byParent = new Map();
  for (const n of nodes) {
    const p = n.parentId == null ? "__root__" : n.parentId;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(n);
  }
  const now = Date.now();
  for (const n of nodes) {
    const wall = n.finishedAt != null && n.startedAt != null
      ? n.finishedAt - n.startedAt
      : (n.startedAt != null ? now - n.startedAt : null);
    sumMap.set(n.id, wall);
    const kids = (byParent.get(n.id) || []).filter(c => c.startedAt != null);
    if (kids.length === 0) { selfMap.set(n.id, wall); continue; }
    const intervals = kids
      .map(c => [c.startedAt, c.finishedAt == null ? now : c.finishedAt])
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
  }
  return { sumMap, selfMap };
}

// ---- StringReveal: per-string expand button ------------------------------
// Component-local state; because Preact reconciles by position + type,
// this state SURVIVES the 250 ms graph poll as long as the parent tree
// shape is stable. Toggling no longer "shows then dismisses" on the
// next tick — that was the whole point of moving to a component model.
function StringReveal(props) {
  const value = props.value;
  const [shown, setShown] = useState(false);
  const isLong = value.length > 200;
  const preview = isLong
    ? JSON.stringify(value.slice(0, 180) + "…")
    : JSON.stringify(value);
  return h("span", { class: "json-str" },
    !shown && h("span", null, preview),
    shown && h("pre", { class: "lsfull-body" }, value),
    h("button", {
      class: "revealBtn",
      title: value.length + " chars",
      onClick: () => setShown(!shown),
    }, shown ? "hide" : "show"),
  );
}

// ---- JsonView: pretty-printed JSON with per-string StringReveal ----------
function JsonView(props) {
  const value = props.value;
  const indent = props.indent || 0;
  if (value === null) return h("span", { class: "json-null" }, "null");
  if (value === undefined) return h("span", { class: "json-null" }, "undefined");
  const t = typeof value;
  if (t === "string") return h(StringReveal, { value });
  if (t === "number" || t === "boolean") return h("span", { class: "json-prim" }, String(value));
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return h("span", null, "[]");
    return h("span", null,
      "[\\n",
      value.map((x, i) => h("span", { key: i },
        pad,
        h(JsonView, { value: x, indent: indent + 1 }),
        i < value.length - 1 ? ",\\n" : "\\n",
      )),
      close, "]",
    );
  }
  if (t === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return h("span", null, "{}");
    return h("span", null,
      "{\\n",
      keys.map((k, i) => h("span", { key: k },
        pad,
        h("span", { class: "json-key" }, JSON.stringify(k)),
        ": ",
        h(JsonView, { value: value[k], indent: indent + 1 }),
        i < keys.length - 1 ? ",\\n" : "\\n",
      )),
      close, "}",
    );
  }
  return h("span", null, String(value));
}

// ---- ComposedPromptReveal (send nodes only) ------------------------------
function ComposedPromptReveal(props) {
  const text = props.text;
  const [shown, setShown] = useState(false);
  return h("div", { class: "sect" },
    h("h2", null,
      "entire prompt sent to claude ",
      h("button", { class: "revealBtn", onClick: () => setShown(!shown) }, shown ? "hide" : "show"),
      h("span", { style: "margin-left:8px;color:var(--muted);font-size:11px" }, text.length + " chars"),
    ),
    shown && h("pre", null, text),
  );
}

// ---- Detail panel --------------------------------------------------------
function Detail(props) {
  const { graph, selectedId } = props;
  const node = graph.nodes.find(n => n.id === selectedId);
  if (!node) return h("h1", null, "node gone");
  const { sumMap, selfMap } = useMemo(
    () => computeDurations(graph.nodes),
    [graph.version],
  );
  const sumMs = sumMap.get(node.id);
  const selfMs = selfMap.get(node.id);
  const showSelf = sumMs != null && selfMs != null && Math.abs(sumMs - selfMs) > 1;
  const composed = node.kind === "send" && node.output && typeof node.output.composedPrompt === "string"
    ? node.output.composedPrompt : null;

  return h("div", null,
    h("h1", null, node.kind + " — " + node.label),
    h("div", { class: "meta" },
      h("span", null, "status ", h("b", null, node.status)),
      h("span", null, "sum ", h("b", null, fmtDur(sumMs))),
      showSelf ? h("span", null, "self ", h("b", null, fmtDur(selfMs))) : null,
      node.model ? h("span", null, "model ", h("b", null, node.model)) : null,
      node.sessionId ? h("span", null, "session ", h("b", null, node.sessionId.slice(0, 8))) : null,
    ),
    composed != null ? h(ComposedPromptReveal, { text: composed }) : null,
    h("div", { class: "sect" }, h("h2", null, "input"), h("pre", null, h(JsonView, { value: node.input }))),
    h("div", { class: "sect" }, h("h2", null, "output"), h("pre", null, h(JsonView, { value: node.output }))),
    node.error ? h("div", { class: "sect" }, h("h2", null, "error"), h("pre", null, h(JsonView, { value: node.error }))) : null,
  );
}

// ---- Tree ----------------------------------------------------------------
function TreeNode(props) {
  const { node, depth, graph, selectedId, onSelect, collapsed, onToggleCollapsed, sumMap, selfMap } = props;
  const kids = useMemo(
    () => graph.nodes.filter(n => n.parentId === node.id).sort((a, b) => a.createdAt - b.createdAt),
    [graph.version, node.id],
  );
  const isCollapsed = collapsed.has(node.id);
  const hasKids = kids.length > 0;
  const sumMs = sumMap.get(node.id);
  const selfMs = selfMap.get(node.id);
  const showSelf = sumMs != null && selfMs != null && Math.abs(sumMs - selfMs) > 1;
  return h("div", null,
    h("div", {
      class: "node tier" + Math.min(depth, 24) + (selectedId === node.id ? " selected" : ""),
      title: node.status,
      onClick: () => onSelect(node.id),
    },
      h("span", {
        class: hasKids ? "chev" : "chev leaf",
        onClick: (e) => { e.stopPropagation(); if (hasKids) onToggleCollapsed(node.id); },
      }, hasKids ? (isCollapsed ? "▸" : "▾") : ""),
      h("span", { class: "status " + node.status }),
      h("span", { class: "kind" }, node.kind),
      h("span", { class: "label" }, node.label),
      sumMs != null && h("span", { class: "dur" },
        fmtDur(sumMs),
        showSelf && h("span", { class: "sep" }, "·"),
        showSelf && h("span", { class: "cum" }, "self " + fmtDur(selfMs)),
      ),
    ),
    !isCollapsed && kids.map(k => h(TreeNode, {
      key: k.id,
      node: k,
      depth: isStructuralChild(node, k) ? depth + 1 : depth,
      graph, selectedId, onSelect, collapsed, onToggleCollapsed, sumMap, selfMap,
    })),
  );
}

// ---- App root ------------------------------------------------------------
function App() {
  const [graph, setGraph] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [connErr, setConnErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const r = await fetch("/api/graph");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const g = await r.json();
        setGraph(g);
        setConnErr(null);
      } catch (e) {
        setConnErr(String(e && e.message ? e.message : e));
      }
      if (alive) setTimeout(tick, 250);
    };
    tick();
    return () => { alive = false; };
  }, []);

  const { sumMap, selfMap } = useMemo(
    () => graph ? computeDurations(graph.nodes) : { sumMap: new Map(), selfMap: new Map() },
    [graph && graph.version],
  );

  const onToggleCollapsed = useCallback((id) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    if (!graph) return;
    const parents = new Set();
    for (const n of graph.nodes) {
      if ((n.parentId || "") !== "" && n.parentId !== graph.rootId) parents.add(n.parentId);
    }
    // Only collapse non-root parents.
    const next = new Set();
    for (const id of parents) if (id !== graph.rootId) next.add(id);
    setCollapsed(next);
  }, [graph && graph.version]);

  const rootNode = graph ? graph.nodes.find(n => n.id === graph.rootId) : null;

  return h("div", { style: "display:flex;height:100vh" },
    h("div", { id: "tree" },
      h("div", { id: "banner" },
        h("div", { class: "meta" },
          h("span", null, "graph ", h("b", null, graph ? graph.id.slice(0, 8) : "—")),
          h("span", null, "v ", h("b", null, graph ? graph.version : 0)),
          h("span", {
            id: "conn",
            style: connErr ? "color:var(--err)" : "color:var(--ok)",
          }, connErr ? "⚠ " + connErr : "● live"),
        ),
        h("h1", null, "computation graph"),
      ),
      h("div", { id: "toolbar" },
        h("button", { onClick: expandAll }, "+ expand all"),
        h("button", { onClick: collapseAll }, "− collapse all"),
      ),
      h("div", { id: "treeBody" },
        rootNode
          ? h(TreeNode, {
              node: rootNode,
              depth: 0,
              graph, selectedId,
              onSelect: setSelectedId,
              collapsed, onToggleCollapsed,
              sumMap, selfMap,
            })
          : h("div", { style: "color:var(--muted)" }, "loading…"),
      ),
    ),
    h("div", { id: "detail" },
      graph && selectedId
        ? h(Detail, { graph, selectedId, key: selectedId })
        : h("h1", null, "select a node"),
    ),
  );
}

render(h(App), document.getElementById("root"));
`;
