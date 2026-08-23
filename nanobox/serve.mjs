#!/usr/bin/env node
// Static server for nanobox's browser artifact.
//
//   node serve.mjs [--port 8093] [--engine build/eh-nb/out.wasm.gzip] [--jit-dir build/eh-nb/jit]
//
//   /              -> web/index.html (links to claude.html, codex.html, agy.html)
//   /web/*, /*.html, /*.js  -> web/
//   /c2w/*         -> public/c2w/*  (the ORIGINAL engine, its JS glue, imagemounter, the images)
//   /engine/opt/out.wasm.gzip -> the OPTIMIZED engine (default build/eh-nb/out.wasm.gzip)
//   /engine/imagemounter.wasm.gzip -> build/imagemounter-nb.wasm.gzip (fixed MITM certs, build-imagemounter.sh) or the shipped one
//   /engine/opt/jit/*  -> pre-computed JIT bundles (.nbjb, harness --jit-bundle-out) from --jit-dir
//                      (default build/eh-nb/jit, created if missing); /engine/opt/jit/index.json is
//                      generated: {engineTag, files:[{name,size,mtime}]} so vm.html can pick the
//                      kernel/<image> bundles that exist (a real index.json in the dir wins)
//   /net/fetch     -> egress gateway (same as nanobox/server.mjs; only matters after sign-in)
//
// Sends the COOP/COEP headers the SharedArrayBuffer-based runtime needs. No dependencies.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, extname, normalize } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
await import("./web/jit-bundle.js"); // NanoboxJitBundle.engineTagInput/Format (same rule as the harness + worker)

