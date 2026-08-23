// nanobox — the Web Worker that runs Claude Code's cli.js on the browser's V8.
// Built by build.mjs into ../runtime.js (classic worker script). Page protocol: see ../../claude-native.html.
//
//   page -> worker: {type:"init", cfg}  {type:"stdin", data}  {type:"resize", cols, rows}  {type:"dump"}
//                    {type:"term-open"|"term-in"|"term-resize"|"term-close", id, ...}  (extra shells in the guest)
//   cfg.shellOnly: serve ONLY the term-* messages (the sandbox page's shell pane next to a non-JS CLI)
//   worker -> page: {type:"event", event, ...}  {type:"stdout", fd, data}  {type:"exit", code}  {type:"missing", ...}
import { Buffer } from "./buffer-first.js";      // patched polyfill; MUST stay the first import (see buffer-first.js)
import { setBufferThrowHook } from "./buffer-fix.js";
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
import { initReport, report, reportError, installGlobalHandlers } from "./report.js";
initReport({}); installGlobalHandlers(); setBufferThrowHook((e, where) => reportError("buffer-throw", e, { fn: where }));
import { esmToCjs } from "./esm2cjs.js";
import { makeBun, BUN_VERSION, BUN_REVISION } from "./bun-globals.js";

const post = (m, transfer) => self.postMessage(m, transfer || []);
const T0 = performance.now();
const ev = (event, extra) => post(Object.assign({ type: "event", event, t: Math.round(performance.now() - T0) }, extra || {}));
const enc = new TextEncoder();
// Bun standalone entries: `// @bun …` banner + the CJS wrapper Bun's own loader calls (bunfs.js)
const BUN_CJS_ENTRY = /^\/\/ @bun[^\n]*\n\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)/;

// the runtime's own helper scripts (shared with the VM pages)
importScripts(new URL("/wasifs.js", location.href).href, new URL("/oci.js", location.href).href, new URL("/cachefetch.js", location.href).href);

self.onmessage = (m) => { if (m.data && m.data.type === "init") { self.onmessage = null; main(m.data.cfg).catch((e) => { ev("fatal", { message: String(e && e.stack || e) }); }); } };

// --- egress: web/proxyext.js decides the route of every cross-origin request — "extension" (the
// nanobox proxy extension, when the page detected it: cfg.proxyExtension), else "relay" for the vendors
// that do not answer CORS (web/netpolicy.js — the same allow-list the server enforces) and "direct"
// for everything else (npm registry, raw.githubusercontent, auth/api.openai, ...); "blocked" for cloud
// metadata hosts. Bytes are counted per host and per route for the data-accounting table.
importScripts(new URL("/netpolicy.js", location.href).href, new URL("/proxyext.js", location.href).href);
const origFetch = self.fetch.bind(self);
const netlog = [];
const netBytes = { origin: 0, direct: 0, relayed: 0, extension: 0, blocked: 0, hosts: {}, routes: {} };   // hosts: host -> { path, bytes, requests }
let proxyExtension = false;
function countBytes(path, host, r) {
  const rec = netBytes.hosts[host] || (netBytes.hosts[host] = { path, bytes: 0, requests: 0 });
  rec.requests++;
  const len = Number(r && r.headers && r.headers.get("content-length")) || 0;
  if (len) { rec.bytes += len; netBytes[path] += len; return r; }
  if (!r || !r.body) return r;
  const counted = r.body.pipeThrough(new TransformStream({ transform(chunk, c) { rec.bytes += chunk.byteLength; netBytes[path] += chunk.byteLength; c.enqueue(chunk); } }));
  return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
}
const ROUTE_PATH = { direct: "direct", relay: "relayed", extension: "extension", blocked: "blocked" };
function gatewayFetch(input, init = {}) {
  const url0 = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let target; try { target = new URL(url0, location.href); } catch { return origFetch(input, init); }
  if (target.origin === location.origin || !/^https?:$/.test(target.protocol)) return origFetch(input, init).then((r) => countBytes("origin", target.host, r));
  let chosen = "direct";
  return self.NanoboxProxy.workerFetch(origFetch, input, init, { extension: proxyExtension, onRoute: ({ route, method, url }) => { chosen = route; netBytes.routes[route] = (netBytes.routes[route] || 0) + 1; netlog.push({ t: Math.round(performance.now() - T0), method, url, via: route }); ev("net", { method, url, via: route }); } })
    .then((r) => countBytes(ROUTE_PATH[chosen] || "direct", target.hostname, r));
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
  // the sandbox's persistent tree (web/native/installer.js): the packages the first-run installer laid
  // out (claude's, here) and the journals of guest writes — the same tars the VM worker applied under
  // bundle/persist — grafted here too, so image-path reads stay on the host fast path and this copy
  // agrees with what the guest sees at /usr/local (an `npm i -g` done in the guest included)
  if (cfg.persistPort) {
    importScripts(new URL("/native/installer.js", location.href).href);
    const tw = performance.now();
    const { packages, journals } = await new Promise((res, rej) => { cfg.persistPort.onmessage = (e) => { const x = e.data || {}; if (x.type === "persist") res({ packages: x.packages || [], journals: x.journals || [] }); else if (x.type === "error") rej(new Error(x.message)); }; });
    const waitMs = Math.round(performance.now() - tw), tp = performance.now(); let pf = 0;
    for (const p of packages) pf += self.NanoboxInstaller.applyPackage(root, p).files;
    for (const t of journals) pf += Oci.applyLayer(root, t);
    ev("persist", { packages: packages.length, journals: journals.length, files: pf, waitMs, ms: Math.round(performance.now() - tp) });
    files += pf;
  }
  ev("rootfs", { files, compressedBytes: bytes, ms: Math.round(performance.now() - t0), skipped });
  return { root, config, manifest };
}

