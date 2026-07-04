import { createServer, request as httpRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import * as esbuild from "esbuild";
import type { ComputationGraph } from "./graph.js";
import { callClaude } from "./claude-cli.js";
import { runShell } from "./engine.js";
import { realIO, type IO } from "./io.js";
import { FatalShellError } from "./errors.js";

// Bundle the Preact monitor UI (src/client/main.tsx) into a single classic
// IIFE that the HTML response embeds inline. Zero dynamic imports, zero
// network calls — runs under a plain <script> tag on any ES2020 browser.
//
// Done at server boot (not build time) so the same `tsx build.ts ...`
// invocation that compiles the engine also bakes the latest client into
// the dist bundle. esbuild follows JSX + tsx natively, resolves "preact"
// and "preact/hooks" through the repo's node_modules, inlines them.
const require = createRequire(fileURLToPath(import.meta.url));

/** Resolve the client entry once (src/client/main.tsx), robust to whether
 *  server.ts runs via tsx (from src/server/) or from a sibling/dist layout. */
function resolveClientEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "client", "main.tsx"),                  // running from src/server/
    resolve(here, "..", "src", "client", "main.tsx"),           // running from a sibling dir
    resolve(here, "..", "..", "src", "client", "main.tsx"),     // running from dist/
  ];
  return candidates.find(p => {
    try { require.resolve(p); return true; } catch { return false; }
  }) ?? candidates[0];
}

function runEsbuild(entry: string): string {
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    write: false,
    jsx: "automatic",
    jsxImportSource: "preact",
    nodePaths: [
      resolve(dirname(require.resolve("preact/package.json")), ".."),
    ],
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * Newest mtime (ms) across every client source file, so we can re-bundle the
 * Preact UI on demand in dev without restarting the engine. Walks the
 * `src/client/` tree once per request (a handful of stat() calls — cheap) and
 * returns the max mtime; a missing dir returns 0 so the first bundle still
 * runs. Only `.ts`/`.tsx` files count (styles/assets are inlined in the .tsx).
 */
function newestClientMtime(entry: string): number {
  const clientRoot = dirname(entry); // src/client/
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".git") continue;
        walk(full);
      } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  walk(clientRoot);
  return newest;
}

/**
 * mtime-cached client bundler. On each call it stats the client source tree;
 * if nothing changed since the cached bundle it returns the cache (no esbuild
 * run). On a source change it re-bundles and refreshes the cache. If esbuild
 * THROWS (a typo mid-edit), it keeps serving the last-good bundle and stashes
 * the error text in `lastBundleError` so the page can surface it instead of
 * blanking — and it does NOT advance `cachedMtime`, so the next refresh after
 * the fix re-bundles again. First call bundles unconditionally.
 */
let clientEntry: string | null = null;
let cachedBundle: string | null = null;
let cachedMtime = -1;
let lastBundleError: string | null = null;

function getClientBundle(): { js: string; error: string | null } {
  if (clientEntry === null) clientEntry = resolveClientEntry();
  const mtime = newestClientMtime(clientEntry);
  if (cachedBundle !== null && mtime === cachedMtime) {
    return { js: cachedBundle, error: lastBundleError };
  }
  try {
    const js = runEsbuild(clientEntry);
    cachedBundle = js;
    cachedMtime = mtime;
    lastBundleError = null;
    return { js, error: null };
  } catch (err) {
    lastBundleError = err instanceof Error ? (err.message + (err.stack ? "" : "")) : String(err);
    // Keep last-good bundle if we have one; otherwise surface the error inline.
    if (cachedBundle !== null) return { js: cachedBundle, error: lastBundleError };
    const safe = JSON.stringify(lastBundleError);
    const fallback = `document.getElementById("root").innerHTML =
      '<pre style="color:#f85149;white-space:pre-wrap;padding:20px">client bundle error:\\n' +
      ${safe}.replace(/[<>&]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];}) + '</pre>';`;
    return { js: fallback, error: lastBundleError };
  }
}

/**
 * Build the monitor HTML with the current client bundle inlined. Called
 * per-request (cheap: the bundle itself is mtime-cached by getClientBundle).
 * When a re-bundle failed but a last-good bundle exists, a small red banner
 * is injected above the app announcing the stale bundle + esbuild error.
 */
function renderHtml(): string {
  const { js, error } = getClientBundle();
  const errorBanner = error
    ? `<script>console.error(${JSON.stringify("client re-bundle failed (serving last good bundle):\n" + error)});
       window.addEventListener("DOMContentLoaded", function(){
         var b=document.createElement("div");
         b.style.cssText="position:fixed;top:0;left:0;right:0;z-index:9999;background:#5a1d1d;color:#ffb4b4;font:11px ui-monospace,monospace;padding:4px 10px;white-space:pre-wrap;border-bottom:1px solid #f85149";
         b.textContent=${JSON.stringify("client re-bundle failed — showing last good UI. " + error.split("\n")[0])};
         document.body.appendChild(b);
       });</script>`
    : "";
  return HTML_HEAD + `<script>${js}</script>` + errorBanner + HTML_TAIL;
}

