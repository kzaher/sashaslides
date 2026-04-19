import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ComputationGraph } from "./graph.js";

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Structured Prompting Monitor</title>
<style>
  :root { --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --ok:#3fb950; --err:#f85149; --run:#e3b341; --pending:#484f58; --sel:#1f6feb; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); height:100vh; display:flex; }
  #tree { width:46%; overflow:auto; border-right:1px solid #30363d; padding:12px; }
  #detail { flex:1; overflow:auto; padding:12px; }
  h1 { font-size:14px; margin:0 0 8px; color:var(--muted); font-weight:normal; }
  .node { padding:3px 6px; border-left:3px solid transparent; cursor:pointer; white-space:nowrap; border-radius:3px; display:flex; align-items:center; gap:4px; }
  .node:hover { background:#161b22; }
  .node.selected { background:#1f6feb33; border-left-color:var(--sel); }
  .chev { display:inline-block; width:14px; text-align:center; color:var(--muted); font-size:10px; user-select:none; flex-shrink:0; }
  .chev.leaf { visibility:hidden; }
  .chev:hover { color:var(--fg); }
  .status { display:inline-block; width:12px; height:12px; border-radius:50%; vertical-align:middle; box-shadow:inset 0 0 0 1px rgba(0,0,0,0.3); flex-shrink:0; }
  .status.ok { background:var(--ok); box-shadow:inset 0 0 0 1px #1e4620, 0 0 0 0 transparent; }
  .status.error { background:var(--err); }
  .status.running { background:var(--run); animation: pulse 0.9s ease-in-out infinite; box-shadow:0 0 6px 1px var(--run); }
  .status.pending { background:transparent; border:2px dashed var(--pending); width:10px; height:10px; box-shadow:none; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  .kind { color:var(--muted); }
  .label { overflow:hidden; text-overflow:ellipsis; }
  .dur { color:var(--muted); font-size:11px; margin-left:auto; padding-left:8px; flex-shrink:0; }
  .dur .sep { color:#30363d; margin:0 3px; }
  .dur .cum { color:#6e7681; }
  pre { background:#161b22; padding:10px; border-radius:4px; max-height:45vh; overflow:auto; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; font-size:12px; }
  .sect { margin-top:14px; }
  .sect h2 { font-size:12px; color:var(--muted); font-weight:normal; text-transform:uppercase; letter-spacing:0.06em; margin:0 0 4px; }
  .meta span { margin-right:12px; color:var(--muted); }
  .meta b { color:var(--fg); font-weight:normal; }
  #banner { padding:8px 12px; background:#161b22; border-bottom:1px solid #30363d; margin-bottom:8px; }
  #toolbar { padding:6px 0 10px; display:flex; gap:6px; align-items:center; }
  #toolbar button { background:#21262d; color:var(--fg); border:1px solid #30363d; padding:4px 10px; font:inherit; font-size:11px; border-radius:4px; cursor:pointer; }
  #toolbar button:hover { background:#30363d; }
  #conn { color:var(--ok); }
  .tier0 { padding-left:0 }
  .tier1 { padding-left:18px }
  .tier2 { padding-left:36px }
  .tier3 { padding-left:54px }
  .tier4 { padding-left:72px }
  .tier5 { padding-left:90px }
  .tier6 { padding-left:108px }
  .tier7 { padding-left:126px }
  .tier8 { padding-left:144px }
</style>
</head>
<body>
<div id="tree">
  <div id="banner">
    <div class="meta">
      <span>graph <b id="gid">—</b></span>
      <span>v <b id="ver">0</b></span>
      <span id="conn">● live</span>
    </div>
    <h1>computation graph</h1>
  </div>
  <div id="toolbar">
    <button id="btnExpandAll">+ expand all</button>
    <button id="btnCollapseAll">− collapse all</button>
  </div>
  <div id="treeBody"></div>
</div>
<div id="detail">
  <h1>select a node</h1>
</div>
<script>
let state = null;
let selectedId = null;
// ids whose children are hidden. Default: visible (not in set).
const collapsed = new Set();

// Description-node kinds that are "inline": they render in-place without
// causing their children to indent. Includes state mutations AND operational
// calls (send/sendFormatted/combineWith) per the spec.
const INLINE_KINDS = new Set([
  'prependToNextPrompt', 'appendToNextPrompt',
  'switchModel', 'fork', 'compact', 'newSession',
  'materializeError', 'assert',
  'send', 'combineWith',
]);
// Kinds that are inline but that CAN still own a logical sub-branch — for
// these the UI shows a chevron even though their own depth doesn't increase.
// (combineWith's sub-description is a child combineBranch which IS structural,
//  so combineWith itself doesn't need a chevron of its own.)

function fmtDur(ms){ if(ms==null) return "—"; if(ms<1000) return ms+"ms"; return (ms/1000).toFixed(2)+"s"; }

/**
 * For each node compute two durations:
 *   sum  = finishedAt - startedAt   — the node's full wall-clock span
 *                                     (includes all children's work).
 *                                     For parallelFork this equals
 *                                     max(children.sum) because they
 *                                     run concurrently; for sequential
 *                                     wrappers like try / combineWith
 *                                     it equals sum of children.
 *   self = sum minus the UNION of direct children's wall-clock intervals.
 *          For a leaf this equals sum. For pure orchestration nodes that
 *          just wait on children, self → 0.
 *
 * Using the union (not the arithmetic sum) of children intervals means
 * concurrent children are counted once — so parallelFork.self is the
 * small dispatch overhead, not "negative" time.
 */
function computeDurations(){
  const sumMap = new Map();
  const selfMap = new Map();
  const byParent = new Map();
  for (const n of state.nodes) {
    const p = n.parentId ?? "__root__";
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(n);
  }
  for (const n of state.nodes) {
    const wall = n.finishedAt && n.startedAt
      ? n.finishedAt - n.startedAt
      : (n.startedAt ? Date.now() - n.startedAt : null);
    sumMap.set(n.id, wall);

    // Union of direct children's [start, end] intervals.
    const kids = (byParent.get(n.id) || []).filter(c => c.startedAt != null);
    if (kids.length === 0) { selfMap.set(n.id, wall); continue; }
    const intervals = kids
      .map(c => [c.startedAt, c.finishedAt ?? Date.now()])
      .sort((a, b) => a[0] - b[0]);
    let unionLen = 0;
    let curEnd = -Infinity;
    for (const [s, e] of intervals) {
      if (s >= curEnd) { unionLen += e - s; curEnd = e; }
      else if (e > curEnd) { unionLen += e - curEnd; curEnd = e; }
    }
    const selfMs = wall != null ? Math.max(0, wall - unionLen) : null;
    selfMap.set(n.id, selfMs);
  }
  return { selfMap, sumMap };
}

function renderTree(){
  const body = document.getElementById('treeBody');
  const byParent = new Map();
  for(const n of state.nodes){
    const p = n.parentId ?? "__root__";
    if(!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(n);
  }
  const { selfMap, sumMap } = computeDurations();
  const lines = [];
  const walk = (id, depth) => {
    const n = state.nodes.find(x=>x.id===id); if(!n) return;
    const kids = byParent.get(n.id) || [];
    kids.sort((a,b)=>a.createdAt-b.createdAt);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed.has(n.id);
    const chevChar = !hasKids ? '' : (isCollapsed ? '▸' : '▾');
    const chevClass = hasKids ? 'chev' : 'chev leaf';
    const sumMs = sumMap.get(n.id);
    const selfMs = selfMap.get(n.id);
    // Primary: Σ (wall-clock). Secondary: self (only when it meaningfully
    // differs — hide for leaves where self === sum).
    const showSelf = sumMs != null && selfMs != null && Math.abs(sumMs - selfMs) > 1;
    const durHtml = sumMs == null ? '' :
      '<span class="dur">' + fmtDur(sumMs)
      + (showSelf ? '<span class="sep">·</span><span class="cum">self '+fmtDur(selfMs)+'</span>' : '')
      + '</span>';
    lines.push('<div class="node tier'+Math.min(depth,8)+(selectedId===n.id?' selected':'')+'" data-id="'+n.id+'" title="'+n.status+'">'
      + '<span class="'+chevClass+'" data-chev="'+n.id+'">'+chevChar+'</span>'
      + '<span class="status '+n.status+'"></span>'
      + '<span class="kind">'+n.kind+'</span>'
      + '<span class="label">'+escapeHtml(n.label)+'</span>'
      + durHtml
      + '</div>');
    if (isCollapsed) return;
    // Inline kinds don't create a new indent level for their children.
    const childDepth = INLINE_KINDS.has(n.kind) ? depth : depth+1;
    for(const k of kids) walk(k.id, childDepth);
  };
  walk(state.rootId, 0);
  body.innerHTML = lines.join("");
  body.querySelectorAll('.node').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target && ev.target.dataset && ev.target.dataset.chev) {
        const id = ev.target.dataset.chev;
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        renderTree();
        ev.stopPropagation();
        return;
      }
      selectedId = el.dataset.id; renderDetail(); renderTree();
    });
  });
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderDetail(){
  const detail = document.getElementById('detail');
  if(!selectedId){ detail.innerHTML = '<h1>select a node</h1>'; return; }
  const n = state.nodes.find(x=>x.id===selectedId);
  if(!n){ detail.innerHTML = '<h1>node gone</h1>'; return; }
  const { selfMap, sumMap } = computeDurations();
  const sumMs = sumMap.get(n.id);
  const selfMs = selfMap.get(n.id);
  const showSelf = sumMs != null && selfMs != null && Math.abs(sumMs - selfMs) > 1;
  const html = [
    '<h1>'+n.kind+' — '+escapeHtml(n.label)+'</h1>',
    '<div class="meta">',
      '<span>status <b>'+n.status+'</b></span>',
      '<span>sum <b>'+fmtDur(sumMs)+'</b></span>',
      (showSelf ? '<span>self <b>'+fmtDur(selfMs)+'</b></span>' : ''),
      (n.model ? '<span>model <b>'+n.model+'</b></span>' : ''),
      (n.sessionId ? '<span>session <b>'+n.sessionId.slice(0,8)+'</b></span>' : ''),
    '</div>',
    '<div class="sect"><h2>input</h2><pre>'+escapeHtml(stringify(n.input))+'</pre></div>',
    '<div class="sect"><h2>output</h2><pre>'+escapeHtml(stringify(n.output))+'</pre></div>',
    (n.error ? '<div class="sect"><h2>error</h2><pre>'+escapeHtml(stringify(n.error))+'</pre></div>' : ''),
  ].join("");
  detail.innerHTML = html;
}
function stringify(v){
  if (v == null) return String(v);
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

document.getElementById('btnExpandAll').addEventListener('click', () => { collapsed.clear(); renderTree(); });
document.getElementById('btnCollapseAll').addEventListener('click', () => {
  if (!state) return;
  collapsed.clear();
  // collapse every node that has at least one child
  const byParent = new Map();
  for (const n of state.nodes) {
    const p = n.parentId ?? "__root__";
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(n);
  }
  for (const n of state.nodes) {
    if ((byParent.get(n.id) || []).length > 0 && n.id !== state.rootId) collapsed.add(n.id);
  }
  renderTree();
});

async function tick(){
  try {
    const r = await fetch('/api/graph');
    const s = await r.json();
    state = s;
    document.getElementById('gid').textContent = s.id.slice(0,8);
    document.getElementById('ver').textContent = s.version;
    // Re-render on every tick so "running" durations tick in sync.
    renderTree();
    renderDetail();
    const conn = document.getElementById('conn');
    conn.textContent = '● live';
    conn.style.color = 'var(--ok)';
  } catch(e){
    const conn = document.getElementById('conn');
    conn.textContent = '⚠ ' + (e && e.message ? e.message : String(e));
    conn.style.color = 'var(--err)';
    console.error('[sp monitor]', e);
  }
  setTimeout(tick, 250);
}
tick();
</script>
</body>
</html>`;

export interface MonitorServer {
  server: Server;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export async function startMonitor(args: {
  graph: ComputationGraph;
  port?: number;
  host?: string;
}): Promise<MonitorServer> {
  const { graph, port = 4711, host = "127.0.0.1" } = args;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(HTML);
      return;
    }
    if (url === "/api/graph") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(graph.snapshot()));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => {
      server.off("error", onErr);
      reject(err);
    };
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.off("error", onErr);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const actualPort = addr.port;
  const url = `http://${host}:${actualPort}/`;
  return {
    server,
    port: actualPort,
    url,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
