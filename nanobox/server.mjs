#!/usr/bin/env node
// Static server for nanobox + a real-agent proxy.
//
// Static side: sends the cross-origin-isolation headers CheerpX/SharedArrayBuffer require.
// Agent side: POST /api/agent {tool:"claude"|"codex", prompt} runs the REAL claude-code / codex CLI
//   in a scratch working dir and returns its output. The in-browser VM can't execute Node binaries,
//   so the VM's `claude`/`codex` commands proxy here — this is a genuine agent response, not a shim.
//
//   node server.mjs            # http://localhost:8088
//
// No external dependencies. Node 18+.

import { createServer } from "node:http";
import { readFile, mkdir, stat as fsStat } from "node:fs/promises";
import { createReadStream, mkdtempSync } from "node:fs";
import { join, resolve, extname, normalize, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import wsPkg from "ws";
const WebSocketServer = wsPkg.Server || wsPkg.WebSocketServer;

const PORT = Number(process.env.PORT || 8088);
const PUBLIC_DIR = resolve(new URL("./public", import.meta.url).pathname);
const SCRATCH = "/tmp/nanobox-agent";
await mkdir(SCRATCH, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".bin": "application/octet-stream", ".map": "application/json",
};

function isolation(res, filePath) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("content-type", MIME[extname(filePath)] || "application/octet-stream");
}

// --- real agent runner -----------------------------------------------------
function runAgent(tool, prompt, model) {
  return new Promise((res) => {
    let cmd, args;
    if (tool === "codex") {
      cmd = "codex";
      args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt];
    } else {
      cmd = "claude";
      args = ["-p", "--model", model || "haiku", "--dangerously-skip-permissions", prompt];
    }
    const t0 = Date.now();
    let out = "", err = "";
    const child = spawn(cmd, args, { cwd: SCRATCH, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const killer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => { clearTimeout(killer); res({ ok: code === 0, output: (out.trim() || err.trim()), stderr: err.trim(), code, ms: Date.now() - t0 }); });
    child.on("error", (e) => { clearTimeout(killer); res({ ok: false, output: `${tool}: ${e.message}`, code: 127, ms: Date.now() - t0 }); });
  });
}

async function handleAgent(req, res) {
  let body = "";
  for await (const c of req) { body += c; if (body.length > 1 << 20) break; }
  let j;
  try { j = JSON.parse(body || "{}"); } catch { res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false,"output":"bad json"}'); return; }
  const tool = j.tool === "codex" ? "codex" : "claude";
  const prompt = String(j.prompt || "").slice(0, 4000);
  if (!prompt) { res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false,"output":"empty prompt"}'); return; }
  const result = await runAgent(tool, prompt, j.model);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}

// Safety net: never let a stray stream/socket error kill the server during a long autonomous run.
process.on("uncaughtException", (e) => console.error("[uncaught]", e && e.message || e));

const LOG_REQ = process.env.LOG_REQ === "1";
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (LOG_REQ) res.on("finish", () => console.error(`${res.statusCode} ${req.method} ${url.pathname}${req.headers.range ? " [" + req.headers.range + "]" : ""}`));
    if (url.pathname === "/api/agent" && req.method === "POST") return void (await handleAgent(req, res));
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (relative(PUBLIC_DIR, filePath).startsWith("..")) { res.writeHead(403).end(); return; }
    const st = await fsStat(filePath);
    if (st.isDirectory()) { res.writeHead(404).end("not found"); return; } // WebDevice probes dirs
    isolation(res, filePath);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Last-Modified", st.mtime.toUTCString()); // HttpBytesDevice requires this or ETag
    res.setHeader("ETag", `"${st.size}-${Math.floor(st.mtimeMs)}"`);
    const onStreamErr = (s) => s.on("error", () => { try { res.destroy(); } catch {} });
    const range = req.headers.range;
    if (range) {
      // HttpBytesDevice streams the ext2 image via Range requests → must answer 206.
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      onStreamErr(createReadStream(filePath, { start, end })).pipe(res);
      return;
    }
    res.setHeader("Content-Length", st.size);
    onStreamErr(createReadStream(filePath)).pipe(res); // stream (handles large files without buffering)
  } catch { res.writeHead(404).end("not found"); }
});

// --- live PTY bridge: browser xterm.js <-> real interactive claude/codex in a pseudo-terminal ---
// `script` gives the agent a real TTY so its interactive login/onboarding UI renders. A FRESH HOME
// (and a stripped env) means no existing credentials → the agent shows its real sign-in screen,
// which the user can complete from the browser. This runs the ACTUAL CLI, streamed live.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/pty")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws, req) => {
  const tool = new URL(req.url, "http://x").searchParams.get("tool") === "codex" ? "codex" : "claude";
  const home = mkdtempSync(join(tmpdir(), `nb-${tool}-`)); // fresh → unauthenticated → login screen
  const env = { PATH: process.env.PATH, TERM: "xterm-256color", HOME: home, USER: "nanobox",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", COLUMNS: "110", LINES: "32" };
  // stty sizes the pty before the agent reads it; exec replaces the shell so the agent owns the TTY.
  const child = spawn("script", ["-qfc", `stty cols 110 rows 32 2>/dev/null; exec ${tool}`, "/dev/null"],
    { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
  const send = (d) => { if (ws.readyState === 1) ws.send(d); };
  child.stdout.on("data", send);
  child.stderr.on("data", send);
  ws.on("message", (m) => { try { child.stdin.write(m); } catch {} });
  child.on("exit", (code) => { send(`\r\n[${tool} exited ${code}]\r\n`); try { ws.close(); } catch {} });
  child.on("error", (e) => { send(`\r\n[failed to start ${tool}: ${e.message}]\r\n`); try { ws.close(); } catch {} });
  ws.on("close", () => { try { child.kill("SIGKILL"); } catch {} });
});

server.listen(PORT, () => {
  console.log(`\n  nanobox: http://localhost:${PORT}`);
  console.log(`    /demo.html  — VM demo, real claude/codex via /api/agent`);
  console.log(`  agent scratch dir: ${SCRATCH}`);
  console.log(`  Chromium only. Cross-origin isolation ON.\n`);
});