const HTML_HEAD = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Structured Prompting Monitor</title>
<style>
  :root { --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --ok:#3fb950; --err:#f85149; --run:#e3b341; --pending:#484f58; --sel:#1f6feb; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); height:100vh; }
  #tree { width:46%; overflow:auto; border-right:1px solid #30363d; padding:12px; height:100vh; }
  #detail { flex:1; overflow:auto; padding:12px; height:100vh; }
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
  .cv-spinner { display:inline-block; animation: cvspin 0.9s linear infinite; }
  @keyframes cvspin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
  .kind { color:var(--muted); }
  .label { overflow:hidden; text-overflow:ellipsis; }
  .dur { color:var(--muted); font-size:11px; margin-left:auto; padding-left:8px; flex-shrink:0; }
  .dur .sep { color:#30363d; margin:0 3px; }
  .dur .cum { color:#6e7681; }
  pre { background:#161b22; padding:10px; border-radius:4px; max-height:45vh; overflow:auto; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; font-size:12px; color:#c9d1d9; }
  .sect { margin-top:14px; }
  .sect h2 { font-size:12px; color:var(--muted); font-weight:normal; text-transform:uppercase; letter-spacing:0.06em; margin:0 0 4px; display:flex; align-items:center; gap:6px; }
  .meta span { margin-right:12px; color:var(--muted); }
  .meta b { color:var(--fg); font-weight:normal; }
  #banner { padding:8px 12px; background:#161b22; border-bottom:1px solid #30363d; margin-bottom:8px; }
  #toolbar { padding:6px 0 10px; display:flex; gap:6px; align-items:center; }
  #toolbar button { background:#21262d; color:var(--fg); border:1px solid #30363d; padding:4px 10px; font:inherit; font-size:11px; border-radius:4px; cursor:pointer; }
  #toolbar button:hover { background:#30363d; }
  #conn { color:var(--ok); }
  .revealBtn { background:#21262d; color:var(--muted); border:1px solid #30363d; padding:0 6px; font:inherit; font-size:10px; border-radius:3px; cursor:pointer; margin-left:6px; line-height:16px; }
  .revealBtn:hover { background:#30363d; color:var(--fg); }
  .json-key { color:#79c0ff; }
  .json-str { color:#a5d6ff; }
  .json-prim { color:#d2a8ff; }
  .json-null { color:#8b949e; font-style:italic; }
  .lsfull-body { margin:4px 0 8px; background:#0b1220; padding:8px 10px; border-radius:4px; font-size:12px; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; max-height:50vh; overflow:auto; color:#a5d6ff; border-left:2px solid #1f6feb; }
  #bootfallback { padding:20px; color:#8b949e; font-size:13px; }
  #bootfallback b { color:#c9d1d9; }
  .tier0 { padding-left:0 }
  .tier1 { padding-left:14px }
  .tier2 { padding-left:28px }
  .tier3 { padding-left:42px }
  .tier4 { padding-left:56px }
  .tier5 { padding-left:70px }
  .tier6 { padding-left:84px }
  .tier7 { padding-left:98px }
  .tier8 { padding-left:112px }
  .tier9 { padding-left:126px }
  .tier10 { padding-left:140px }
  .tier11 { padding-left:154px }
  .tier12 { padding-left:168px }
  .tier13 { padding-left:182px }
  .tier14 { padding-left:196px }
  .tier15 { padding-left:210px }
  .tier16 { padding-left:224px }
  .tier17 { padding-left:238px }
  .tier18 { padding-left:252px }
  .tier19 { padding-left:266px }
  .tier20 { padding-left:280px }
  .tier21 { padding-left:294px }
  .tier22 { padding-left:308px }
  .tier23 { padding-left:322px }
  .tier24 { padding-left:336px }
</style>
</head>
<body>
<div id="root">
  <div id="bootfallback">
    <b>Structured Prompting Monitor</b><br>
    Booting Preact UI… if this message is still visible after a few seconds
    the classic-script bundle didn't run — open DevTools → Console to see
    the error. The monitor needs no network access beyond this page.
  </div>
</div>
`;

// The client bundle + optional error banner are spliced in between HEAD and
// TAIL by renderHtml() on each request (see getClientBundle for the mtime
// cache). Kept as two constants so the `<script>` injection point is explicit.
const HTML_TAIL = `</body>
</html>`;

export interface MonitorServer {
  server: Server;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

interface AskRequest { nodeId: string; prompt: string }
interface AskReply {
  /** ID of the newly-created askFollowup node so the client can auto-select it. */
  newNodeId: string;
  text: string;
  sessionId: string | null;
  durationMs: number;
  costUsd: number | null;
  isError: boolean;
  errorMessage: string | null;
}

/**
 * POST /api/ask handler. Creates a new `askFollowup` graph node as a child
 * of the anchor node, runs `claude --resume <sid> --fork-session -p
 * <prompt>` so the original branch's session stays clean for further
 * forks, and finalizes the new node with the response. The new node is a
 * leaf side-branch (no downstream children, no engine interpretation),
 * so the rest of the graph is untouched.
 *
 * Persists via the graph's mutation hook — if `enablePersistence(path)`
 * was called, the snapshot on disk now includes this follow-up.
 */
interface RetryRequest {
  nodeId: string;
  /** When true (default), also reset every transitive successor in the
   *  graph so downstream nodes whose outputs were derived from this
   *  node's stale value get recomputed. Pass `false` to retry just this
   *  one node (useful when you know downstream nodes don't depend on
   *  this node's output value). */
  cascade?: boolean;
}
interface RetryReply {
  nodeId: string;
  kind: string;
  status: "ok" | "error";
  message: string;
  /** When cascade was true, the list of node ids that got reset to
   *  pending (this node + every transitive successor). The scheduler /
   *  legacy engine will re-fire each of them on its next pass. */
  resetNodeIds?: string[];
}

/**
 * POST /api/retry {nodeId}: re-run a node in place using its saved input.
 *
 * Useful when a downstream step crashed (e.g. record-rendering script
 * couldn't find a path) and the user wants to resume after fixing the
 * environment, without re-running the whole graph (which would re-burn
 * tokens on the upstream sends). For shell nodes the cwd is read off
 * `node.input.cwd` (saved by the engine at start time); for sends the
 * resume target is the node's own sessionId (the session we resumed from
 * the first time) and fork:true is forced so the original branch's
 * downstream resume points stay clean.
 */
async function handleRetry(rawBody: string, graph: ComputationGraph): Promise<RetryReply> {
  const body = JSON.parse(rawBody) as RetryRequest;
  if (!body.nodeId) throw new Error("/api/retry requires {nodeId}");
  const node = graph.get(body.nodeId);
  if (!node) throw new Error(`node not found: ${body.nodeId}`);

  // Cascade reset (default true): also reset every transitive successor
  // so downstream nodes whose outputs were derived from this stale value
  // get recomputed by the scheduler / legacy engine on its next pass.
  // The actual re-fire of the node happens below for shell/send kinds;
  // for everything else, resetSubtree returns the affected node ids and
  // the scheduler/engine handles re-execution.
  const cascade = body.cascade !== false;
  const resetNodeIds = cascade ? graph.resetSubtree(node.id) : (graph.resetNode(node.id), [node.id]);

  if (node.kind === "executeShell") {
    const input = (node.input ?? {}) as { cmd?: string; cwd?: string };
    if (!input.cmd) throw new Error("executeShell node has no saved cmd to retry");
    const cwd = input.cwd ?? process.cwd();
    graph.start(node.id);
    try {
      // TODO(types): runShell resolves to the captured stdout string only —
      // on success stderr is discarded (on failure it is folded into the
      // thrown StructuredError). The previous `{ stdout, stderr }` destructure
      // read undefined props off that string; record the stdout tail and leave
      // stderr empty to match the actual runShell contract.
      const stdout = await runShell({ cmd: input.cmd, cwd, io: realIO, nodeId: node.id });
      graph.finishOk(node.id, {
        stdoutTail: stdout.slice(-400),
        stderrTail: "",
        retried: true,
      });
      return { nodeId: node.id, kind: node.kind, status: "ok", message: "shell command succeeded", resetNodeIds };
    } catch (err) {
      graph.finishErr(node.id, err);
      const msg = err instanceof FatalShellError || err instanceof Error
        ? err.message
        : String(err);
      return { nodeId: node.id, kind: node.kind, status: "error", message: msg, resetNodeIds };
    }
  }

  if (node.kind === "send" || node.kind === "askFollowup") {
    const composed = (node.output && typeof (node.output as { composedPrompt?: unknown }).composedPrompt === "string")
      ? (node.output as { composedPrompt: string }).composedPrompt
      : (node.input && typeof (node.input as { prompt?: unknown }).prompt === "string")
        ? (node.input as { prompt: string }).prompt
        : null;
    if (!composed) throw new Error(`${node.kind} node has no composedPrompt or prompt to retry`);
    // For retry we ALWAYS fork (whether or not the original send did).
    // The original sessionId on this node is the session we resumed FROM
    // last time — re-using it keeps the conversation context identical.
    // fork:true ensures the retry doesn't append a turn to that session
    // and pollute downstream resume points.
    graph.start(node.id);
    try {
      const r = await callClaude({
        prompt: composed,
        resume: node.sessionId,
        fork: true,
        model: (node.model as never) ?? undefined,
      });
      if (r.isError) {
        graph.finishErr(node.id, { message: r.errorMessage ?? "retry failed", data: { stderr: r.stderr } });
        return { nodeId: node.id, kind: node.kind, status: "error", message: r.errorMessage ?? "send returned isError", resetNodeIds };
      }
      graph.finishOk(
        node.id,
        {
          text: r.text,
          composedPrompt: composed,
          durationMs: r.durationMs,
          appliedForkFlag: true,
          usage: r.usage,
          retried: true,
        },
        { sessionId: r.sessionId, model: node.model },
      );
      return { nodeId: node.id, kind: node.kind, status: "ok", message: "send returned " + r.text.length + " chars", resetNodeIds };
    } catch (err) {
      graph.finishErr(node.id, err);
      throw err;
    }
  }

  throw new Error(`node kind "${node.kind}" is not retryable from the UI (callbacks were stripped at engine exit)`);
}

async function handleAsk(rawBody: string, graph: ComputationGraph): Promise<AskReply> {
  const body = JSON.parse(rawBody) as AskRequest;
  if (!body.nodeId || !body.prompt) {
    throw new Error("/api/ask requires {nodeId, prompt}");
  }
  const node = graph.get(body.nodeId);
  if (!node) throw new Error(`node not found: ${body.nodeId}`);

  // Walk the parentId chain to find the nearest ancestor that carries a
  // claude sessionId. The clicked node may be a parallelFork / pipe /
  // root with no sessionId of its own — in that case we fork from the
  // most recent ancestor send. The new askFollowup node still parents
  // the CLICKED node (so the user sees the question attached where they
  // clicked it), even though the resume happens against the anchor.
  let anchor = node;
  while (!anchor.sessionId && anchor.parentId) {
    const next = graph.get(anchor.parentId);
    if (!next) break;
    anchor = next;
  }
  if (!anchor.sessionId) {
    throw new Error(
      "no completed send in this branch yet — wait for the first claude " +
      "round-trip to finish (sessionIds are populated when claude returns)",
    );
  }
  const anchorModel = anchor.model ?? node.model;

  // Create the askFollowup node BEFORE the CLI call so the monitor's
  // 250ms poll picks it up in the "running" state and the user sees
  // immediate feedback. parentId === containerId === clicked.id puts it
  // visually under the clicked node in the tree.
  const labelPreview = body.prompt.slice(0, 60).replace(/\s+/g, " ").trim();
  const newNode = graph.create({
    parentId: node.id,
    containerId: node.id,
    kind: "askFollowup",
    label: labelPreview,
    input: { prompt: body.prompt, anchorNodeId: anchor.id },
  });
  graph.start(newNode.id, { model: anchorModel, sessionId: anchor.sessionId });

  try {
    const r = await callClaude({
      prompt: body.prompt,
      resume: anchor.sessionId,
      // Always fork: the anchor's session is shared with downstream sends
      // in the original execution; a non-forked ad-hoc reply would push a
      // new turn into that history and contaminate any future resume.
      fork: true,
      model: (anchorModel as never) ?? undefined,
    });
    if (r.isError) {
      graph.finishErr(newNode.id, { message: r.errorMessage ?? "ask follow-up failed", data: { stderr: r.stderr } });
    } else {
      graph.finishOk(
        newNode.id,
        {
          text: r.text,
          composedPrompt: body.prompt,
          durationMs: r.durationMs,
          appliedForkFlag: true,
          anchorNodeId: anchor.id,
          usage: r.usage,
        },
        { sessionId: r.sessionId, model: anchorModel },
      );
    }
    return {
      newNodeId: newNode.id,
      text: r.text,
      sessionId: r.sessionId,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
      isError: r.isError,
      errorMessage: r.errorMessage,
    };
  } catch (err) {
    graph.finishErr(newNode.id, err);
    throw err;
  }
}

interface InjectRequest {
  nodeId: string;
  /** The new user message to send into THIS node's existing session. */
  message: string;
}
interface InjectReply {
  nodeId: string;
  kind: string;
  status: "ok" | "error";
  /** Node ids whose completed state was ERASED (this node + every
   *  transitive successor). The scheduler / legacy engine re-fires each
   *  on its next pass; the node itself was already re-run here. */
  resetNodeIds: string[];
  /** Anchor session id the message was resumed against (NO fork). */
  sessionId: string | null;
  text: string;
  message: string;
  durationMs: number;
  costUsd: number | null;
  isError: boolean;
  errorMessage: string | null;
}

/**
 * POST /api/inject {nodeId, message}: send a NEW message into a node's
 * EXISTING claude session and re-run that node from the message — under
 * the SAME session (NO --fork-session), unlike /api/ask which always
 * forks into a side branch.
 *
 * Semantics (the user's ask): "select a node, type a message (no fork,
 * under the same session), then after it finishes that node and its
 * dependencies continue — erase completed state". So this handler:
 *
 *   1. resolves the node + its anchor sessionId (walk parentId like
 *      handleAsk, since the clicked node may be a container with no
 *      session of its own);
 *   2. ERASES completed state of the node AND every transitive successor
 *      via graph.resetSubtree(nodeId) — they recompute downstream;
 *   3. re-runs the node by calling claude with the injected message and
 *      `fork: false` (same session, conversation history extended), then
 *      finishOk/finishErr the node with the result — mirroring
 *      handleRetry's send/askFollowup branch but fork:false and
 *      prompt = the injected message.
 *
 * Downstream re-firing of the reset successors is the scheduler's job;
 * this endpoint's contract is exactly: erase node+successors' completed
 * state and re-run the node with the no-fork message.
 *
 * `io` is injected only for tests (MockIO); production passes realIO via
 * callClaude's default.
 */
async function handleInject(rawBody: string, graph: ComputationGraph, io?: IO): Promise<InjectReply> {
  const body = JSON.parse(rawBody) as InjectRequest;
  if (!body.nodeId || !body.message) {
    throw new Error("/api/inject requires {nodeId, message}");
  }
  const node = graph.get(body.nodeId);
  if (!node) throw new Error(`node not found: ${body.nodeId}`);

  // Resolve the resume anchor: nearest ancestor (via parentId) carrying a
  // sessionId. Same walk as handleAsk — the clicked node may be a
  // parallelFork / pipe / root with no session of its own.
  let anchor = node;
  while (!anchor.sessionId && anchor.parentId) {
    const next = graph.get(anchor.parentId);
    if (!next) break;
    anchor = next;
  }
  if (!anchor.sessionId) {
    throw new Error(
      "no completed send in this branch yet — wait for the first claude " +
      "round-trip to finish (sessionIds are populated when claude returns)",
    );
  }
  const anchorModel = anchor.model ?? node.model;

  // ERASE completed state: this node + every transitive successor reset to
  // pending (output/error/timestamps cleared). Capture the ids so the
  // caller can report what was reset; the scheduler re-fires them next pass.
  const resetNodeIds = graph.resetSubtree(node.id);

  // Re-run THIS node with the injected message, resuming the SAME session
  // (fork:false). Unlike /api/ask, no new node is created and no fork
  // flag is added — the message is appended to the live conversation.
  graph.start(node.id, { model: anchorModel ?? undefined, sessionId: anchor.sessionId });
  try {
    const r = await callClaude({
      prompt: body.message,
      resume: anchor.sessionId,
      fork: false,
      model: (anchorModel as never) ?? undefined,
      io,
    });
    if (r.isError) {
      graph.finishErr(node.id, { message: r.errorMessage ?? "inject failed", data: { stderr: r.stderr } });
      return {
        nodeId: node.id, kind: node.kind, status: "error", resetNodeIds,
        sessionId: r.sessionId, text: r.text, message: body.message,
        durationMs: r.durationMs, costUsd: r.costUsd,
        isError: true, errorMessage: r.errorMessage ?? "send returned isError",
      };
    }
    graph.finishOk(
      node.id,
      {
        text: r.text,
        composedPrompt: body.message,
        durationMs: r.durationMs,
        appliedForkFlag: false,
        injected: true,
        usage: r.usage,
      },
      { sessionId: r.sessionId, model: anchorModel },
    );
    return {
      nodeId: node.id, kind: node.kind, status: "ok", resetNodeIds,
      sessionId: r.sessionId, text: r.text, message: body.message,
      durationMs: r.durationMs, costUsd: r.costUsd,
      isError: false, errorMessage: null,
    };
  } catch (err) {
    graph.finishErr(node.id, err);
    throw err;
  }
}

export { handleInject };

// ── Conversation transcript (Claude web-UI viewer) ─────────────────────────
//
// The monitor's ConversationView reads the CLI transcript for a send node's
// sessionId and renders it as a Claude-web-UI-style chat, plus a sticky
// composer that continues the SAME session (resume, no fork) with SSE
// streaming. These handlers back that view.

/** A normalized content block on a transcript turn. Mirrors the CLI JSONL
 *  block shapes but trims them to what the client renders. */
interface TranscriptBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image" | "document" | "unknown";
  /** text / thinking body */
  text?: string;
  /** tool_use */
  name?: string;
  input?: unknown;
  id?: string;
  /** tool_result linkage + body (string, or nested blocks flattened to text/images) */
  toolUseId?: string;
  isError?: boolean;
  resultText?: string;
  /** image (base64 data URL) — used by both `image` blocks and image tool_results */
  dataUrl?: string;
  /** raw for anything we don't special-case */
  raw?: unknown;
}

interface TranscriptTurn {
  role: "user" | "assistant";
  uuid: string | null;
  timestamp: string | null;
  cwd: string | null;
  blocks: TranscriptBlock[];
}

interface TranscriptReply {
  sessionId: string;
  /** Resolved absolute path of the .jsonl we parsed (for debugging). */
  path: string | null;
  /** Most-recent non-empty cwd seen in the transcript — the client sends
   *  follow-ups against this dir. */
  cwd: string | null;
  /** Which CLI produced the transcript — "claude" (~/.claude/projects) or
   *  "codex" (~/.codex/sessions rollout files). Null when nothing matched. */
  source: "claude" | "codex" | null;
  turns: TranscriptTurn[];
}

/** Turn a CLI content block into our normalized TranscriptBlock. */
function normalizeBlock(b: unknown): TranscriptBlock | null {
  if (typeof b === "string") return { type: "text", text: b };
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const t = typeof o.type === "string" ? o.type : "unknown";
  if (t === "text") return { type: "text", text: typeof o.text === "string" ? o.text : "" };
  if (t === "thinking") return { type: "thinking", text: typeof o.thinking === "string" ? o.thinking : "" };
  if (t === "tool_use") {
    return {
      type: "tool_use",
      name: typeof o.name === "string" ? o.name : "tool",
      input: o.input,
      id: typeof o.id === "string" ? o.id : undefined,
    };
  }
  if (t === "tool_result") {
    // content may be a string, or an array of {type:"text"|"image"} blocks.
    let resultText = "";
    let dataUrl: string | undefined;
    const c = o.content;
    if (typeof c === "string") {
      resultText = c;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") resultText += p.text;
          else if (p.type === "image") {
            const src = p.source as Record<string, unknown> | undefined;
            if (src && typeof src.data === "string") {
              const mt = typeof src.media_type === "string" ? src.media_type : "image/png";
              if (!dataUrl) dataUrl = `data:${mt};base64,${src.data}`;
            }
          }
        }
      }
    }
    return {
      type: "tool_result",
      toolUseId: typeof o.tool_use_id === "string" ? o.tool_use_id : undefined,
      isError: o.is_error === true,
      resultText,
      dataUrl,
    };
  }
  if (t === "image") {
    const src = o.source as Record<string, unknown> | undefined;
    if (src && src.type === "base64" && typeof src.data === "string") {
      const mt = typeof src.media_type === "string" ? src.media_type : "image/png";
      return { type: "image", dataUrl: `data:${mt};base64,${src.data}` };
    }
    // Some transcripts store an image as a file path; surface it as text.
    return { type: "image", text: typeof (src?.data) === "string" ? String(src?.data) : "(image)" };
  }
  if (t === "document") {
    return { type: "document", text: "(attached document)" };
  }
  return { type: "unknown", raw: b };
}

/**
 * Locate `<session>.jsonl` under `~/.claude/projects/*<dir>*` and parse it
 * into ordered turns. A session id is globally unique, so the first project
 * dir that contains the file wins. Non-message lines (mode, permission-mode,
 * summary, attachment, file-history-snapshot, system, …) are skipped.
 *
 * If no Claude transcript exists for this id we fall through to the codex
 * rollout parser (`readCodexTranscript`) so codex-driven sessions still get
 * a chat view. Both paths return the SAME normalized `TranscriptTurn[]`
 * shape; the `source` field says which CLI produced it. Never throws — a
 * parse/IO failure degrades to an empty transcript.
 */
function readTranscript(sessionId: string): TranscriptReply {
  const projectsRoot = join(homedir(), ".claude", "projects");
  let hit: string | null = null;
  try {
    if (existsSync(projectsRoot)) {
      for (const dir of readdirSync(projectsRoot)) {
        const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) { hit = candidate; break; }
      }
    }
  } catch { /* fall through to codex */ }

  // No Claude transcript for this id → try codex.
  if (!hit) return readCodexTranscript(sessionId);

  const turns: TranscriptTurn[] = [];
  let cwd: string | null = null;
  try {
    const raw = readFileSync(hit, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
      const type = o.type;
      if (type !== "user" && type !== "assistant") continue;
      const msg = o.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      if (typeof o.cwd === "string" && o.cwd) cwd = o.cwd;
      const content = msg.content;
      const blocks: TranscriptBlock[] = [];
      if (typeof content === "string") {
        blocks.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          const nb = normalizeBlock(b);
          if (nb) blocks.push(nb);
        }
      }
      if (blocks.length === 0) continue;
      turns.push({
        role,
        uuid: typeof o.uuid === "string" ? o.uuid : null,
        timestamp: typeof o.timestamp === "string" ? o.timestamp : null,
        cwd: typeof o.cwd === "string" ? o.cwd : null,
        blocks,
      });
    }
  } catch {
    // A read/parse failure mid-file: return whatever we accumulated so far.
  }
  return { sessionId, path: hit, cwd, source: "claude", turns };
}

// ── Codex rollout transcript ───────────────────────────────────────────────
//
// Codex (`codex exec`, see codex-cli.ts) records each session as a JSONL
// "rollout" file under ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl,
// where <id> is the codex thread/session id (the `thread_id` codex-cli captures
// as `sessionId`, and the `payload.id` on the leading `session_meta` line).
//
// Line schema (verified against codex 0.135–0.140 rollouts on disk):
//   {"type":"session_meta","payload":{"id","cwd","cli_version",…}}   ← first line
//   {"type":"turn_context","payload":{…}}
//   {"type":"event_msg","payload":{"type":"task_started"|"token_count"|…}}
//   {"type":"response_item","payload":{ …OpenAI-style item… }}
// The `response_item` payloads are the conversation. Their `type` is one of:
//   message            role:"user"|"assistant"|"developer", content:[{type:
//                      "input_text"|"output_text"|"input_image", text|image_url}]
//   reasoning          summary:[{type:"summary_text",text}], encrypted_content
//   function_call      {name, arguments(JSON string), call_id}
//   function_call_output {call_id, output: string | [{type:"input_image"|
//                      "input_text", image_url|text}]}
//   custom_tool_call   {name, input(string), call_id}   (e.g. apply_patch)
//   custom_tool_call_output {call_id, output(string)}
//
// Mapping onto our normalized blocks:
//   user/developer input_text  → user   text
//   assistant output_text      → assistant text
//   reasoning summary_text     → assistant thinking (encrypted-only → skipped)
//   function_call / custom_tool_call        → assistant tool_use (name+input)
//   function_call_output / custom_tool_call_output → user tool_result
//   input_image (data URL)     → image block on the owning turn
//
// Ordering + timestamps are preserved from the file. Unknown types are skipped
// and the parser never throws (returns {turns:[]} on any failure).

/** Find the codex rollout file whose filename embeds `sessionId`. The id is
 *  the trailing UUID in `rollout-<ISO>-<uuid>.jsonl`, so a filename `.includes`
 *  match on the id is sufficient and cheap (no need to open every file). */
function findCodexRollout(sessionId: string): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!sessionId || !existsSync(root)) return null;
  // Layout is sessions/YYYY/MM/DD/rollout-*.jsonl — walk 3 levels of dirs.
  const walk = (dir: string, depth: number): string | null => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return null; }
    // At leaf depth, match rollout files; otherwise recurse into subdirs.
    for (const name of entries) {
      const full = join(dir, name);
      if (depth >= 3) {
        if (name.endsWith(".jsonl") && name.includes(sessionId)) return full;
      } else {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root, 0);
}

/** One block of codex message `content[]` (input_text/output_text/input_image). */
function codexContentBlocks(content: unknown): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const pt = p.type;
    if ((pt === "input_text" || pt === "output_text" || pt === "text") && typeof p.text === "string") {
      if (p.text) out.push({ type: "text", text: p.text });
    } else if ((pt === "input_image" || pt === "image") && typeof p.image_url === "string") {
      // image_url is already a data: URL in codex rollouts.
      out.push({ type: "image", dataUrl: p.image_url });
    }
  }
  return out;
}

/** Turn a codex `function_call_output` / `custom_tool_call_output` `output`
 *  field (string, or an array of input_text/input_image parts) into a
 *  tool_result block. */
function codexToolResult(callId: string | undefined, output: unknown, isError: boolean): TranscriptBlock {
  let resultText = "";
  let dataUrl: string | undefined;
  if (typeof output === "string") {
    resultText = output;
  } else if (Array.isArray(output)) {
    for (const part of output) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
        resultText += p.text;
      } else if ((p.type === "input_image" || p.type === "image") && typeof p.image_url === "string") {
        if (!dataUrl) dataUrl = p.image_url;
      }
    }
  } else if (output && typeof output === "object") {
    // Some codex versions nest {content:[…]} or {output:"…"}.
    const o = output as Record<string, unknown>;
    if (typeof o.output === "string") resultText = o.output;
    else if (Array.isArray(o.content)) {
      for (const part of o.content) {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          resultText += (part as Record<string, unknown>).text as string;
        }
      }
    }
  }
  return { type: "tool_result", toolUseId: callId, isError, resultText, dataUrl };
}

function readCodexTranscript(sessionId: string): TranscriptReply {
  const hit = findCodexRollout(sessionId);
  if (!hit) return { sessionId, path: null, cwd: null, source: null, turns: [] };

  const turns: TranscriptTurn[] = [];
  let cwd: string | null = null;
  try {
    const raw = readFileSync(hit, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
      const ts = typeof o.timestamp === "string" ? o.timestamp : null;

      // session_meta carries the working dir the session ran in.
      if (o.type === "session_meta") {
        const p = o.payload as Record<string, unknown> | undefined;
        if (p && typeof p.cwd === "string" && p.cwd) cwd = p.cwd;
        continue;
      }
      if (o.type !== "response_item") continue;
      const p = o.payload as Record<string, unknown> | undefined;
      if (!p || typeof p !== "object") continue;
      const itemType = typeof p.type === "string" ? p.type : "";

      if (itemType === "message") {
        const rawRole = typeof p.role === "string" ? p.role : "user";
        // developer/system prompts render on the user side of the chat.
        const role: "user" | "assistant" = rawRole === "assistant" ? "assistant" : "user";
        const blocks = codexContentBlocks(p.content);
        if (blocks.length === 0) continue;
        turns.push({ role, uuid: null, timestamp: ts, cwd, blocks });
        continue;
      }

      if (itemType === "reasoning") {
        // Prefer human-readable summary_text; encrypted_content is opaque, skip.
        const summary = p.summary;
        let text = "";
        if (Array.isArray(summary)) {
          for (const s of summary) {
            if (s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string") {
              text += (s as Record<string, unknown>).text as string;
            }
          }
        }
        if (!text) continue; // encrypted-only reasoning has nothing to show
        turns.push({ role: "assistant", uuid: null, timestamp: ts, cwd, blocks: [{ type: "thinking", text }] });
        continue;
      }

      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const name = typeof p.name === "string" ? p.name : "tool";
        const callId = typeof p.call_id === "string" ? p.call_id : undefined;
        // function_call → `arguments` (JSON string); custom_tool_call → `input`.
        let input: unknown = p.arguments ?? p.input;
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch { /* keep the raw string */ }
        }
        turns.push({
          role: "assistant", uuid: null, timestamp: ts, cwd,
          blocks: [{ type: "tool_use", name, input, id: callId }],
        });
        continue;
      }

      if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        const callId = typeof p.call_id === "string" ? p.call_id : undefined;
        const block = codexToolResult(callId, p.output, false);
        turns.push({ role: "user", uuid: null, timestamp: ts, cwd, blocks: [block] });
        continue;
      }
      // Unknown response_item type → skip.
    }
  } catch {
    // Best-effort: return whatever was accumulated before the failure.
  }
  return { sessionId, path: hit, cwd, source: "codex", turns };
}