async function main(cfg) {
  ev("worker-start", { backend: cfg.backend || "mem", proxyExtension: !!cfg.proxyExtension });
  proxyExtension = !!cfg.proxyExtension;
  const vm = cfg.backend === "vm";
  let guest = null, helloP = null;
  if (vm) {
    // backend #2: the guest-side node shim talks to us over the two SAB rings the page created
    importScripts(new URL("/native/proto.js", location.href).href, new URL("/native/hcring.js", location.href).href, new URL("/native/guest.js", location.href).href);
    guest = self.NanoboxGuest.connect({ ringSab: cfg.toGuest, inSab: cfg.fromGuest });
    helloP = new Promise((res) => { guest.onHello = (h) => { ev("hello", { argv: h.argv, cwd: h.cwd, pid: h.pid, cols: h.cols, rows: h.rows, isatty: h.isatty }); res(h); }; });
    guest.onLog = (t) => ev("nbnode-log", { text: t });
  }
  // ?shell=1 with a non-JS CLI (codex/agy): this worker is only the SHELL SERVER for the sandbox
  // page's second pane — it spawns /bin/sh on a pty through the shim and relays its bytes. It runs no
  // JavaScript program, so there is no reason to download and unpack the image a second time.
  const img = cfg.shellOnly ? { root: self.NanoboxFs.dir(), config: {}, manifest: { layers: [] } } : await loadRootfs(cfg);
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
  // extra terminals (page id -> guest child id); their pty output arrives as "proc" events of the backend
  const terms = new Map(), termSize = new Map(); const env0 = env;
  if (vm) B.on("proc", (evt) => { for (const [id, cid] of terms) if (evt.pid === cid) { if (evt.stream) { const copy = evt.data.slice(); post({ type: "term-out", id, data: copy }, [copy.buffer]); } else if (evt.exit != null || evt.signal) { post({ type: "term-exit", id, code: evt.exit }); terms.delete(id); termSize.delete(id); } } });
  self.onmessage = (m) => {
    const d = m.data; if (!d) return;
    if (d.type === "stdin" && !vm) B.ttyInput(new Uint8Array(d.data));
    else if (d.type === "resize" && !vm) B.ttyResize(d.cols, d.rows);
    else if (d.type === "dump") post({ type: "missing", ...dumpMissing(), spawns: child_process._spawnLog, net: netlog, netBytes, backendOps: B.stats.ops, backendStats: vm ? { guest: B.stats.guest, image: B.stats.image, dirty: [...B.dirty], channel: guest.stats } : null, required: Object.fromEntries(required) });
    else if (d.type === "term-open" && vm) { // extra terminal: a login shell in the guest on a pty, I/O relayed to the page
      const cid = B.cid++; terms.set(d.id, cid);
      const cols = d.cols || 80, rows = d.rows || 24;
      const env = Object.entries(env0).map(([k, v]) => k + "=" + v).concat([`COLUMNS=${cols}`, `LINES=${rows}`, "TERM=xterm-256color"]);
      // The shim inherits the CONTAINER CONSOLE's geometry, which is the CLI pane — a shell pane of a
      // different width would then render every TUI wrapped at the wrong column. CHILD_RESIZE gives
      // this pty the size of ITS pane and pins it against the shim's own SIGWINCH propagation.
      termSize.set(d.id, [cols, rows]);
      const size = () => { const wh = termSize.get(d.id) || [cols, rows]; B.g.childResize(cid, wh[0], wh[1]).then(() => ev("term-resized", { id: d.id, cid, cols: wh[0], rows: wh[1], initial: true }), (e) => ev("term-resize-failed", { id: d.id, cid, initial: true, message: String(e && e.message || e) })); };
      // `-i` is explicit: BusyBox ash invoked as only `sh -l` can keep the default SIGINT action,
      // so ^C kills the shell together with its foreground command and leaves a dead-looking pane.
      try { B.g.spawn(cid, ["/bin/sh", "-il"], env, cwd, 2).then(() => { size(); post({ type: "term-opened", id: d.id, cols, rows }); }, (e) => post({ type: "term-out", id: d.id, data: enc.encode(`\r\n[shell failed: ${e.message}]\r\n`) })); }
      catch (e) { post({ type: "term-out", id: d.id, data: enc.encode(`\r\n[shell failed: ${e.message}]\r\n`) }); }
    }
    else if (d.type === "term-in" && vm) { const cid = terms.get(d.id); if (cid) B.g.childStdin(cid, new Uint8Array(d.data)); }
    else if (d.type === "term-resize" && vm) { const cid = terms.get(d.id); termSize.set(d.id, [d.cols | 0, d.rows | 0]);
      if (cid) B.g.childResize(cid, d.cols | 0, d.rows | 0).then(() => ev("term-resized", { id: d.id, cid, cols: d.cols, rows: d.rows }), (e) => ev("term-resize-failed", { id: d.id, cid, message: String(e && e.message || e) }));
      else ev("term-resize-nocid", { id: d.id }); }
    else if (d.type === "term-close" && vm) { const cid = terms.get(d.id); termSize.delete(d.id); if (cid) { B.g.kill(cid, 9); terms.delete(d.id); } }
    else if (d.type === "eval") { // debugging aid: window.nanobox.eval("code") runs in the worker scope
      Promise.resolve().then(() => (0, eval)(d.code)).then((v) => post({ type: "eval", id: d.id, value: typeof v === "string" ? v : JSON.stringify(v, null, 1) }), (e) => post({ type: "eval", id: d.id, error: String(e && e.stack || e) }));
    }
  };
  if (cfg.shellOnly) { ev("shell-ready", { cwd }); return; }   // no JS program: the terms handlers above are the whole job
  setOnFirst((r) => { ev("missing", { key: r.key, kind: r.kind, stack: r.stack }); report("missing-api", { key: r.key, kind: r.kind, stack: r.stack }); });

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
      const text = new TextDecoder().decode(bytes);
      const bunCjs = BUN_CJS_ENTRY.exec(text);
      if (bunCjs) {
        // a Bun program (Claude Code's native build, its JS extracted by web/native/bunfs.js at
        // install time): give it the `Bun` global it calls unconditionally. Only then — the npm
        // build branches on `typeof Bun` and its Node path is the one we support.
        self.Bun = makeBun({ B, fs, path, os, child_process, proc, require });
        proc.versions.bun = BUN_VERSION; proc.revision = BUN_REVISION; proc.isBun = true;
        // a standalone Bun program IS its executable, and the CLI relaunches itself through
        // process.execPath — point it at the launcher the installer wrote, not at our shim
        if (cliPath.includes("/claude-native/")) proc.execPath = "/usr/local/bin/claude";
        // Bun's standalone build stores the entry already wrapped as
        // `(function(exports, require, module, __filename, __dirname){…})` — call it with our module
        // context instead of running the ESM->CJS transform (nothing to rewrite, 26 MB not touched)
        const call = `\n(module.exports, require, module, ${JSON.stringify(cliPath)}, ${JSON.stringify(self.__dirname)});\n`;
        url = URL.createObjectURL(new Blob([text, call], { type: "text/javascript" }));
        ev("bundle-bun-cjs", { bytes: bytes.length, ms: Math.round(performance.now() - tt) });
      } else {
        const r = esmToCjs(text, { fileUrl: "file://" + cliPath });
        url = URL.createObjectURL(new Blob([r.code], { type: "text/javascript" }));
        ev("bundle-transformed", { bytes: bytes.length, imports: r.imports, dynamicImports: r.dynamicImports, ms: Math.round(performance.now() - tt) });
      }
    }
    importScripts(url);
  } catch (e) {
    if (!(e && e.isProcessExit)) { ev("bundle-error", { message: String(e && e.stack || e).slice(0, 4000) }); uncaught(e, "uncaughtException"); }
  }
  ev("bundle-loaded", { ms: Math.round(performance.now() - tl) });
}
