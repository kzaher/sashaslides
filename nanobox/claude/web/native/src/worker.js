// nanobox/claude — the Web Worker that runs Claude Code's cli.js on the browser's V8.
// Built by build.mjs into ../runtime.js (classic worker script). Page protocol: see ../../claude-native.html.
//
//   page -> worker: {type:"init", cfg}  {type:"stdin", data}  {type:"resize", cols, rows}  {type:"dump"}
//   worker -> page: {type:"event", event, ...}  {type:"stdout", fd, data}  {type:"exit", code}  {type:"missing", ...}
import { Buffer } from "buffer";
// the polyfills' CommonJS module objects (mutable: makeMisc adds the Node APIs they lack)
import events from "events";
import stream from "readable-stream";
import util from "util";
import path from "path-browserify";
import assert from "assert";
import string_decoder from "string_decoder";
import zlib from "browserify-zlib";
import crypto from "crypto-browserify";
import url from "url";
import querystring from "querystring-es3";
import bufferModule from "buffer";
import { MemBackend } from "./backend.js";
import { GuestBackend } from "./backend-guest.js";
import { makeFs } from "./fs.js";
import { makeTty, makeOs, makeProcess, ProcessExit } from "./process.js";
import { makeChildProcess, makeNet, makeHttp } from "./procnet.js";
import { makeMisc } from "./misc.js";
import { record, noteMissing, dump as dumpMissing, setOnFirst } from "./record.js";
import { esmToCjs } from "./esm2cjs.js";

const post = (m, transfer) => self.postMessage(m, transfer || []);
const T0 = performance.now();
const ev = (event, extra) => post(Object.assign({ type: "event", event, t: Math.round(performance.now() - T0) }, extra || {}));
const enc = new TextEncoder();

// the runtime's own helper scripts (shared with the VM pages)
importScripts(new URL("/wasifs.js", location.href).href, new URL("/oci.js", location.href).href, new URL("/cachefetch.js", location.href).href);

self.onmessage = (m) => { if (m.data && m.data.type === "init") { self.onmessage = null; main(m.data.cfg).catch((e) => { ev("fatal", { message: String(e && e.stack || e) }); }); } };

