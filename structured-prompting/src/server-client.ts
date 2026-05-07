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
// Bare specifiers resolved by the <script type="importmap"> in server.ts's
// HTML — Preact ships from our own server under /vendor/ so the monitor
// doesn't depend on esm.sh being reachable from the reviewer's browser.
import { h, render } from "preact";
import { useState, useEffect, useMemo, useCallback } from "preact/hooks";

// ---- small helpers --------------------------------------------------------
function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

// Per-node metric formatters. Each metric appears in the dropdown, the
// per-row column, and the detail panel sum. costUsd uses 4 decimals so a
// $0.0042 send doesn't round to "$0".
const METRICS = [
  { id: "durationMs",        label: "duration (s)",  fmt: (v) => fmtDur(v) },
  { id: "costUsd",           label: "cost (USD)",     fmt: (v) => v == null ? "—" : "$" + Number(v).toFixed(4) },
  { id: "inputTokens",       label: "input tokens",   fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
  { id: "outputTokens",      label: "output tokens",  fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
  { id: "cacheReadTokens",   label: "cache-read tok", fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
  { id: "cacheCreateTokens", label: "cache-write tok",fmt: (v) => v == null ? "—" : Number(v).toLocaleString() },
];

/**
 * Per-node value for a given metric. Sends carry the entire token + USD
 * payload on output.usage; non-send nodes return 0 except for duration
 * (always wall-time of self).
 */
function nodeValue(node, metric) {
  if (metric === "durationMs") {
    if (node.startedAt == null) return null;
    return (node.finishedAt ?? Date.now()) - node.startedAt;
  }
  const u = node.output && node.output.usage;
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

// Roll up a single metric over the visible-tree subtree of every node.
// Subtree relation is containerId === parent.id, so this matches the
// lexical lambda nesting the UI displays (rollups for a parallelFork
// sum across all parallelChildren, etc.).
//
// For duration the rollup is the elapsed wall-time of the node itself;
// selfMap subtracts the union of children's intervals so a parallel fork
// that spends 10 s in 7 children doesn't double-count. For tokens and
// USD the rollup is a plain SUM (every send's contribution is real
// spend, no parallel-discount).
function computeRollup(nodes, metric) {
  const sumMap = new Map();   // metric value summed over node + descendants
  const selfMap = new Map();  // node's own contribution (duration: minus parallel-overlap)
  const byContainer = new Map();
  for (const n of nodes) {
    const c = n.containerId == null ? "__root__" : n.containerId;
    if (!byContainer.has(c)) byContainer.set(c, []);
    byContainer.get(c).push(n);
  }
  const now = Date.now();

  function durSum(node) {
    return node.finishedAt != null && node.startedAt != null
      ? node.finishedAt - node.startedAt
      : (node.startedAt != null ? now - node.startedAt : null);
  }

  // Recursive sum over the subtree (visible children = nodes whose
  // containerId === this node's id). Cache to avoid re-walking shared
  // ancestors.
  const cache = new Map();
  function subtreeSum(node) {
    if (cache.has(node.id)) return cache.get(node.id);
    const own = nodeValue(node, metric) ?? 0;
    let sum = typeof own === "number" ? own : 0;
    const kids = byContainer.get(node.id) || [];
    for (const k of kids) {
      if (k.id === node.id) continue;
      const s = subtreeSum(k);
      if (typeof s === "number") sum += s;
    }
    cache.set(node.id, sum);
    return sum;
  }

  for (const n of nodes) {
    if (metric === "durationMs") {
      // Wall-clock: parent's elapsed time IS what we display, NOT the sum.
      const wall = durSum(n);
      sumMap.set(n.id, wall);
      const kids = (byContainer.get(n.id) || []).filter(c => c.id !== n.id && c.startedAt != null);
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
    } else {
      // Tokens / cost: simple subtree sum. selfMap is just this node's
      // own contribution (zero for non-send anchors, the actual call
      // value for send nodes).
      sumMap.set(n.id, subtreeSum(n));
      const own = nodeValue(n, metric);
      selfMap.set(n.id, typeof own === "number" ? own : 0);
    }
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

// ---- AskPanel: free-form follow-up against a node's claude session -------
// Posts {nodeId, prompt} to /api/ask. The server resumes the node's
// claude session and forwards the prompt; the reply is shown below the
// textarea. State is component-local so multi-line prompts don't get
// nuked by the 250 ms graph poll. Also remembers the last reply so the
// reviewer can copy it after switching nodes and back.
function AskPanel(props) {
  const { node, graph, onSelect } = props;
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Find the nearest ancestor (via parentId chain) carrying a sessionId.
  // This is the node we'll fork from. The clicked node parents the new
  // followup in the tree regardless — anchor only controls --resume.
  const anchor = useMemo(() => {
    let cur = node;
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    while (cur && !cur.sessionId && cur.parentId) {
      cur = byId.get(cur.parentId);
    }
    return cur && cur.sessionId ? cur : null;
  }, [graph.version, node.id]);
  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, prompt }),
      });
      const json = await r.json();
      if (!r.ok || json.error) {
        setErr(json.error || ("HTTP " + r.status));
      } else if (json.isError) {
        // The askFollowup node was created and finalized as error; jump to
        // it so the reviewer sees the failure inline with the rest of the tree.
        if (json.newNodeId && onSelect) onSelect(json.newNodeId);
        setErr(json.errorMessage || "model returned isError");
      } else {
        // Success: clear the textarea and select the new node so its
        // reply renders in the standard detail panel (same shape as a send).
        setPrompt("");
        if (json.newNodeId && onSelect) onSelect(json.newNodeId);
      }
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally { setBusy(false); }
  };
  // Right-click "Rerun this prompt" prefills with the original composed prompt.
  const composed = node.output && typeof node.output.composedPrompt === "string"
    ? node.output.composedPrompt
    : null;
  // Header copy explains what's happening: the new followup nests under
  // the clicked node, but resumes from the nearest ancestor that has a
  // claude session. When no ancestor has a session yet (very early in
  // the run), the panel renders disabled with a hint.
  const headerText = anchor
    ? (anchor.id === node.id
        ? "ask follow-up (forks session " + anchor.sessionId.slice(0, 8) + " from this node)"
        : "ask follow-up (forks session " + anchor.sessionId.slice(0, 8) + " from ancestor " + anchor.kind + ")")
    : "ask follow-up — disabled until first send completes";
  const canSend = !!anchor;
  return h("div", { class: "sect" },
    h("h2", null, headerText),
    h("textarea", {
      class: "ask-input",
      placeholder: canSend
        ? "type a question — the model has the same conversation context as the anchor send. enter to send, shift+enter for newline."
        : "no completed send in this branch yet — once one finishes, this textarea becomes active",
      rows: 3,
      value: prompt,
      onInput: (e) => setPrompt(e.target.value),
      onKeyDown: (e) => {
        // Plain Enter sends; Shift+Enter inserts a newline (standard chat
        // UX). Ctrl/⌘+Enter kept as an alias for muscle memory.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (canSend) submit();
        }
      },
      disabled: !canSend,
      style: "width:100%;background:var(--pending);color:var(--fg);border:1px solid #30363d;border-radius:3px;padding:6px 8px;font:inherit;resize:vertical;opacity:" + (canSend ? "1" : "0.55"),
    }),
    h("div", { style: "display:flex;gap:8px;margin-top:6px;align-items:center" },
      h("button", {
        onClick: submit,
        disabled: !canSend || busy || !prompt.trim(),
      }, busy ? "asking…" : "send (enter)"),
      composed && h("button", {
        onClick: () => setPrompt(composed),
        title: "Prefill the textarea with the prompt this node originally sent — useful for retrying with the same input.",
      }, "↺ rerun this prompt"),
      busy && h("span", { style: "color:var(--muted);font-size:11px" },
        "creating askFollowup node… reply lands as a new tree child"),
    ),
    err && h("pre", { style: "color:var(--err);margin-top:6px;white-space:pre-wrap" }, "error: " + err),
  );
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

// ---- RetryPanel: re-run a node in place ---------------------------------
// POSTs /api/retry {nodeId}. Supported kinds:
//   executeShell — re-run cmd in saved cwd. Replaces output.
//   send / askFollowup — re-call claude with composedPrompt + same resume
//     sessionId, fork:true.
// Other kinds: panel renders a hint that the kind isn't retryable (the
// engine's callbacks were stripped from the snapshot, so we can't
// re-invoke parallelFork / pipe / try / etc.).
function RetryPanel(props) {
  const { node } = props;
  const retryable = node.kind === "executeShell" || node.kind === "send" || node.kind === "askFollowup";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setResult(null); setErr(null);
    try {
      const r = await fetch("/api/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const json = await r.json();
      if (!r.ok || json.error) setErr(json.error || ("HTTP " + r.status));
      else if (json.status === "error") setErr(json.message);
      else setResult(json.message);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!retryable) {
    // Still render the section so the user sees an explanation when they
    // click on a non-retryable kind, instead of wondering where the
    // button went.
    return h("div", { class: "sect" },
      h("h2", null, "retry"),
      h("div", { style: "color:var(--muted);font-size:11px" },
        "kind \"" + node.kind + "\" is not retryable — only executeShell, send, and askFollowup nodes can be re-run from the UI " +
        "(other kinds carry callbacks that were stripped from the persisted graph snapshot).",
      ),
    );
  }
  return h("div", { class: "sect" },
    h("h2", null, "retry — " + node.kind),
    h("div", { style: "display:flex;gap:8px;align-items:center" },
      h("button", {
        onClick: submit,
        disabled: busy,
        title: node.kind === "executeShell"
          ? "Re-run the saved cmd in the saved cwd. Output replaces in place."
          : "Re-call claude with the same composedPrompt + same resume sessionId, fork:true. Output replaces in place.",
      }, busy ? "retrying…" : "↻ retry this node"),
      result && h("span", { style: "color:var(--ok);font-size:11px" }, "✓ " + result),
    ),
    err && h("pre", { style: "color:var(--err);margin-top:6px;white-space:pre-wrap" }, "error: " + err),
  );
}

// ---- Detail panel --------------------------------------------------------
function Detail(props) {
  const { graph, selectedId, onSelect } = props;
  const node = graph.nodes.find(n => n.id === selectedId);
  if (!node) return h("h1", null, "node gone");
  // Detail panel always shows duration as the primary metric (it's the
  // most universally informative). The dropdown's metric controls only
  // the tree column. Cost / token sums are shown alongside as a separate
  // line if any send descendant contributed.
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
  const sumMs = durSumMap.get(node.id);
  const selfMs = durSelfMap.get(node.id);
  const showSelf = sumMs != null && selfMs != null && Math.abs(sumMs - selfMs) > 1;
  const usd = usdSumMap.get(node.id) || 0;
  const inT = inSumMap.get(node.id) || 0;
  const outT = outSumMap.get(node.id) || 0;
  // composedPrompt lives on node.output for finished sends AND on node.input
  //   while the send is still running (engine.materializeAndCall writes it
  //   BEFORE awaiting the CLI), so the reveal works in both states. Same
  //   applies to askFollowup nodes (server.handleAsk writes it on output).
  const carriesPrompt = node.kind === "send" || node.kind === "askFollowup";
  const composed = carriesPrompt
    ? (node.output && typeof node.output.composedPrompt === "string"
        ? node.output.composedPrompt
        : node.input && typeof node.input.composedPrompt === "string"
          ? node.input.composedPrompt
          : null)
    : null;

  return h("div", null,
    h("h1", null, node.kind + " — " + node.label),
    h("div", { class: "meta" },
      h("span", null, "status ", h("b", null, node.status)),
      h("span", null, "sum ", h("b", null, fmtDur(sumMs))),
      showSelf ? h("span", null, "self ", h("b", null, fmtDur(selfMs))) : null,
      node.model ? h("span", null, "model ", h("b", null, node.model)) : null,
      node.sessionId ? h("span", null, "session ", h("b", null, node.sessionId.slice(0, 8))) : null,
    ),
    // Cost rollup line — always shown when this subtree contains at
    // least one send. Hidden for purely-orchestration subtrees so the
    // header doesn't clutter with $0 / 0 tok lines.
    usd > 0 || inT > 0 || outT > 0
      ? h("div", { class: "meta" },
          h("span", null, "cost ", h("b", null, "$" + usd.toFixed(4))),
          h("span", null, "in ", h("b", null, inT.toLocaleString()), " tok"),
          h("span", null, "out ", h("b", null, outT.toLocaleString()), " tok"),
        )
      : null,
    composed != null ? h(ComposedPromptReveal, { text: composed }) : null,
    h(RetryPanel, { node }),
    h("div", { class: "sect" }, h("h2", null, "input"), h("pre", null, h(JsonView, { value: node.input }))),
    h("div", { class: "sect" }, h("h2", null, "output"), h("pre", null, h(JsonView, { value: node.output }))),
    node.error ? h("div", { class: "sect" }, h("h2", null, "error"), h("pre", null, h(JsonView, { value: node.error }))) : null,
    // Ask-follow-up panel — rendered on EVERY node. The panel walks up
    // the parentId chain to find the nearest ancestor carrying a claude
    // sessionId, and uses that as the resume anchor. The new followup
    // node nests under the CLICKED node so the user sees the question
    // visually attached where they put it. If no ancestor has a session
    // yet (very early in the run), the panel renders disabled with a
    // hint until the first send completes.
    h(AskPanel, { node, graph, onSelect }),
  );
}

// ---- Tree ----------------------------------------------------------------
function TreeNode(props) {
  const { node, depth, graph, selectedId, onSelect, collapsed, onToggleCollapsed, sumMap, selfMap, metric } = props;
  // Tree nesting is by containerId (lexical lambda anchor), not parentId
  // (linear chain predecessor). A chain like a().b().c() built off the same
  // Session shares one containerId, so all three render as siblings under
  // the anchor instead of as a 3-deep cascade.
  const kids = useMemo(
    () => graph.nodes.filter(n => n.containerId === node.id && n.id !== node.id).sort((a, b) => a.createdAt - b.createdAt),
    [graph.version, node.id],
  );
  const isCollapsed = collapsed.has(node.id);
  const hasKids = kids.length > 0;
  const sum = sumMap.get(node.id);
  const self = selfMap.get(node.id);
  // showSelf: only when self differs meaningfully from sum (parallel
  // duration, or self-only contribution for tokens). The tolerance is 1ms
  // for duration so trivially-fast non-parallel nodes don't repeat the
  // value; for everything else strict inequality.
  const showSelf = (() => {
    if (sum == null || self == null) return false;
    if (metric.id === "durationMs") return Math.abs(sum - self) > 1;
    return sum !== self && self !== 0;
  })();
  // Right-click on a send node → select it AND scroll the AskPanel into
  // view so the reviewer can run a follow-up directly. For non-send
  // nodes the right-click just selects (no panel to anchor on). We use
  // a setTimeout so the Detail panel is rendered before we try to find
  // the ask-input textarea.
  const onContext = (e) => {
    e.preventDefault();
    onSelect(node.id);
    setTimeout(() => {
      const ta = document.querySelector(".ask-input");
      if (ta && ta.scrollIntoView) {
        ta.scrollIntoView({ behavior: "smooth", block: "center" });
        ta.focus();
      }
    }, 50);
  };
  return h("div", null,
    h("div", {
      class: "node tier" + Math.min(depth, 24) + (selectedId === node.id ? " selected" : ""),
      title: node.status,
      onClick: () => onSelect(node.id),
      onContextMenu: onContext,
    },
      h("span", {
        class: hasKids ? "chev" : "chev leaf",
        onClick: (e) => { e.stopPropagation(); if (hasKids) onToggleCollapsed(node.id); },
      }, hasKids ? (isCollapsed ? "▸" : "▾") : ""),
      h("span", { class: "status " + node.status }),
      // askFollowup nodes get a distinct ↪ glyph + the "ask" label so
      // they don't read as a parallelChild when sitting next to one. The
      // anchor send still shows its normal kind; only the followup is
      // marked.
      node.kind === "askFollowup"
        ? h("span", { class: "kind", style: "color:#79c0ff" }, "↪ ask")
        : h("span", { class: "kind" }, node.kind),
      h("span", { class: "label" }, node.label),
      sum != null && h("span", { class: "dur" },
        metric.fmt(sum),
        showSelf && h("span", { class: "sep" }, "·"),
        showSelf && h("span", { class: "cum" }, "self " + metric.fmt(self)),
      ),
    ),
    !isCollapsed && kids.map(k => h(TreeNode, {
      key: k.id,
      node: k,
      // All "kids" are now containerId-grouped siblings — always one level deeper.
      depth: depth + 1,
      graph, selectedId, onSelect, collapsed, onToggleCollapsed, sumMap, selfMap, metric,
    })),
  );
}

// ---- App root ------------------------------------------------------------
function App() {
  const [graph, setGraph] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [connErr, setConnErr] = useState(null);
  // Selected per-row rollup metric. Default to wall-clock duration since
  // it's the most universally meaningful; the dropdown lets the reviewer
  // switch to USD or token-class views to spot-check cost.
  const [metricId, setMetricId] = useState("durationMs");
  const metric = METRICS.find(m => m.id === metricId) || METRICS[0];

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
    () => graph ? computeRollup(graph.nodes, metricId) : { sumMap: new Map(), selfMap: new Map() },
    [graph && graph.version, metricId],
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
        // Metric dropdown — controls which value is summed per-subtree
        // and shown next to every row. Token / cost columns let the
        // reviewer spot the "where did the wave's $ go" subtree at a
        // glance without opening every send node.
        h("label", { style: "margin-left:auto;display:flex;gap:6px;align-items:center;color:var(--muted);font-size:12px" },
          "summary:",
          h("select", {
            value: metricId,
            onChange: (e) => setMetricId(e.target.value),
            style: "background:var(--pending);color:var(--fg);border:1px solid #30363d;border-radius:3px;padding:2px 6px",
          },
            METRICS.map(m => h("option", { key: m.id, value: m.id }, m.label)),
          ),
        ),
      ),
      h("div", { id: "treeBody" },
        rootNode
          ? h(TreeNode, {
              node: rootNode,
              depth: 0,
              graph, selectedId,
              onSelect: setSelectedId,
              collapsed, onToggleCollapsed,
              sumMap, selfMap, metric,
            })
          : h("div", { style: "color:var(--muted)" }, "loading…"),
      ),
    ),
    h("div", { id: "detail" },
      graph && selectedId
        ? h(Detail, { graph, selectedId, onSelect: setSelectedId, key: selectedId })
        : h("h1", null, "select a node"),
    ),
  );
}

// Visible fallback so a JS failure doesn't just leave the page blank.
try {
  render(h(App), document.getElementById("root"));
} catch (e) {
  const root = document.getElementById("root");
  if (root) root.innerHTML = "<pre style=\\"padding:16px;color:#f85149;white-space:pre-wrap\\">monitor crashed: " + (e && e.stack ? e.stack : String(e)) + "</pre>";
  console.error("[sp monitor]", e);
  throw e;
}
`;
