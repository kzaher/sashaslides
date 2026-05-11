import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import type { ComputationGraph } from "./graph.js";
import { callClaude } from "./claude-cli.js";
import { runShell } from "./engine.js";
import { realIO } from "./io.js";
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

function bundleClientScript(): string {
  // Resolve the source entry relative to THIS file's location so the
  // bundle works whether server.ts is invoked from src/server/server.ts
  // (via tsx) or from dist/main-scaffolding.mjs (after build.ts). In
  // both cases src/client/main.tsx sits at ../../src/client/main.tsx
  // from THIS module if running via tsx, but at the dist path it ships
  // bundled — so prefer source-resolution from the import.meta.url-
  // derived dirname when the file exists; otherwise fall back to a
  // repo-root-relative search.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "client", "main.tsx"),                  // running from src/server/
    resolve(here, "..", "src", "client", "main.tsx"),           // running from a sibling dir
    resolve(here, "..", "..", "src", "client", "main.tsx"),     // running from dist/
  ];
  const entry = candidates.find(p => {
    try { require.resolve(p); return true; } catch { return false; }
  }) ?? candidates[0];
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

const BUNDLED_CLIENT = bundleClientScript();

const HTML = `<!doctype html>
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
<script>${BUNDLED_CLIENT}</script>
</body>
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
      const { stdout, stderr } = await runShell({ cmd: input.cmd, cwd, io: realIO, nodeId: node.id });
      graph.finishOk(node.id, {
        stdoutTail: stdout.slice(-400),
        stderrTail: stderr.slice(-400),
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
        { sessionId: r.sessionId, model: r.model ?? node.model },
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
        { sessionId: r.sessionId, model: r.model ?? anchorModel },
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