// --- egress: only the vendors that do not answer CORS go through the server's POST /net/fetch relay
// (web/netpolicy.js — the same allow-list the server enforces); everything else (npm registry,
// raw.githubusercontent, auth/api.openai, ...) is fetched directly by the browser. Bytes are counted
// per host and per path (direct / relayed / our origin) for the data-accounting table.
importScripts(new URL("/netpolicy.js", location.href).href);
const origFetch = self.fetch.bind(self);
const netlog = [];
const netBytes = { origin: 0, direct: 0, relayed: 0, hosts: {} };   // hosts: host -> { path, bytes, requests }
function countBytes(path, host, r) {
  const rec = netBytes.hosts[host] || (netBytes.hosts[host] = { path, bytes: 0, requests: 0 });
  rec.requests++;
  const len = Number(r && r.headers && r.headers.get("content-length")) || 0;
  if (len) { rec.bytes += len; netBytes[path] += len; return r; }
  // no content-length (chunked): count the body as it streams by
  if (!r || !r.body) return r;
  let n = 0;
  const counted = r.body.pipeThrough(new TransformStream({ transform(chunk, c) { n += chunk.byteLength; rec.bytes += chunk.byteLength; netBytes[path] += chunk.byteLength; c.enqueue(chunk); } }));
  return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
}
async function gatewayFetch(input, init = {}) {
  const url0 = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let target;
  try { target = new URL(url0, location.href); } catch { return origFetch(input, init); }
  if (target.origin === location.origin || !/^https?:$/.test(target.protocol)) return origFetch(input, init).then((r) => countBytes("origin", target.host, r));
  const method = (init.method || (typeof input === "object" && !(input instanceof URL) && input.method) || "GET").toUpperCase();
  if (!self.NanoboxNetPolicy.isProxied(target.hostname)) {
    netlog.push({ t: Math.round(performance.now() - T0), method, url: target.href, via: "direct" });
    ev("net", { method, url: target.href, via: "direct" });
    return origFetch(input, init).then((r) => countBytes("direct", target.hostname, r));
  }
  const headers = {};
  new Headers((typeof input === "object" && !(input instanceof URL) && input.headers) || init.headers || {}).forEach((v, k) => (headers[k] = v));
  let body = init.body;
  if (body === undefined && typeof input === "object" && !(input instanceof URL) && input.body) body = await input.arrayBuffer();
  if (body && typeof body.getReader === "function") body = await new Response(body).arrayBuffer();
  const spec = { url: target.href, method, headers };
  const encoded = btoa(String.fromCharCode(...enc.encode(JSON.stringify(spec)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  netlog.push({ t: Math.round(performance.now() - T0), method, url: target.href, via: "relay" });
  ev("net", { method, url: target.href, via: "relay" });
  return origFetch(new URL("/net/fetch", location.origin), { method: "POST", headers: { "x-nanobox-target": encoded }, body: ["GET", "HEAD"].includes(method) ? undefined : body, signal: init.signal }).then((r) => countBytes("relayed", target.hostname, r));
}

async function loadRootfs(cfg) {
  const F = self.NanoboxFs, Oci = self.NanoboxOci, Cache = self.NanoboxCache;
  const base = cfg.imageUrl;
  const t0 = performance.now();
  const j = async (u) => (await origFetch(u)).json();
  const index = await j(base + "index.json");
  const mdesc = index.manifests[0];
  const manifest = await j(base + "blobs/" + mdesc.digest.replace(":", "/"));
  const config = await j(base + "blobs/" + manifest.config.digest.replace(":", "/"));
  const root = F.dir();
  let files = 0, bytes = 0, skipped = [];
  // fetch all needed layers in parallel (Cache API by digest), apply in order
  const layers = manifest.layers.map((l, i) => ({ l, i }));
  // the layer that only holds usr/local/bin/node is dead weight for this page (V8 is the runtime):
  // find it through the image history (one non-empty history entry per layer) and don't fetch it
  const skip = new Set(cfg.skipLayers || []);
  if (cfg.skipNodeLayer) { let li = 0; for (const h of config.history || []) { if (h.empty_layer) continue; if (/COPY .*\/usr\/local\/bin\/node /.test(h.created_by || "")) skip.add(li); li++; } }
  const datas = await Promise.all(layers.map(async ({ l, i }) => {
    if (skip.has(i)) return null;
    let data = cfg.noCache ? null : await Cache.getBytes("layer:" + l.digest).catch(() => null);
    if (!data) {
      const gz = new Uint8Array(await (await origFetch(base + "blobs/" + l.digest.replace(":", "/"))).arrayBuffer());
      bytes += gz.byteLength;
      data = /gzip/.test(l.mediaType) ? await Oci.gunzip(gz) : gz;
      if (!cfg.noCache) Cache.putBytes("layer:" + l.digest, data).catch(() => {});
      ev("layer", { i, size: data.byteLength, cached: false });
    } else ev("layer", { i, size: data.byteLength, cached: true });
    return data;
  }));
  for (const { l, i } of layers) {
    if (!datas[i]) { skipped.push(i); continue; }
    files += Oci.applyLayer(root, datas[i]);
  }
  // packages the first-run installer put into the guest's rootfs (web/native/installer.js — the same
  // tars the VM worker applied): grafted here too so image-path reads stay on the host fast path
  if (cfg.packages && cfg.packages.length) {
    importScripts(new URL("/native/installer.js", location.href).href);
    const tp = performance.now(); let pf = 0;
    for (const p of cfg.packages) pf += self.NanoboxInstaller.applyPackage(root, p).files;
    ev("packages", { n: cfg.packages.length, files: pf, ms: Math.round(performance.now() - tp) });
    files += pf;
  }
  ev("rootfs", { files, compressedBytes: bytes, ms: Math.round(performance.now() - t0), skipped });
  return { root, config, manifest };
}

async function main(cfg) {
  ev("worker-start", { backend: cfg.backend || "mem" });
  const vm = cfg.backend === "vm";
  let guest = null, helloP = null;
  if (vm) {
    // backend #2: the guest-side node shim talks to us over the two SAB rings the page created
    importScripts(new URL("/native/proto.js", location.href).href, new URL("/native/hcring.js", location.href).href, new URL("/native/guest.js", location.href).href);
    guest = self.NanoboxGuest.connect({ ringSab: cfg.toGuest, inSab: cfg.fromGuest });
    helloP = new Promise((res) => { guest.onHello = (h) => { ev("hello", { argv: h.argv, cwd: h.cwd, pid: h.pid, cols: h.cols, rows: h.rows, isatty: h.isatty }); res(h); }; });
    guest.onLog = (t) => ev("nbnode-log", { text: t });
  }
  const img = await loadRootfs(cfg);
  let env, cwd, cliPath, argv, B;
  if (vm) {
    ev("waiting-hello");
    const hello = await helloP;
    const image = new MemBackend(img.root, { cwd: hello.cwd });
    B = new GuestBackend({ g: guest, image, inSab: cfg.fromGuest, cwd: hello.cwd });
    const info = B.call("info");
    env = info.env; cwd = info.cwd; argv = hello.argv.slice();
    // the main script as node sees it: realpath of argv[1] (/usr/local/bin/claude -> .../cli.js)
    let script = argv[1] || cfg.cliPath; try { script = B.call("realpath", script); } catch {} 
    cliPath = script; argv[1] = script;
  } else {
    const spec = await (await origFetch(cfg.specUrl)).json();
    // env: first occurrence wins (glibc getenv semantics; the spec repeats TERM)
    env = {}; for (const kv of spec.process.env) { const i = kv.indexOf("="); const k = kv.slice(0, i); if (!(k in env)) env[k] = kv.slice(i + 1); }
    Object.assign(env, cfg.env || {});
    cwd = spec.process.cwd || "/root";
    cliPath = cfg.cliPath; // /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js
    argv = ["/usr/local/bin/node", cliPath, ...(cfg.args || [])];
    // ---- backend #1 ----
    B = new MemBackend(img.root, { env, argv, cwd, ttyWrite: (fd, bytes) => { const copy = bytes.slice(); post({ type: "stdout", fd, data: copy }, [copy.buffer]); } });
    B.tty.cols = cfg.cols || 80; B.tty.rows = cfg.rows || 24;
    try { B.mkdir(cwd, true, 0o755); } catch {}
  }
  self.onmessage = (m) => {
    const d = m.data; if (!d) return;
    if (d.type === "stdin" && !vm) B.ttyInput(new Uint8Array(d.data));
    else if (d.type === "resize" && !vm) B.ttyResize(d.cols, d.rows);
    else if (d.type === "dump") post({ type: "missing", ...dumpMissing(), spawns: child_process._spawnLog, net: netlog, netBytes, backendOps: B.stats.ops, backendStats: vm ? { guest: B.stats.guest, image: B.stats.image, dirty: [...B.dirty], channel: guest.stats } : null, required: Object.fromEntries(required) });
    else if (d.type === "eval") { // debugging aid: window.nanobox.eval("code") runs in the worker scope
      Promise.resolve().then(() => (0, eval)(d.code)).then((v) => post({ type: "eval", id: d.id, value: typeof v === "string" ? v : JSON.stringify(v, null, 1) }), (e) => post({ type: "eval", id: d.id, error: String(e && e.stack || e) }));
    }
  };
  setOnFirst((r) => ev("missing", { key: r.key, kind: r.kind, stack: r.stack }));

  // ---- Node globals ----
  self.global = self;
  self.Buffer = Buffer;
  const fs = makeFs(B);
  const tty = makeTty(B);
  const info = B.call("info");
  const os = makeOs(B, info);
  let exitCode = null;
  const proc = makeProcess(B, tty, { onExit: (c) => { exitCode = c; ev("exit", { code: c }); post({ type: "exit", code: c }); if (vm) { try { guest.exit(c); } catch {} } }, getBuiltinModule: (id) => tryRequire(id) });
  const child_process = makeChildProcess(B, proc);
  const { net, tls, dns } = makeNet(B);
  const { http, https, http2 } = makeHttp(B, net);
  const ctx = { proc, fs, path, util, events, stream, url, zlib, crypto, assert, querystring, string_decoder, bufferModule, os, tty, child_process, net, tls, dns, http, https, http2, require: null };
  const mods = makeMisc(B, ctx);
  const cache = new Map(); const required = new Map(); // id -> count (what the bundle asked for)
  const notFound = (id) => { const e = new Error(`Cannot find module '${id}'\nRequire stack:\n- ${cliPath}`); e.code = "MODULE_NOT_FOUND"; e.requireStack = [cliPath]; return e; };
  function tryRequire(id0) {
    let id = String(id0);
    if (id.startsWith("node:")) id = id.slice(5);
    required.set(id, (required.get(id) || 0) + 1);
    if (cache.has(id)) return cache.get(id);
    const m = mods[id];
    if (m === undefined) return undefined;
    const wrapped = record("require(" + id + ")", m, "undefined");
    cache.set(id, wrapped);
    return wrapped;
  }
  const require = (id0) => {
    const r = tryRequire(id0);
    if (r !== undefined) return r;
    const id = String(id0).replace(/^node:/, "");
    noteMissing("require(" + id + ")", "call");
    throw notFound(id0);
  };
  require.resolve = (id) => { if (tryRequire(id) !== undefined) return String(id).replace(/^node:/, ""); throw notFound(id); };
  require.resolve.paths = () => []; require.cache = {}; require.main = undefined; require.extensions = {};
  ctx.require = require;
  self.require = require; self.process = record("process", proc, "undefined");
  self.module = { exports: {}, id: ".", filename: cliPath, loaded: false, children: [], paths: [], require, parent: null };
  self.exports = self.module.exports; self.__filename = cliPath; self.__dirname = cliPath.replace(/\/[^/]*$/, "");
  Object.assign(self, mods._globals);
  self.fetch = gatewayFetch;
  // no XMLHttpRequest in Node: with it present axios picks its xhr adapter (CORS-bound, cannot set
  // User-Agent) instead of the http adapter that goes through our http shim -> fetch -> gateway
  try { self.XMLHttpRequest = undefined; } catch {}
  try { Object.defineProperty(self, "XMLHttpRequest", { value: undefined, configurable: true }); } catch {}
  // console -> process.stdout/stderr like node (Ink and Claude Code use both), mirrored to DevTools
  const realConsole = self.console;
  const mk = (fd, level) => (...a) => { const s = util.format(...a) + "\n"; try { B.call("ttyWrite", fd, enc.encode(s)); } catch {} realConsole[level]("[cli]", ...a); };
  const consoleShim = Object.assign(Object.create(realConsole), { log: mk(1, "log"), info: mk(1, "info"), debug: mk(1, "debug"), warn: mk(2, "warn"), error: mk(2, "error"), trace: mk(2, "error"), dir: (o, opts) => mk(1, "log")(util.inspect(o, opts)), table: mk(1, "log"), group: mk(1, "log"), groupEnd() {}, assert(c, ...a) { if (!c) mk(2, "error")("Assertion failed:", ...a); }, time() {}, timeEnd() {}, timeLog() {}, count() {}, countReset() {}, Console: function Console() { return consoleShim; } });
  self.console = consoleShim; mods.console = consoleShim;
  // errors escaping to the worker's top level == node's uncaught exception / unhandled rejection
  const uncaught = (e, kind) => {
    if (e && e.isProcessExit) return true;
    if (proc.listenerCount(kind) > 0) { try { proc.emit(kind, e, kind === "unhandledRejection" ? undefined : kind); return true; } catch (e2) { e = e2; } }
    const msg = `${kind === "unhandledRejection" ? "Unhandled rejection" : "Uncaught exception"}: ${e && e.stack || e}\n`.replace(/\n/g, "\r\n");
    try { B.call("ttyWrite", 2, enc.encode(msg)); } catch {}
    ev("uncaught", { kind, message: String(e && e.stack || e).slice(0, 2000) });
    return true;
  };
  self.addEventListener("error", (e) => { if (uncaught(e.error || e.message, "uncaughtException")) e.preventDefault(); });
  self.addEventListener("unhandledrejection", (e) => { if (uncaught(e.reason, "unhandledRejection")) e.preventDefault(); });
  ev("runtime-ready", { env: Object.keys(env).length, files: img.manifest.layers.length, backend: vm ? "vm" : "mem", cwd, argv });

  // ---- load the bundle (importScripts: V8 code cache on repeat loads) ----
  // cfg.cliUrl: a prepared (esbuild-transformed) bundle from our server. Without it, the script the
  // guest asked us to run (argv[1] -> cliPath) is read from the rootfs — the vendor's own cli.js as
  // the installer laid it out — and transformed here (esm2cjs.js), then loaded from a blob: URL.
  const tl = performance.now();
  ev("bundle-load-start");
  try {
    let url = cfg.cliUrl;
    if (!url) {
      const tt = performance.now();
      const bytes = B.call("readFile", cliPath);
      const r = esmToCjs(new TextDecoder().decode(bytes), { fileUrl: "file://" + cliPath });
      url = URL.createObjectURL(new Blob([r.code], { type: "text/javascript" }));
      ev("bundle-transformed", { bytes: bytes.length, imports: r.imports, dynamicImports: r.dynamicImports, ms: Math.round(performance.now() - tt) });
    }
    importScripts(url);
  } catch (e) {
    if (!(e && e.isProcessExit)) { ev("bundle-error", { message: String(e && e.stack || e).slice(0, 4000) }); uncaught(e, "uncaughtException"); }
  }
  ev("bundle-loaded", { ms: Math.round(performance.now() - tl) });
}