const HERE = resolve(new URL(".", import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(opt("--port", process.env.PORT || 8093));
const ENGINE = resolve(HERE, opt("--engine", "build/eh-nb/out.wasm.gzip"));
const JITDIR = resolve(HERE, opt("--jit-dir", "build/eh-nb/jit"));
const MOUNTER = resolve(HERE, opt("--mounter", "build/imagemounter-nb.wasm.gzip"));
const WEB = join(HERE, "web");
try { mkdirSync(JITDIR, { recursive: true }); } catch {}
// engine tag of the served engine (gunzip + hash once, on the first index.json request; keyed by
// the file's mtime+size so a rebuilt engine gets a fresh tag)
let tagCache = null;
function engineTag() {
  if (!existsSync(ENGINE)) return null;
  const st = statSync(ENGINE); const id = st.size + ":" + st.mtimeMs;
  if (!tagCache || tagCache.id !== id) {
    const bytes = gunzipSync(readFileSync(ENGINE));
    tagCache = { id, tag: NanoboxJitBundle.engineTagFormat(bytes.length, createHash("sha256").update(NanoboxJitBundle.engineTagInput(bytes)).digest("hex")) };
  }
  return tagCache.tag;
}
function jitIndex(res) {
  const files = existsSync(JITDIR) ? readdirSync(JITDIR).filter((f) => f.endsWith(".nbjb")).map((f) => { const st = statSync(join(JITDIR, f)); return { name: f, size: st.size, mtime: st.mtime.toISOString() }; }) : [];
  let tag = null; try { tag = engineTag(); } catch (e) { console.log("[jit] engine tag failed: " + e.message); }
  headers(res, "index.json");
  res.end(JSON.stringify({ engineTag: tag, files }));
}
const C2W = resolve(HERE, "public/c2w");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".gzip": "application/octet-stream", ".gz": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png",
  ".nbjb": "application/octet-stream",
};
function headers(res, filePath) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("content-type", MIME[extname(filePath)] || "application/octet-stream");
}
function serveFile(req, res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) { res.writeHead(404); res.end("not found: " + filePath); return; }
  const st = statSync(filePath);
  headers(res, filePath);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Last-Modified", st.mtime.toUTCString());
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  res.setHeader("ETag", etag);
  // browser-side cache validation (web/cachefetch.js: HEAD to compare ETags; conditional GET -> 304)
  if (req.method === "HEAD") { res.setHeader("content-length", st.size); res.writeHead(200); res.end(); return; }
  if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
  const onErr = (s) => s.on("error", () => { try { res.destroy(); } catch {} });
  const range = req.headers.range;
  if (range) {
    // imagemounter fetches the OCI layers with Range requests -> must answer 206
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    onErr(createReadStream(filePath, { start, end })).pipe(res);
    return;
  }
  res.setHeader("content-length", st.size);
  onErr(createReadStream(filePath)).pipe(res);
}
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate", "host", "content-length"]);
await import("./web/netpolicy.js"); // NanoboxNetPolicy: the host allow-list shared with the pages
// client-side error reporting (web/native/src/report.js, pages): appended to work/client-errors.log
// as JSON lines and echoed here — the server-side cause of "Error writing file"-style CLI messages
const LOGDIR = resolve(HERE, "work"); try { mkdirSync(LOGDIR, { recursive: true }); } catch {}
async function clientLog(req, res) {
  const chunks = []; for await (const c of req) { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 1 << 20) break; }
  let recs = []; try { recs = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400); res.end(); return; }
  if (!Array.isArray(recs)) recs = [recs];
  const { appendFileSync } = await import("node:fs");
  for (const r of recs.slice(0, 500)) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString(), ip: req.socket.remoteAddress }, r));
    try { appendFileSync(join(LOGDIR, "client-errors.log"), line + "\n"); } catch {}
    console.log(`[client] ${r.kind || "?"} ${(r.message || r.key || "").toString().slice(0, 160)}${r.syscall ? " (" + r.syscall + " " + (r.path || "") + ")" : ""}${r.stack ? "\n    " + String(r.stack).split("\n").slice(1, 4).join("\n    ") : ""}`);
  }
  res.writeHead(204); res.end();
}
// A bundle recorded by the browser itself (window.nanobox.exportJit()): the sandbox runs the slim
// engine, which the harness cannot boot, so this is the only way to get precomputed JIT code whose
// engine tag matches what the page actually loads. Dev-server only: names are restricted to *.nbjb
// inside JITDIR, and the index is rebuilt from the directory on the next request anyway.
async function jitUpload(req, res, u) {
  try { await jitUploadInner(req, res, u); }
  catch (e) { console.log(`[jit] upload failed: ${e.message}`); try { res.writeHead(500); res.end(String(e.message)); } catch {} }
}
async function jitUploadInner(req, res, u) {
  const name = String(u.searchParams.get("name") || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!/^[a-zA-Z0-9._-]+\.nbjb$/.test(name)) { res.writeHead(400); res.end("bad name"); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const bytes = Buffer.concat(chunks);
  const file = join(JITDIR, name);
  // never let a run that recorded little overwrite a richer cache (an export from a non-recording run
  // is a few bytes and would silently destroy a good one)
  const had = existsSync(file) ? statSync(file).size : 0;
  if (bytes.length < had && u.searchParams.get("force") !== "1") {
    console.log(`[jit] refused ${name}: ${bytes.length} bytes would replace ${had}`);
    res.writeHead(409, { "content-type": "text/plain" }); res.end(`refused: ${bytes.length} < ${had}`); return;
  }
  try { writeFileSync(file, bytes); } catch (e) { res.writeHead(500); res.end(String(e.message)); return; }
  console.log(`[jit] saved ${name} (${(bytes.length / 1e6).toFixed(1)} MB) from the browser`);
  res.writeHead(200, { "content-type": "text/plain" }); res.end(`${name} ${bytes.length}`);
}

async function netFetch(req, res) {
  let spec;
  try { spec = JSON.parse(Buffer.from(req.headers["x-nanobox-target"] || "", "base64url").toString("utf8")); if (!/^https?:$/.test(new URL(spec.url).protocol)) throw 0; }
  catch { res.writeHead(400); res.end("bad target"); return; }
  // allow-list: the relay exists only for vendors that don't answer CORS; everything else must be
  // fetched by the browser directly (closes the open-proxy / SSRF-into-localhost hole)
  if (!globalThis.NanoboxNetPolicy.isProxied(spec.url)) { console.log(`[net] ${spec.method} ${spec.url} -> 403 (not in the relay allow-list; fetch it directly)`); res.writeHead(403); res.end("host not relayed: fetch it directly from the browser (see web/netpolicy.js)"); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const h = {}; for (const [k, v] of Object.entries(spec.headers || {})) if (!HOP.has(k.toLowerCase())) h[k] = v;
  try {
    const r = await fetch(spec.url, { method: spec.method || "GET", headers: h, body: ["GET", "HEAD"].includes(spec.method) ? undefined : body, redirect: "manual" });
    console.log(`[net] ${spec.method} ${spec.url} -> ${r.status}`);
    // node's fetch already decoded gzip/br bodies; forwarding the upstream content-encoding made the
    // browser try to decode again (ERR_CONTENT_DECODING_FAILED -> empty body -> codex "EOF while parsing")
    // node's fetch already decoded gzip/br bodies, so content-encoding AND content-length would both
    // describe the wire form, not what we forward (a kept content-encoding made the browser decode
    // twice -> ERR_CONTENT_DECODING_FAILED -> empty body -> codex "EOF while parsing")
    const out = {}; r.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding" && k !== "content-length") out[k] = v; });
    res.writeHead(r.status, out);
    // STREAM the body through instead of buffering it: MCP's "streamable HTTP" transport keeps the
    // response open (SSE), so `await r.arrayBuffer()` never resolves and the guest's client gives up
    // with "Transport channel closed, when send initialized notification" (codex_apps at startup).
    if (!r.body) { res.end(); return; }
    const reader = r.body.getReader();
    res.on("close", () => { try { reader.cancel(); } catch {} });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
      if (typeof res.flush === "function") res.flush();
    }
    res.end();
  } catch (e) { console.log(`[net] ${spec.method} ${spec.url} -> error ${e.message}`); res.writeHead(502); res.end(String(e.message)); }
}

// `npm start` semantics: if a previous serve.mjs still holds the port, replace it (kill it and listen
// again); a foreign process on the port is an error. Only processes whose command line is our
// serve.mjs are ever killed (found through /proc, no pkill patterns).
function killPreviousServer() {
  let killed = 0;
  try {
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      if (Number(pid) === process.pid) continue;
      let argv = []; try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
      // exactly `node .../serve.mjs [--port N]` (argv, not a substring: a shell whose command LINE
      // mentions serve.mjs must not match), on the same port
      if (!/(^|\/)node$/.test(argv[0] || "") || !/(^|\/)serve\.mjs$/.test(argv[1] || "")) continue;
      const pi = argv.indexOf("--port"); const theirPort = pi >= 0 ? Number(argv[pi + 1]) : 8093;
      if (theirPort === PORT) {
        try { process.kill(Number(pid), "SIGTERM"); killed++; } catch {}
      }
    }
  } catch {}
  return killed;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (process.env.LOG_REQ) res.on("finish", () => console.log(`${res.statusCode} ${req.method} ${url.pathname}${req.headers.range ? " [" + req.headers.range + "]" : ""}`));
  let p = normalize(decodeURIComponent(url.pathname));
  if (req.method === "POST" && p === "/net/fetch") return netFetch(req, res);
  if (req.method === "POST" && p === "/log") return clientLog(req, res);
  if (req.method === "POST" && p === "/jit/upload") return jitUpload(req, res, url);
  if (p === "/") {
    res.writeHead(302, { Location: "/sandbox.html?cli=codex&shell=1&aot=1&jit=2%3A2000&bundle=1&cache=1&jitfast=1" });
    res.end();
    return;
  }
  if (p === "/engine/opt/out.wasm.gzip") return serveFile(req, res, ENGINE);
  if (p === "/engine/opt/slim/out.wasm.gzip") return serveFile(req, res, ENGINE.replace(/out\.wasm\.gzip$/, "out-slim.wasm.gzip")); // no boot.iso; not for identity pages
  // network stack + 9p image server (imagemounter.wasm) with nanobox's fix (build-imagemounter.sh:
  // MITM certificates carry a NotBefore; upstream leaves Go's zero time = year 1, which webpki/rustls
  // clients such as codex reject) — falls back to the shipped one when not built
  if (p === "/engine/imagemounter.wasm.gzip") return serveFile(req, res, existsSync(MOUNTER) ? MOUNTER : join(C2W, "imagemounter.wasm.gzip"));
  if (p === "/engine/opt/jit/index.json" && !existsSync(join(JITDIR, "index.json"))) return jitIndex(res);
  if (p.startsWith("/engine/opt/jit/")) return serveFile(req, res, join(JITDIR, p.slice(16)));
  if (p.startsWith("/c2w/")) return serveFile(req, res, join(C2W, p.slice(5)));
  if (p.startsWith("/web/")) return serveFile(req, res, join(WEB, p.slice(5)));
  return serveFile(req, res, join(WEB, p));
});
const announce = () => console.log(`nanobox: http://localhost:${PORT}/  (optimized engine: ${ENGINE}${existsSync(ENGINE) ? "" : "  <-- MISSING"}; JIT bundles: ${JITDIR})`);
let retried = false;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && !retried) {
    retried = true;
    const n = killPreviousServer();
    console.log(`port ${PORT} busy: ${n ? "replaced the previous serve.mjs (" + n + " process)" : "held by another process, retrying once"}`);
    setTimeout(() => server.listen(PORT), 700);
    return;
  }
  console.error(String(e && e.message || e)); process.exit(1);
});
server.once("listening", announce);
server.listen(PORT);
