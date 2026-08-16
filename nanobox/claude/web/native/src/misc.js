// The long tail of Node builtins: small own implementations + additions on top of the npm polyfills
// (util, events, stream, url, zlib, crypto, buffer, assert, path, string_decoder, querystring).
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import * as RS from "readable-stream";
import { Readable, Writable, Duplex, Transform, PassThrough } from "readable-stream";
import { noteMissing, stubFn, record } from "./record.js";
import { errnoError } from "./errors.js";

// define `key` on a polyfill module object only if it lacks it (the packages define some props as
// getters/read-only — assignment would throw)
const add = (obj, key, value) => { if (!(key in obj)) Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true }); };
export function makeMisc(B, ctx) {
  const { proc, fs, path, util, events, stream, url, zlib, crypto, assert, querystring, string_decoder } = ctx;
  const mods = {};

  // ---- events: Node additions the `events` package lacks ----
  add(events, "once", ((em, name, opts) => new Promise((res, rej) => { const on = (...a) => { em.removeListener("error", er); res(a); }; const er = (e) => { em.removeListener(name, on); rej(e); }; em.once(name, on); if (name !== "error") em.once("error", er); })));
  add(events, "on", ((em, name) => { const q = []; let wake = null; em.on(name, (...a) => { q.push(a); if (wake) { wake(); wake = null; } }); return { [Symbol.asyncIterator]() { return this; }, async next() { while (!q.length) await new Promise((r) => (wake = r)); return { value: q.shift(), done: false }; }, return: async () => ({ done: true }) }; }));
  add(events, "getEventListeners", ((em, n) => (em.listeners ? em.listeners(n) : [])));
  add(events, "getMaxListeners", ((em) => (em.getMaxListeners ? em.getMaxListeners() : 10)));
  add(events, "setMaxListeners", ((n, ...ems) => { for (const e of ems) if (e.setMaxListeners) e.setMaxListeners(n); if (!ems.length) EventEmitter.defaultMaxListeners = n; }));
  add(events, "errorMonitor", Symbol("events.errorMonitor"));
  add(events, "captureRejectionSymbol", Symbol.for("nodejs.rejection"));
  events.captureRejections = false;
  add(events, "EventEmitterAsyncResource", class extends EventEmitter { constructor(o) { super(); this.asyncResource = { asyncId: () => 1, triggerAsyncId: () => 0, runInAsyncScope: (fn, t, ...a) => fn.apply(t, a), emitDestroy() {} }; } });
  add(events, "addAbortListener", ((signal, fn) => { signal.addEventListener("abort", fn, { once: true }); return { [Symbol.dispose]: () => signal.removeEventListener("abort", fn) }; }));
  events.EventTarget = globalThis.EventTarget; events.Event = globalThis.Event;
  events.default = events;

  // ---- util additions ----
  add(util, "stripVTControlCharacters", ((s) => String(s).replace(/[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")));
  add(util, "getSystemErrorName", ((n) => ({ [-2]: "ENOENT", [-13]: "EACCES", [-17]: "EEXIST", [-22]: "EINVAL", [-111]: "ECONNREFUSED", [-32]: "EPIPE", [-4]: "EINTR", [-9]: "EBADF", [-20]: "ENOTDIR", [-21]: "EISDIR", [-39]: "ENOTEMPTY", [-104]: "ECONNRESET", [-110]: "ETIMEDOUT" }[n] || "Unknown system error " + n)));
  add(util, "getSystemErrorMap", (() => new Map()));
  add(util, "getSystemErrorMessage", ((n) => util.getSystemErrorName(n)));
  add(util, "aborted", ((signal) => new Promise((res) => { if (signal.aborted) res(); else signal.addEventListener("abort", () => res(), { once: true }); })));
  add(util, "parseArgs", parseArgs);
  add(util, "styleText", ((fmt, text) => { const codes = { reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29], black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39], gray: [90, 39], grey: [90, 39], bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49], bgBlue: [44, 49], bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49] }; let s = String(text); for (const f of [].concat(fmt)) { const c = codes[f]; if (c) s = `\x1b[${c[0]}m${s}\x1b[${c[1]}m`; } return s; }));
  add(util, "MIMEType", class MIMEType { constructor(s) { const [t, ...p] = String(s).split(";"); const [type, subtype] = t.trim().split("/"); this.type = type; this.subtype = subtype; this.essence = t.trim(); this.params = new Map(p.map((x) => x.trim().split("=")).filter((x) => x[0]).map(([k, v]) => [k, (v || "").replace(/^"|"$/g, "")])); } toString() { return this.essence; } });
  add(util, "getCallSites", (() => []));
  add(util, "transferableAbortSignal", ((s) => s)); add(util, "transferableAbortController", (() => new AbortController()));
  add(util, "toUSVString", ((s) => String(s).toWellFormed()));
  add(util, "diff", (() => []));
  add(util, "setTraceSigInt", (() => {}));
  add(util, "isDeepStrictEqual", ((a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } }));
  util.types = Object.assign({}, util.types || {}); // a mutable copy: the package defines isProxy & co. read-only (throwing)
  add(util.types, "isNativeError", ((e) => e instanceof Error));
  add(util.types, "isPromise", ((p) => p instanceof Promise));
  add(util.types, "isProxy", (() => false));
  add(util.types, "isKeyObject", (() => false)); add(util.types, "isCryptoKey", ((k) => typeof CryptoKey !== "undefined" && k instanceof CryptoKey));
  add(util.types, "isExternal", (() => false)); add(util.types, "isModuleNamespaceObject", (() => false));
  add(util.types, "isBoxedPrimitive", ((v) => v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof Symbol || v instanceof BigInt));
  add(util.types, "isAsyncFunction", ((f) => typeof f === "function" && f.constructor && f.constructor.name === "AsyncFunction"));
  add(util.types, "isGeneratorFunction", ((f) => typeof f === "function" && /Generator/.test(f.constructor && f.constructor.name)));
  util.TextEncoder = TextEncoder; util.TextDecoder = TextDecoder;
  add(util.inspect, "defaultOptions", { depth: 2, colors: false, showHidden: false, maxArrayLength: 100, maxStringLength: 10000, breakLength: 80, compact: 3, sorted: false, getters: false, numericSeparator: false });
  util.default = util;

  // ---- stream: package + web/promises/consumers ----
  add(stream, "Stream", stream);
  add(stream, "promises", { pipeline: (...a) => new Promise((res, rej) => stream.pipeline(...a, (e) => (e ? rej(e) : res()))), finished: (s, o) => new Promise((res, rej) => stream.finished(s, o, (e) => (e ? rej(e) : res()))) });
  add(stream, "isReadable", ((s) => !!s && typeof s.read === "function" && s.readable !== false));
  add(stream, "isWritable", ((s) => !!s && typeof s.write === "function" && s.writable !== false));
  add(stream, "isErrored", ((s) => !!(s && s.errored)));
  add(stream, "isDisturbed", ((s) => !!(s && s.readableDidRead)));
  add(stream, "getDefaultHighWaterMark", ((o) => (o ? 16 : 65536))); add(stream, "setDefaultHighWaterMark", (() => {}));
  add(stream, "addAbortSignal", ((sig, s) => { sig.addEventListener("abort", () => s.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }))); return s; }));
  add(stream, "compose", ((...s) => { const first = s[0], last = s[s.length - 1]; for (let i = 0; i < s.length - 1; i++) s[i].pipe(s[i + 1]); return Duplex.from ? Duplex.from({ writable: first, readable: last }) : last; }));
  add(stream, "duplexPair", (() => { const a = new PassThrough(), b = new PassThrough(); return [Duplex.from({ writable: a, readable: b }), Duplex.from({ writable: b, readable: a })]; }));
  if (!Readable.fromWeb) Readable.fromWeb = (rs, o) => { const r = new Readable(Object.assign({ read() {} }, o)); const reader = rs.getReader(); (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) { r.push(null); break; } r.push(o && o.objectMode ? value : Buffer.from(value)); } } catch (e) { r.destroy(e); } })(); return r; };
  if (!Readable.toWeb) Readable.toWeb = (r) => new ReadableStream({ start(c) { r.on("data", (d) => c.enqueue(typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d))); r.on("end", () => c.close()); r.on("error", (e) => c.error(e)); }, cancel() { r.destroy(); } });
  if (!Writable.fromWeb) Writable.fromWeb = (ws, o) => { const w = ws.getWriter(); return new Writable(Object.assign({ write(c, e, cb) { w.write(typeof c === "string" ? new TextEncoder().encode(c) : c).then(() => cb(), cb); }, final(cb) { w.close().then(() => cb(), cb); } }, o)); };
  if (!Writable.toWeb) Writable.toWeb = (w) => new WritableStream({ write(c) { return new Promise((res, rej) => w.write(Buffer.from(c), (e) => (e ? rej(e) : res()))); }, close() { return new Promise((res) => w.end(res)); } });
  if (!Duplex.fromWeb) Duplex.fromWeb = (pair, o) => Duplex.from({ readable: Readable.fromWeb(pair.readable, o), writable: Writable.fromWeb(pair.writable, o) });
  if (!Duplex.toWeb) Duplex.toWeb = (d) => ({ readable: Readable.toWeb(d), writable: Writable.toWeb(d) });
  stream.default = stream;
  const streamWeb = { ReadableStream, WritableStream, TransformStream, ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader, ReadableStreamBYOBReader: globalThis.ReadableStreamBYOBReader, ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController, WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter, TransformStreamDefaultController: globalThis.TransformStreamDefaultController, ByteLengthQueuingStrategy, CountQueuingStrategy, TextEncoderStream: globalThis.TextEncoderStream, TextDecoderStream: globalThis.TextDecoderStream, CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream };
  const consume = async (s) => { const parts = []; if (s && typeof s.getReader === "function") { const rd = s.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(Buffer.from(value)); } } else for await (const c of s) parts.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c)); return Buffer.concat(parts); };
  const consumers = { buffer: consume, text: async (s) => (await consume(s)).toString("utf8"), json: async (s) => JSON.parse((await consume(s)).toString("utf8")), arrayBuffer: async (s) => { const b = await consume(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, blob: async (s) => new Blob([await consume(s)]) };

  // ---- url: WHATWG + node helpers on top of the `url` package ----
  url.URL = URL; url.URLSearchParams = URLSearchParams;
  url.fileURLToPath = (u) => { const x = typeof u === "string" ? new URL(u) : u; if (x.protocol !== "file:") { const e = new TypeError("The URL must be of scheme file"); e.code = "ERR_INVALID_URL_SCHEME"; throw e; } return decodeURIComponent(x.pathname); };
  url.pathToFileURL = (p) => { let s = String(p); if (!s.startsWith("/")) s = path.resolve(s); const u = new URL("file://"); u.pathname = s.split("/").map((c) => encodeURIComponent(c).replace(/%2F/g, "/")).join("/"); return u; };
  url.domainToASCII = (d) => { try { return new URL("http://" + d).hostname; } catch { return ""; } }; url.domainToUnicode = (d) => d;
  url.urlToHttpOptions = (u) => ({ protocol: u.protocol, hostname: u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: `${u.pathname || ""}${u.search || ""}`, href: u.href, port: u.port !== "" ? Number(u.port) : undefined, auth: u.username || u.password ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : undefined });
  url.default = url;

  // ---- zlib additions (browserify-zlib: deflate/inflate/gzip/gunzip/unzip streams + sync) ----
  const notBrotli = (n) => (...a) => { noteMissing("zlib." + n, "call"); const cb = a.find((x) => typeof x === "function"); const e = new Error("brotli is not available in the browser runtime"); if (cb) queueMicrotask(() => cb(e)); else if (!/Sync$/.test(n)) throw e; else throw e; };
  for (const n of ["brotliCompress", "brotliDecompress", "brotliCompressSync", "brotliDecompressSync", "createBrotliCompress", "createBrotliDecompress", "zstdCompress", "zstdDecompress", "zstdCompressSync", "zstdDecompressSync", "createZstdCompress", "createZstdDecompress"]) if (!zlib[n]) zlib[n] = notBrotli(n);
  add(zlib, "crc32", ((data, value = 0) => { let c = ~value >>> 0; const b = typeof data === "string" ? Buffer.from(data) : data; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }));
  zlib.constants = Object.assign(zlib.constants || {}, { BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_SIZE_HINT: 3, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_DEFAULT_QUALITY: 11, Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_OK: 0, Z_STREAM_END: 1, Z_DEFAULT_COMPRESSION: -1, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_STRATEGY: 0 });
  zlib.default = zlib;
  // ---- crypto additions (crypto-browserify + WebCrypto) ----
  crypto.webcrypto = globalThis.crypto; crypto.subtle = globalThis.crypto.subtle;
  crypto.randomUUID = () => globalThis.crypto.randomUUID();
  crypto.getRandomValues = (a) => globalThis.crypto.getRandomValues(a);
  crypto.randomInt = (a, b, cb) => { if (typeof b === "function") { cb = b; b = a; a = 0; } else if (b == null) { b = a; a = 0; } const v = a + Math.floor(Math.random() * (b - a)); if (cb) queueMicrotask(() => cb(null, v)); return v; };
  add(crypto, "timingSafeEqual", ((a, b) => { if (a.byteLength !== b.byteLength) { const e = new RangeError("Input buffers must have the same byte length"); e.code = "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH"; throw e; } let r = 0; for (let i = 0; i < a.byteLength; i++) r |= a[i] ^ b[i]; return r === 0; }));
  add(crypto, "hash", ((alg, data, enc = "hex") => crypto.createHash(alg).update(data).digest(enc)));
  add(crypto, "getHashes", (() => ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "ripemd160"]));
  add(crypto, "getCiphers", (() => ["aes-128-cbc", "aes-256-cbc", "aes-256-gcm", "aes-128-gcm", "aes-256-ctr"]));
  add(crypto, "getCurves", (() => ["prime256v1", "secp256k1", "secp384r1"]));
  add(crypto, "constants", { RSA_PKCS1_PADDING: 1, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2, RSA_PSS_SALTLEN_AUTO: -2, POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_COMPRESSED: 2, defaultCoreCipherList: "", defaultCipherList: "" });
  add(crypto, "KeyObject", class KeyObject { constructor(t) { this.type = t; } export() { return Buffer.alloc(0); } });
  add(crypto, "createSecretKey", ((k) => Object.assign(new crypto.KeyObject("secret"), { symmetricKeySize: k.length, export: () => Buffer.from(k) })));
  add(crypto, "createPublicKey", ((k) => new crypto.KeyObject("public"))); add(crypto, "createPrivateKey", ((k) => new crypto.KeyObject("private")));
  add(crypto, "generateKeyPairSync", ((t) => { noteMissing("crypto.generateKeyPairSync", "call"); throw new Error("generateKeyPairSync unavailable"); }));
  add(crypto, "generateKeyPair", ((t, o, cb) => { noteMissing("crypto.generateKeyPair", "call"); cb(new Error("generateKeyPair unavailable")); }));
  add(crypto, "generateKeySync", ((t, o) => crypto.createSecretKey(crypto.randomBytes(o.length / 8))));
  add(crypto, "hkdfSync", ((digest, ikm, salt, info, keylen) => { const prk = crypto.createHmac(digest, salt.length ? salt : Buffer.alloc(32)).update(ikm).digest(); const out = []; let prev = Buffer.alloc(0); for (let i = 1; Buffer.concat(out).length < keylen; i++) { prev = crypto.createHmac(digest, prk).update(Buffer.concat([prev, Buffer.from(info), Buffer.from([i])])).digest(); out.push(prev); } const b = Buffer.concat(out).subarray(0, keylen); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }));
  add(crypto, "scryptSync", ((pw, salt, keylen) => { noteMissing("crypto.scryptSync", "call"); return crypto.pbkdf2Sync(pw, salt, 16384, keylen, "sha256"); }));
  add(crypto, "scrypt", ((pw, salt, keylen, o, cb) => { if (typeof o === "function") cb = o; queueMicrotask(() => cb(null, crypto.scryptSync(pw, salt, keylen))); }));
  crypto.secureHeapUsed = () => ({ total: 0, min: 0, used: 0, utilization: 0 }); crypto.setEngine = () => {}; crypto.getFips = () => 0; crypto.setFips = () => {}; crypto.checkPrime = (c, o, cb) => (cb || o)(null, false); crypto.checkPrimeSync = () => false;
  add(crypto, "X509Certificate", class X509Certificate { constructor(b) { this.raw = Buffer.from(b); this.subject = ""; this.issuer = ""; this.validFrom = ""; this.validTo = ""; this.fingerprint256 = ""; } checkHost() { return undefined; } toString() { return this.raw.toString(); } });
  add(crypto, "Certificate", class {}); add(crypto, "diffieHellman", (() => Buffer.alloc(0)));
  crypto.default = crypto;
  // ---- buffer additions ----
  const bufmod = ctx.bufferModule;
  bufmod.Blob = globalThis.Blob; bufmod.File = globalThis.File; bufmod.atob = globalThis.atob.bind(globalThis); bufmod.btoa = globalThis.btoa.bind(globalThis);
  add(bufmod, "constants", { MAX_LENGTH: 2 ** 32 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 }); add(bufmod, "kMaxLength", 2 ** 32 - 1); bufmod.kStringMaxLength = 2 ** 29 - 24;
  add(bufmod, "isUtf8", ((b) => { try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } }));
  add(bufmod, "isAscii", ((b) => { for (const x of b) if (x > 127) return false; return true; }));
  add(bufmod, "transcode", ((b, from, to) => Buffer.from(Buffer.from(b).toString(from), to)));
  bufmod.resolveObjectURL = () => undefined;
  bufmod.default = bufmod;
  // ---- path: posix everywhere ----
  add(path, "posix", path); add(path, "win32", Object.assign({}, path, { sep: "\\", delimiter: ";" })); add(path, "matchesGlob", (() => false)); add(path, "toNamespacedPath", ((p) => p)); path.default = path;
  // ---- assert / string_decoder / querystring pass through ----
  add(assert, "strict", assert); assert.default = assert; string_decoder.default = string_decoder; querystring.default = querystring; add(querystring, "escape", encodeURIComponent); add(querystring, "unescape", decodeURIComponent);

  // ---- vm ----
  class Script { constructor(code, o) { this.code = String(code); this.o = o; } runInThisContext(o) { return (0, eval)(this.code); } runInNewContext(sb) { return runInNewContext(this.code, sb); } runInContext(c) { return runInNewContext(this.code, c); } createCachedData() { return Buffer.alloc(0); } }
  const runInNewContext = (code, sb, o) => { const keys = Object.keys(sb || {}); return new Function(...keys, `return eval(${JSON.stringify(String(code))})`)(...keys.map((k) => sb[k])); };
  mods.vm = { Script, createScript: (c, o) => new Script(c, o), runInThisContext: (c) => (0, eval)(String(c)), runInNewContext, runInContext: runInNewContext, createContext: (o = {}) => o, isContext: () => true, compileFunction: (code, params = [], o) => new Function(...params, String(code)), measureMemory: async () => ({}), constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("USE_MAIN_CONTEXT_DEFAULT_LOADER"), DONT_CONTEXTIFY: Symbol("DONT_CONTEXTIFY") }, SourceTextModule: class { constructor() { noteMissing("vm.SourceTextModule", "call"); } }, SyntheticModule: class {} };
  // ---- v8 ----
  mods.v8 = { getHeapStatistics: () => ({ total_heap_size: 150e6, total_heap_size_executable: 5e6, total_physical_size: 150e6, total_available_size: 4e9, used_heap_size: 100e6, heap_size_limit: 4.3e9, malloced_memory: 1e6, peak_malloced_memory: 2e6, does_zap_garbage: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0, total_global_handles_size: 8192, used_global_handles_size: 4096, external_memory: 1e6 }), getHeapSpaceStatistics: () => [], getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }), setFlagsFromString() {}, writeHeapSnapshot: () => "", getHeapSnapshot: () => new Readable({ read() { this.push(null); } }), serialize: (v) => Buffer.from(JSON.stringify(v)), deserialize: (b) => JSON.parse(Buffer.from(b).toString()), cachedDataVersionTag: () => 1, setHeapSnapshotNearHeapLimit() {}, startupSnapshot: { isBuildingSnapshot: () => false, addSerializeCallback() {}, addDeserializeCallback() {}, setDeserializeMainFunction() {} }, promiseHooks: { onInit: () => () => {}, onSettled: () => () => {}, onBefore: () => () => {}, onAfter: () => () => {}, createHook: () => () => {} }, GCProfiler: class { start() {} stop() { return {}; } }, takeCoverage() {}, stopCoverage() {}, queryObjects: () => 0, isStringOneByteRepresentation: () => true, Serializer: class {}, Deserializer: class {}, DefaultSerializer: class {}, DefaultDeserializer: class {} };
  // ---- worker_threads (single-threaded here: no Worker; the page owns the real one) ----
  mods.worker_threads = { isMainThread: true, isInternalThread: false, parentPort: null, workerData: null, threadId: 0, resourceLimits: {}, SHARE_ENV: Symbol("nodejs.worker_threads.SHARE_ENV"), Worker: class Worker extends EventEmitter { constructor(f) { super(); noteMissing("worker_threads.Worker(" + f + ")", "call"); this.threadId = -1; queueMicrotask(() => this.emit("error", new Error("worker_threads.Worker is not available in the browser runtime"))); } postMessage() {} terminate() { return Promise.resolve(0); } ref() {} unref() {} }, MessageChannel: globalThis.MessageChannel, MessagePort: globalThis.MessagePort, BroadcastChannel: globalThis.BroadcastChannel, markAsUntransferable() {}, isMarkedAsUntransferable: () => false, markAsUncloneable() {}, moveMessagePortToContext: (p) => p, receiveMessageOnPort: () => undefined, setEnvironmentData() {}, getEnvironmentData: () => undefined, postMessageToThread: async () => {}, isMarkedAsUntransferable_: false };
  // ---- perf_hooks ----
  const perf = globalThis.performance;
  if (!perf.eventLoopUtilization) perf.eventLoopUtilization = () => ({ idle: 0, active: 0, utilization: 0 });
  add(perf, "nodeTiming", { name: "node", entryType: "node", startTime: 0, duration: 0, nodeStart: 0, v8Start: 0, environment: 0, bootstrapComplete: 0, loopStart: 0, loopExit: -1, idleTime: 0 });
  add(perf, "timerify", ((f) => f));
  mods.perf_hooks = { performance: perf, PerformanceObserver: globalThis.PerformanceObserver || class { observe() {} disconnect() {} }, PerformanceEntry: globalThis.PerformanceEntry, PerformanceMark: globalThis.PerformanceMark, PerformanceMeasure: globalThis.PerformanceMeasure, monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {}, min: 0, max: 0, mean: 0, stddev: 0, percentiles: new Map(), percentile: () => 0, exceeds: 0 }), createHistogram: () => ({ record() {}, reset() {}, min: 0, max: 0, mean: 0, stddev: 0, count: 0, percentiles: new Map(), percentile: () => 0, exceeds: 0 }), constants: { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16, NODE_PERFORMANCE_GC_FLAGS_NO: 0 } };
  // ---- timers ----
  const wrapTimer = (t) => { if (t && typeof t === "object") return t; const h = { _id: t, ref() { return this; }, unref() { return this; }, hasRef() { return true; }, refresh() { return this; }, close() { clearTimeout(t); clearInterval(t); }, [Symbol.toPrimitive]() { return t; }, [Symbol.dispose]() { this.close(); } }; return h; };
  // the browser's own timer functions, captured before the Node-shaped ones replace them on the global
  const g = { setTimeout: globalThis.setTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
  const setTimeoutN = (fn, ms, ...a) => wrapTimer(g.setTimeout(fn, ms, ...a)), setIntervalN = (fn, ms, ...a) => wrapTimer(g.setInterval(fn, ms, ...a));
  const clearN = (f) => (t) => f(t && typeof t === "object" ? t._id : t);
  const clearTimeoutN = clearN(g.clearTimeout), clearIntervalN = clearN(g.clearInterval);
  // setImmediate: a macrotask via MessageChannel (setTimeout(0) is clamped to >=1 ms / 4 ms nested)
  const immQ = []; const immCh = new MessageChannel(); let immScheduled = false;
  immCh.port1.onmessage = () => { immScheduled = false; const q = immQ.splice(0); for (const i of q) if (!i.cleared) { try { i.fn(...i.args); } catch (e) { setTimeout(() => { throw e; }); } } };
  const setImmediateN = (fn, ...args) => { const i = { fn, args, cleared: false, ref() { return this; }, unref() { return this; }, hasRef() { return true; }, [Symbol.dispose]() { i.cleared = true; } }; immQ.push(i); if (!immScheduled) { immScheduled = true; immCh.port2.postMessage(0); } return i; };
  const clearImmediateN = (i) => { if (i) i.cleared = true; };
  const timersPromises = { setTimeout: (ms, v, o) => new Promise((res, rej) => { const t = g.setTimeout(() => res(v), ms); if (o && o.signal) o.signal.addEventListener("abort", () => { g.clearTimeout(t); rej(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })); }, { once: true }); }), setImmediate: (v) => new Promise((res) => setImmediateN(() => res(v))), setInterval: async function* (ms, v) { for (;;) { await new Promise((r) => g.setTimeout(r, ms)); yield v; } }, scheduler: { wait: (ms, o) => timersPromises.setTimeout(ms, undefined, o), yield: () => timersPromises.setImmediate() } };
  mods.timers = { setTimeout: setTimeoutN, clearTimeout: clearTimeoutN, setInterval: setIntervalN, clearInterval: clearIntervalN, setImmediate: setImmediateN, clearImmediate: clearImmediateN, promises: timersPromises, active() {}, unenroll() {}, enroll() {} };
  mods["timers/promises"] = timersPromises;
  mods._globals = { setTimeout: setTimeoutN, clearTimeout: clearTimeoutN, setInterval: setIntervalN, clearInterval: clearIntervalN, setImmediate: setImmediateN, clearImmediate: clearImmediateN };
  // ---- async_hooks ----
  class AsyncLocalStorage { constructor() { this._store = undefined; this._enabled = false; } run(store, fn, ...a) { const prev = this._store; this._store = store; this._enabled = true; try { return fn(...a); } finally { this._store = prev; } } exit(fn, ...a) { const prev = this._store; this._store = undefined; try { return fn(...a); } finally { this._store = prev; } } getStore() { return this._store; } enterWith(s) { this._store = s; this._enabled = true; } disable() { this._store = undefined; this._enabled = false; } static bind(fn) { return fn; } static snapshot() { return (fn, ...a) => fn(...a); } }
  class AsyncResource { constructor(type, o) { this.type = type; this._asyncId = ++asyncIdCounter; this._trigger = typeof o === "number" ? o : (o && o.triggerAsyncId) || 0; } runInAsyncScope(fn, t, ...a) { return fn.apply(t, a); } emitDestroy() { return this; } asyncId() { return this._asyncId; } triggerAsyncId() { return this._trigger; } bind(fn) { return fn.bind(this); } static bind(fn) { return fn; } }
  let asyncIdCounter = 1;
  mods.async_hooks = { AsyncLocalStorage, AsyncResource, createHook: () => ({ enable() { return this; }, disable() { return this; } }), executionAsyncId: () => 1, triggerAsyncId: () => 0, executionAsyncResource: () => ({}), asyncWrapProviders: {} };
  // ---- inspector ----
  mods.inspector = { url: () => undefined, open() {}, close() {}, waitForDebugger() {}, console: globalThis.console, Session: class extends EventEmitter { connect() {} connectToMainThread() {} disconnect() {} post(m, p, cb) { if (typeof p === "function") cb = p; if (cb) cb(new Error("inspector unavailable")); } }, Network: { requestWillBeSent() {}, responseReceived() {}, loadingFinished() {}, loadingFailed() {} } };
  // ---- module ----
  const builtinModules = ["assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib", "fs/promises", "path/posix", "path/win32", "stream/promises", "stream/web", "stream/consumers", "timers/promises", "util/types", "dns/promises", "readline/promises", "assert/strict"];
  const Module = function Module(id, parent) { this.id = id; this.exports = {}; this.parent = parent; this.filename = id; this.loaded = false; this.children = []; this.paths = []; };
  Module.builtinModules = builtinModules; Module.isBuiltin = (id) => builtinModules.includes(String(id).replace(/^node:/, "")); Module.createRequire = () => ctx.require; Module._load = (id) => ctx.require(id); Module._resolveFilename = (id) => id; Module._cache = {}; Module._extensions = { ".js": () => {}, ".json": () => {}, ".node": () => {} }; Module.wrap = (s) => `(function (exports, require, module, __filename, __dirname) { ${s}\n});`; Module.register = () => {}; Module.syncBuiltinESMExports = () => {}; Module.findSourceMap = () => undefined; Module.SourceMap = class {}; Module.enableCompileCache = () => ({ status: 0 }); Module.getCompileCacheDir = () => undefined; Module.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } }; Module.findPackageJSON = () => undefined; Module.stripTypeScriptTypes = (s) => s; Module.flushCompileCache = () => {}; Module.globalPaths = ["/usr/local/lib/node_modules"]; Module.Module = Module; Module.prototype.require = function (id) { return ctx.require(id); }; Module.prototype._compile = function () {}; Module.runMain = () => {}; Module._nodeModulePaths = () => []; Module.default = Module;
  mods.module = Module;
  // ---- readline (minimal: createInterface for line reading + question, emitKeypressEvents) ----
  class Interface extends EventEmitter {
    constructor(input, output, completer, terminal) {
      super();
      const o = input && typeof input === "object" && !input.on ? input : (input && input.input === undefined && input.on ? { input, output, completer, terminal } : input) || {};
      this.input = o.input || input; this.output = o.output; this.terminal = o.terminal != null ? !!o.terminal : !!(this.output && this.output.isTTY); this.line = ""; this.cursor = 0; this._prompt = o.prompt != null ? o.prompt : "> "; this.closed = false; this.history = [];
      this._buf = ""; this._paused = false;
      this._onData = (d) => { this._buf += typeof d === "string" ? d : d.toString("utf8"); let i; while ((i = this._buf.search(/\r\n|\n|\r/)) >= 0) { const line = this._buf.slice(0, i); this._buf = this._buf.slice(i + (this._buf[i] === "\r" && this._buf[i + 1] === "\n" ? 2 : 1)); this._emitLine(line); } };
      this._onEnd = () => { if (this._buf) { const l = this._buf; this._buf = ""; this._emitLine(l); } this.close(); };
      if (this.input) { this.input.on("data", this._onData); this.input.on("end", this._onEnd); if (this.input.resume) this.input.resume(); }
    }
    _emitLine(line) { if (this._q) { const cb = this._q; this._q = null; cb(line); } else this.emit("line", line); }
    setPrompt(p) { this._prompt = p; } getPrompt() { return this._prompt; } prompt() { if (this.output) this.output.write(this._prompt); }
    question(q, o, cb) { if (typeof o === "function") cb = o; if (this.output) this.output.write(q); this._q = cb; }
    pause() { this._paused = true; this.emit("pause"); return this; } resume() { this._paused = false; this.emit("resume"); return this; }
    close() { if (this.closed) return; this.closed = true; if (this.input) { this.input.removeListener("data", this._onData); this.input.removeListener("end", this._onEnd); } this.emit("close"); }
    write(d) { if (this.output && d != null) this.output.write(d); }
    getCursorPos() { return { rows: 0, cols: this.cursor }; }
    async *[Symbol.asyncIterator]() { const q = []; let wake = null, done = false; this.on("line", (l) => { q.push(l); if (wake) { wake(); wake = null; } }); this.on("close", () => { done = true; if (wake) { wake(); wake = null; } }); for (;;) { while (!q.length && !done) await new Promise((r) => (wake = r)); if (q.length) yield q.shift(); else if (done) return; } }
    [Symbol.dispose]() { this.close(); }
  }
  const emitKeypressEvents = (stream) => { if (stream._keypressDecoded) return; stream._keypressDecoded = true; stream.on("data", (d) => { const s = typeof d === "string" ? d : d.toString("utf8"); for (const key of parseKeys(s)) stream.emit("keypress", key.sequence.length === 1 && !key.ctrl && !key.meta ? key.sequence : undefined, key); }); };
  const parseKeys = (s) => { const out = []; let i = 0; while (i < s.length) { const ch = s[i]; if (ch === "\x1b" && s[i + 1] === "[" ) { let j = i + 2; while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++; const seq = s.slice(i, j + 1); const code = seq.slice(2); const names = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", "3~": "delete", "2~": "insert", "5~": "pageup", "6~": "pagedown", "1~": "home", "4~": "end", Z: "tab" }; out.push({ sequence: seq, name: names[code] || undefined, ctrl: false, meta: false, shift: code === "Z" || /;2/.test(code), code: seq }); i = j + 1; continue; } if (ch === "\x1b") { if (s.length > i + 1) { const k = parseKeys(s.slice(i + 1, i + 2))[0]; k.meta = true; k.sequence = "\x1b" + k.sequence; out.push(k); i += 2; continue; } out.push({ sequence: "\x1b", name: "escape", ctrl: false, meta: true, shift: false }); i++; continue; } if (ch === "\r") out.push({ sequence: ch, name: "return", ctrl: false, meta: false, shift: false }); else if (ch === "\n") out.push({ sequence: ch, name: "enter", ctrl: false, meta: false, shift: false }); else if (ch === "\t") out.push({ sequence: ch, name: "tab", ctrl: false, meta: false, shift: false }); else if (ch === "\x7f" || ch === "\b") out.push({ sequence: ch, name: "backspace", ctrl: false, meta: false, shift: false }); else if (ch === " ") out.push({ sequence: ch, name: "space", ctrl: false, meta: false, shift: false }); else if (ch.charCodeAt(0) < 32) out.push({ sequence: ch, name: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true, meta: false, shift: false }); else out.push({ sequence: ch, name: /[a-z]/i.test(ch) ? ch.toLowerCase() : undefined, ctrl: false, meta: false, shift: /[A-Z]/.test(ch) }); i++; } return out; };
  const rlPromises = { createInterface: (...a) => { const rl = new Interface(...a); const q = rl.question.bind(rl); rl.question = (t, o) => new Promise((res) => q(t, o, res)); return rl; }, Interface, Readline: class { constructor(o) { this.o = o; } clearLine() { return this; } clearScreenDown() { return this; } cursorTo() { return this; } moveCursor() { return this; } async commit() {} rollback() { return this; } } };
  mods.readline = { createInterface: (...a) => new Interface(...a), Interface, emitKeypressEvents, clearLine: (s, d, cb) => (s.clearLine ? s.clearLine(d, cb) : (cb && cb(), true)), clearScreenDown: (s, cb) => (s.clearScreenDown ? s.clearScreenDown(cb) : (cb && cb(), true)), cursorTo: (s, x, y, cb) => (s.cursorTo ? s.cursorTo(x, y, cb) : (cb && cb(), true)), moveCursor: (s, dx, dy, cb) => (s.moveCursor ? s.moveCursor(dx, dy, cb) : (cb && cb(), true)), promises: rlPromises };
  mods["readline/promises"] = rlPromises;
  fs._setReadline(mods.readline);
  // ---- constants / sys / punycode / diagnostics_channel / string_decoder / util/types ----
  mods.constants = Object.assign({}, fs.constants, ctx.os.constants.signals, { SIGINT: 2, SIGTERM: 15 });
  mods.sys = util;
  mods.punycode = { encode: (s) => s, decode: (s) => s, toASCII: (s) => { try { return new URL("http://" + s).hostname; } catch { return s; } }, toUnicode: (s) => s, ucs2: { decode: (s) => [...s].map((c) => c.codePointAt(0)), encode: (a) => String.fromCodePoint(...a) }, version: "2.1.0" };
  const dcChannels = new Map();
  class Channel { constructor(n) { this.name = n; this._subs = new Set(); } get hasSubscribers() { return this._subs.size > 0; } subscribe(f) { this._subs.add(f); } unsubscribe(f) { return this._subs.delete(f); } publish(m) { for (const f of this._subs) { try { f(m, this.name); } catch {} } } bindStore() {} unbindStore() {} runStores(d, fn, t, ...a) { return fn.apply(t, a); } }
  const dcChannel = (n) => { if (!dcChannels.has(n)) dcChannels.set(n, new Channel(n)); return dcChannels.get(n); };
  mods.diagnostics_channel = { channel: dcChannel, hasSubscribers: (n) => dcChannels.has(n) && dcChannels.get(n).hasSubscribers, subscribe: (n, f) => dcChannel(n).subscribe(f), unsubscribe: (n, f) => dcChannel(n).unsubscribe(f), tracingChannel: (n) => ({ start: dcChannel(n + ":start"), end: dcChannel(n + ":end"), asyncStart: dcChannel(n + ":asyncStart"), asyncEnd: dcChannel(n + ":asyncEnd"), error: dcChannel(n + ":error"), subscribe() {}, unsubscribe() {}, traceSync: (fn, c, t, ...a) => fn.apply(t, a), tracePromise: (fn, c, t, ...a) => fn.apply(t, a), traceCallback: (fn, p, c, t, ...a) => fn.apply(t, a), hasSubscribers: false }), Channel };
  mods["util/types"] = util.types;
  mods["stream/web"] = streamWeb; mods["stream/consumers"] = consumers; mods["stream/promises"] = stream.promises;
  mods["assert/strict"] = assert.strict;
  mods["dns/promises"] = ctx.dns.promises;
  mods["path/posix"] = path.posix; mods["path/win32"] = path.win32;
  mods["fs/promises"] = fs.promises;
  mods.cluster = { isMaster: true, isPrimary: true, isWorker: false, workers: {}, fork: stubFn("cluster.fork"), on() {}, once() {}, setupPrimary() {}, setupMaster() {}, schedulingPolicy: 2, SCHED_NONE: 1, SCHED_RR: 2 };
  mods.dgram = { createSocket: () => { noteMissing("dgram.createSocket", "call"); const s = new EventEmitter(); s.bind = (p, cb) => { if (cb) queueMicrotask(cb); }; s.send = (b, ...a) => { const cb = a.find((x) => typeof x === "function"); if (cb) queueMicrotask(() => cb(errnoError("ENETUNREACH", "send"))); }; s.close = (cb) => cb && cb(); s.address = () => ({ address: "0.0.0.0", port: 0, family: "IPv4" }); s.setBroadcast = () => {}; s.unref = () => s; s.ref = () => s; s.setMulticastTTL = () => {}; s.addMembership = () => {}; return s; } };
  mods.domain = { create: () => Object.assign(new EventEmitter(), { run: (fn) => fn(), add() {}, remove() {}, bind: (fn) => fn, intercept: (fn) => fn, enter() {}, exit() {} }), Domain: class extends EventEmitter {} };
  mods.trace_events = { createTracing: () => ({ enable() {}, disable() {}, enabled: false, categories: "" }), getEnabledCategories: () => undefined };
  mods.wasi = { WASI: class { constructor() { noteMissing("wasi.WASI", "call"); } } };
  mods.repl = { start: () => { noteMissing("repl.start", "call"); return new EventEmitter(); }, REPLServer: class {}, REPL_MODE_SLOPPY: Symbol("sloppy"), REPL_MODE_STRICT: Symbol("strict") };
  mods.console = globalThis.console;
  mods.process = proc;
  mods.tty = ctx.tty; mods.os = ctx.os; mods.fs = fs; mods.path = path; mods.util = util; mods.events = events; mods.stream = stream; mods.url = url; mods.zlib = zlib; mods.crypto = crypto; mods.assert = assert; mods.querystring = querystring; mods.string_decoder = string_decoder; mods.buffer = bufmod;
  mods.child_process = ctx.child_process; mods.net = ctx.net; mods.tls = ctx.tls; mods.dns = ctx.dns; mods.http = ctx.http; mods.https = ctx.https; mods.http2 = ctx.http2;
  // ---- non-builtin modules Bun/Node-with-deps would resolve: undici, ws (both exist as bundled deps
  // in Bun; under plain node they'd be MODULE_NOT_FOUND — Claude Code guards them) ----
  class Dispatcher extends EventEmitter { dispatch() { return true; } close() { return Promise.resolve(); } destroy() { return Promise.resolve(); } compose() { return this; } }
  class UAgent extends Dispatcher { constructor(o) { super(); this.options = o; } }
  mods.undici = { fetch: (...a) => globalThis.fetch(...a), Request: globalThis.Request, Response: globalThis.Response, Headers: globalThis.Headers, FormData: globalThis.FormData, File: globalThis.File, Blob: globalThis.Blob, WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, Agent: UAgent, ProxyAgent: class extends UAgent {}, EnvHttpProxyAgent: class extends UAgent {}, Pool: class extends UAgent {}, Client: class extends UAgent {}, Dispatcher, setGlobalDispatcher() {}, getGlobalDispatcher: () => new UAgent(), errors: { UndiciError: class extends Error {} }, buildConnector: () => () => {}, interceptors: { redirect: () => (d) => d, retry: () => (d) => d, dns: () => (d) => d }, RetryAgent: class extends UAgent {}, request: async (u, o) => { const r = await globalThis.fetch(u, o); return { statusCode: r.status, headers: Object.fromEntries(r.headers), body: Object.assign(r.body, { text: () => r.text(), json: () => r.json(), arrayBuffer: () => r.arrayBuffer() }) }; }, stream: stubFn("undici.stream"), pipeline: stubFn("undici.pipeline"), connect: stubFn("undici.connect"), upgrade: stubFn("undici.upgrade"), MockAgent: class extends UAgent {}, mockErrors: {} };
  class WSServer extends EventEmitter { constructor(o, cb) { super(); noteMissing("ws.WebSocketServer", "call"); this.clients = new Set(); this.options = o || {}; if (cb) queueMicrotask(cb); } close(cb) { if (cb) cb(); } handleUpgrade() {} shouldHandle() { return true; } address() { return { port: (this.options && this.options.port) || 0, address: "127.0.0.1", family: "IPv4" }; } }
  const WS = globalThis.WebSocket; mods.ws = Object.assign(WS ? class WebSocket extends WS { constructor(u, p, o) { super(u, Array.isArray(p) ? p : p ? [p] : undefined); this.on = (n, f) => { this.addEventListener(n, (ev) => (n === "message" ? f(ev.data, false) : n === "close" ? f(ev.code, ev.reason) : n === "error" ? f(new Error("websocket error")) : f(ev))); return this; }; this.once = (n, f) => { this.addEventListener(n, (ev) => (n === "message" ? f(ev.data, false) : n === "close" ? f(ev.code, ev.reason) : f(ev)), { once: true }); return this; }; this.off = () => this; this.removeAllListeners = () => this; this.ping = () => {}; this.pong = () => {}; this.terminate = () => this.close(); } } : class { constructor() { throw new Error("no WebSocket"); } }, { WebSocketServer: WSServer, Server: WSServer, createWebSocketStream: stubFn("ws.createWebSocketStream") }); mods.ws.WebSocket = mods.ws;
  return mods;
}

// util.parseArgs (Node 18.3+), a faithful-enough port
function parseArgs(config = {}) {
  const { args = [], options = {}, strict = true, allowPositionals = !strict, allowNegative = false, tokens: wantTokens = false } = config;
  const values = {}, positionals = [], tokens = [];
  const short = {}; for (const [k, v] of Object.entries(options)) { if (v.short) short[v.short] = k; if (v.default !== undefined) values[k] = v.default; }
  const setVal = (name, val) => { const o = options[name]; if (o && o.multiple) (values[name] = values[name] || []).push(val); else values[name] = val; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { for (const p of args.slice(i + 1)) { positionals.push(p); tokens.push({ kind: "positional", index: i, value: p }); } tokens.push({ kind: "option-terminator", index: i }); break; }
    if (a.startsWith("--")) {
      let [name, val] = a.slice(2).split(/=(.*)/s);
      let neg = false; if (allowNegative && name.startsWith("no-") && !(name in options)) { name = name.slice(3); neg = true; }
      const o = options[name];
      if (!o && strict) { const e = new TypeError(`Unknown option '--${name}'`); e.code = "ERR_PARSE_ARGS_UNKNOWN_OPTION"; throw e; }
      if (o && o.type === "string") { if (val === undefined) { if (i + 1 < args.length) val = args[++i]; else if (strict) { const e = new TypeError(`Option '--${name} <value>' argument missing`); e.code = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"; throw e; } } setVal(name, val); }
      else { if (val !== undefined && strict) { const e = new TypeError(`Option '--${name}' does not take an argument`); e.code = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"; throw e; } setVal(name, !neg); }
      tokens.push({ kind: "option", name, rawName: a.split("=")[0], index: i, value: values[name], inlineValue: val !== undefined });
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j], name = short[c];
        if (!name && strict) { const e = new TypeError(`Unknown option '-${c}'`); e.code = "ERR_PARSE_ARGS_UNKNOWN_OPTION"; throw e; }
        const o = options[name];
        if (o && o.type === "string") { const val = j + 1 < a.length ? a.slice(j + 1) : args[++i]; setVal(name, val); tokens.push({ kind: "option", name, rawName: "-" + c, index: i, value: val }); break; }
        setVal(name || c, true); tokens.push({ kind: "option", name: name || c, rawName: "-" + c, index: i, value: undefined });
      }
      continue;
    }
    if (!allowPositionals) { const e = new TypeError(`Unexpected argument '${a}'. This command does not take positional arguments`); e.code = "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"; throw e; }
    positionals.push(a); tokens.push({ kind: "positional", index: i, value: a });
  }
  const out = { values, positionals }; if (wantTokens) out.tokens = tokens; return out;
}
