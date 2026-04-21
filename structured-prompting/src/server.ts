import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import type { ComputationGraph } from "./graph.js";
import { CLIENT_SCRIPT } from "./server-client.js";

// Bundle Preact + hooks + server-client into a single classic IIFE. This
// dodges every cross-browser ESM / import-map quirk the monitor page used
// to hit: the emitted script has zero dynamic imports, zero network calls,
// and runs under a plain <script> tag on any browser that supports ES2020.
const require = createRequire(fileURLToPath(import.meta.url));

function bundleClientScript(): string {
  // Rewrite the exported CLIENT_SCRIPT (which was authored as an ES module
  // with `import { h, render } from "preact"` etc.) through esbuild along
  // with preact + preact/hooks as siblings. esbuild follows the "preact"
  // and "preact/hooks" specifiers through the repo's node_modules and
  // inlines everything.
  const tmp = mkdtempSync(join(tmpdir(), "sp-monitor-"));
  const entry = join(tmp, "client.js");
  writeFileSync(entry, CLIENT_SCRIPT);
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    write: false,
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