interface SessionSendRequest {
  sessionId: string;
  cwd?: string;
  message: string;
  images?: Array<{ media_type: string; data: string }>;
}

/**
 * POST /api/session-send: continue the SAME claude session (resume, NO fork)
 * with a new user message and stream the reply back as Server-Sent Events.
 *
 * Streaming frames (each `data:` line is one JSON object):
 *   {type:"delta", text}   — accumulated assistant text so far
 *   {type:"done",  text, sessionId}  — final assistant text + (new) session id
 *   {type:"error", error}  — the call failed
 *
 * Images are written to a per-call temp dir and referenced by absolute path
 * via callClaude's `attachments` (base64) mechanism, which appends the paths
 * to the prompt — the CLI then reads them as file attachments.
 */
async function handleSessionSend(rawBody: string, res: ServerResponse): Promise<void> {
  let body: SessionSendRequest;
  try {
    body = JSON.parse(rawBody) as SessionSendRequest;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  if (!body.sessionId || !body.message) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "/api/session-send requires {sessionId, message}" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const emit = (obj: unknown) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
  };

  // Materialize attached images so the CLI can read them. callClaude accepts
  // base64 `attachments`, dumps them to a scratch dir, and appends the paths
  // to the prompt (then cleans up in its finally). We pass PNG/JPEG bytes as-is.
  const attachments = Array.isArray(body.images)
    ? body.images.map(i => i.data).filter(d => typeof d === "string")
    : [];

  try {
    const r = await callClaude({
      prompt: body.message,
      resume: body.sessionId,
      fork: false,          // CONTINUE the same session — a real continuation.
      cwd: body.cwd,
      attachments,
      onPartialText: (textSoFar) => emit({ type: "delta", text: textSoFar }),
    });
    if (r.isError) {
      emit({ type: "error", error: r.errorMessage ?? "session-send failed" });
    } else {
      emit({ type: "done", text: r.text, sessionId: r.sessionId });
    }
  } catch (err) {
    emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    try { res.end(); } catch { /* already closed */ }
  }
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
      // Re-bundled on demand: renderHtml() → getClientBundle() stats the
      // client source tree and only re-runs esbuild when a .ts/.tsx changed.
      // Edit a client file → refresh the browser → new UI, no engine restart.
      res.end(renderHtml());
      return;
    }
    if (url === "/api/graph") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(graph.snapshot()));
      return;
    }
    if (url === "/api/retry" && req.method === "POST") {
      // POST /api/retry {nodeId}: re-run an existing node from its saved
      // input, in-place. Supported kinds:
      //   executeShell — re-run `cmd` in the saved `cwd`. Replaces output.
      //   send / askFollowup — re-call claude with the saved
      //     composedPrompt and the node's prior resume sessionId, fork:true.
      // Other kinds are not retryable from the UI (callbacks were stripped
      // from the snapshot at engine exit and cannot be re-invoked).
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void handleRetry(body, graph).then((reply) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(reply));
        }).catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
      return;
    }
    if (url === "/api/ask" && req.method === "POST") {
      // Ad-hoc follow-up question against a node's claude session. The
      // monitor UI exposes this as a textarea on send-node detail panels.
      // Body: {nodeId, prompt}. Looks up the node's sessionId, calls
      // `claude --resume <sid> -p <prompt>`, returns {text, sessionId,
      // durationMs, costUsd, usage}.
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void handleAsk(body, graph).then((reply) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(reply));
        }).catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
      return;
    }
    if (url.startsWith("/api/transcript") && req.method === "GET") {
      // GET /api/transcript?session=<id>: parse the CLI JSONL transcript for
      // this session into ordered {role, blocks[]} turns for the conversation
      // viewer. Returns {sessionId, path, cwd, turns}.
      const qi = url.indexOf("?");
      const params = new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : "");
      const session = params.get("session") ?? "";
      try {
        const reply = session ? readTranscript(session) : { sessionId: "", path: null, cwd: null, source: null, turns: [] };
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(reply));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    if (url === "/api/session-send" && req.method === "POST") {
      // POST /api/session-send {sessionId, cwd, message, images?}: continue the
      // same claude session (resume, no fork) and stream the reply as SSE.
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void handleSessionSend(body, res).catch((err: unknown) => {
          try {
            if (!res.headersSent) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            } else {
              res.write(`data: ${JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) })}\n\n`);
              res.end();
            }
          } catch { /* client gone */ }
        });
      });
      return;
    }
    if (url === "/api/inject" && req.method === "POST") {
      // POST /api/inject {nodeId, message}: send a new message into the
      // node's EXISTING claude session (NO fork) and re-run the node from
      // it. Erases the node + every transitive successor's completed state
      // (resetSubtree) so downstream recomputes, then re-calls
      // `claude --resume <sid> -p <message>` (no --fork-session). The
      // no-fork counterpart of /api/ask.
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void handleInject(body, graph).then((reply) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(reply));
        }).catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
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

  // Warm up: fire and forget a few self-requests so the first real visit
  // hits warm V8 JIT, warm route-dispatch closures, and a pre-built graph
  // snapshot. Without this the first /api/graph for a wave with ~200
  // nodes can stall the UI for several seconds on cold start.
  // Errors are swallowed — warmup is best-effort.
  const warmOne = (path: string): void => {
    const req = httpRequest({ host, port: actualPort, path, method: "GET" }, (res) => {
      res.on("data", () => { /* drain */ });
      res.on("error", () => { /* swallow */ });
    });
    req.on("error", () => { /* swallow */ });
    req.end();
  };
  warmOne("/");
  warmOne("/api/graph");

  return {
    server,
    port: actualPort,
    url,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
