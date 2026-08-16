// child_process, net, tls, dns, http, https, http2 — everything that leaves the JS heap goes through
// the backend (spawn/netConnect) or through global fetch (which the worker routes to the /net/fetch
// gateway). Backend #1 can run nothing and refuses raw sockets; the shapes are complete enough for
// Claude Code's startup to proceed and every attempt is recorded.
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Readable, Writable, Duplex, PassThrough } from "readable-stream";
import { errnoError } from "./errors.js";
import { noteMissing, stubFn } from "./record.js";
import { SIGNALS } from "./process.js";

export function makeChildProcess(B, proc) {
  const spawnLog = [];
  const spec = (file, args, opts) => ({ file: String(file), args: (args || []).map(String), cwd: opts && opts.cwd ? String(opts.cwd) : proc.cwd(), env: opts && opts.env ? opts.env : proc.env, stdio: opts && opts.stdio, shell: opts && opts.shell });
  class ChildProcess extends EventEmitter {
    constructor() { super(); this.pid = undefined; this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false; this.spawnfile = ""; this.spawnargs = []; this.stdin = null; this.stdout = null; this.stderr = null; this.stdio = [null, null, null]; }
    kill(sig) { this.killed = true; if (this.pid) B.call("procKill", this.pid, sig || "SIGTERM"); return true; }
    ref() {} unref() {} disconnect() {} send() { return false; }
    [Symbol.dispose]() { this.kill(); }
  }
  function spawn(file, args, opts) {
    if (!Array.isArray(args)) { opts = args; args = []; }
    opts = opts || {};
    const s = spec(file, args, opts);
    spawnLog.push({ file: s.file, args: s.args, cwd: s.cwd });
    const cp = new ChildProcess();
    cp.spawnfile = s.file; cp.spawnargs = [s.file, ...s.args];
    const stdio = Array.isArray(opts.stdio) ? opts.stdio : [opts.stdio || "pipe", opts.stdio || "pipe", opts.stdio || "pipe"];
    cp.stdin = stdio[0] === "pipe" || stdio[0] == null ? new Writable({ write(c, e, cb) { if (cp.pid) B.call("procInput", cp.pid, typeof c === "string" ? Buffer.from(c, e) : c); cb(); }, final(cb) { if (cp.pid) B.call("procInput", cp.pid, null); cb(); } }) : null;
    cp.stdout = stdio[1] === "pipe" || stdio[1] == null ? new PassThrough() : null;
    cp.stderr = stdio[2] === "pipe" || stdio[2] == null ? new PassThrough() : null;
    cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
    if (opts.encoding && cp.stdout) { cp.stdout.setEncoding(opts.encoding); cp.stderr && cp.stderr.setEncoding(opts.encoding); }
    let r;
    try { r = B.call("spawn", s); } catch (e) { r = { error: e.__errno || "ENOENT" }; }
    if (r.error) {
      queueMicrotask(() => { const e = errnoError(r.error, "spawn " + s.file, undefined); e.spawnargs = s.args; e.path = s.file; cp.emit("error", e); cp.stdout && cp.stdout.end(); cp.stderr && cp.stderr.end(); cp.emit("close", -2, null); });
      return cp;
    }
    cp.pid = r.pid;
    const off = B.on("proc", (ev) => {
      if (ev.pid !== cp.pid) return;
      if (ev.stream === "stdout" && cp.stdout) cp.stdout.write(Buffer.from(ev.data));
      else if (ev.stream === "stderr" && cp.stderr) cp.stderr.write(Buffer.from(ev.data));
      else if (ev.exit !== undefined) { off(); cp.exitCode = ev.exit; cp.signalCode = ev.signal || null; cp.stdout && cp.stdout.end(); cp.stderr && cp.stderr.end(); cp.emit("exit", ev.exit, ev.signal || null); queueMicrotask(() => cp.emit("close", ev.exit, ev.signal || null)); }
    });
    queueMicrotask(() => cp.emit("spawn"));
    return cp;
  }
  function spawnSync(file, args, opts) {
    if (!Array.isArray(args)) { opts = args; args = []; }
    opts = opts || {};
    const s = spec(file, args, opts);
    spawnLog.push({ file: s.file, args: s.args, cwd: s.cwd, sync: true });
    let r; try { r = B.call("spawnSync", s); } catch (e) { r = { error: e.__errno || "ENOENT" }; }
    const enc = opts.encoding && opts.encoding !== "buffer" ? opts.encoding : null;
    const out = (b) => (b ? (enc ? Buffer.from(b).toString(enc) : Buffer.from(b)) : enc ? "" : Buffer.alloc(0));
    if (r.error) { const e = errnoError(r.error, "spawnSync " + s.file); e.path = s.file; e.spawnargs = s.args; return { pid: 0, output: [null, out(), out()], stdout: out(), stderr: out(), status: null, signal: null, error: e }; }
    return { pid: r.pid || 0, output: [null, out(r.stdout), out(r.stderr)], stdout: out(r.stdout), stderr: out(r.stderr), status: r.status == null ? null : r.status, signal: r.signal || null };
  }
  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; } else if (typeof opts === "function") { cb = opts; opts = Array.isArray(args) ? {} : args; if (!Array.isArray(args)) args = []; }
    opts = opts || {};
    const cp = spawn(file, args, opts);
    const so = [], se = []; let done = false;
    cp.stdout && cp.stdout.on("data", (d) => so.push(d)); cp.stderr && cp.stderr.on("data", (d) => se.push(d));
    const enc = opts.encoding === "buffer" ? null : opts.encoding || "utf8";
    const join = (a) => (enc ? a.map((x) => (typeof x === "string" ? x : x.toString(enc))).join("") : Buffer.concat(a.map((x) => (typeof x === "string" ? Buffer.from(x) : x))));
    const finish = (err, code, sig) => { if (done) return; done = true; if (!err && code !== 0) { err = new Error(`Command failed: ${file} ${args.join(" ")}\n${join(se)}`); err.code = code; err.killed = false; err.signal = sig; err.cmd = `${file} ${args.join(" ")}`; } if (err) { err.stdout = join(so); err.stderr = join(se); } cb && cb(err, join(so), join(se)); };
    cp.on("error", (e) => finish(e));
    cp.on("close", (code, sig) => finish(null, code, sig));
    let timer = null; if (opts.timeout) timer = setTimeout(() => cp.kill(opts.killSignal || "SIGTERM"), opts.timeout);
    cp.on("close", () => timer && clearTimeout(timer));
    return cp;
  }
  function exec(cmd, opts, cb) { if (typeof opts === "function") { cb = opts; opts = {}; } return execFile("/bin/sh", ["-c", cmd], Object.assign({}, opts, { shell: false }), cb); }
  function execFileSync(file, args, opts) { if (!Array.isArray(args)) { opts = args; args = []; } opts = opts || {}; const r = spawnSync(file, args, opts); if (r.error) throw r.error; if (r.status !== 0) { const e = new Error(`Command failed: ${file} ${args.join(" ")}`); e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr; throw e; } return r.stdout; }
  function execSync(cmd, opts) { return execFileSync("/bin/sh", ["-c", cmd], opts); }
  function fork() { noteMissing("child_process.fork", "call"); const cp = new ChildProcess(); queueMicrotask(() => cp.emit("error", errnoError("ENOSYS", "fork"))); return cp; }
  const promisify = (fn) => { fn[Symbol.for("nodejs.util.promisify.custom")] = (...a) => new Promise((res, rej) => fn(...a, (err, stdout, stderr) => (err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr })))); return fn; };
  promisify(exec); promisify(execFile);
  return { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, ChildProcess, _spawnLog: spawnLog };
}

export function makeNet(B) {
  const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
  const isIPv6 = (s) => typeof s === "string" && s.includes(":") && /^[0-9a-fA-F:.%]+$/.test(s);
  const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);
  class Socket extends Duplex {
    constructor(opts) { super({ allowHalfOpen: false }); this.connecting = false; this.destroyed = false; this.remoteAddress = undefined; this.remotePort = undefined; this.localAddress = "127.0.0.1"; this.localPort = 0; this.bytesRead = 0; this.bytesWritten = 0; this._id = null; this.pending = true; this.readyState = "closed"; this.timeout = 0; if (opts && opts.fd != null) noteMissing("net.Socket({fd})", "call"); }
    connect(port, host, cb) {
      let o = port; if (typeof port !== "object") o = { port, host: typeof host === "string" ? host : undefined }; else cb = host;
      if (typeof cb === "function") this.once("connect", cb);
      this.connecting = true; this.readyState = "opening";
      let r; try { r = B.call("netConnect", { host: o.host || o.path || "localhost", port: o.port, path: o.path, tls: !!o._tls, servername: o.servername }); } catch (e) { r = { error: e.__errno || "ECONNREFUSED" }; }
      if (r.error) { queueMicrotask(() => { this.connecting = false; const e = errnoError(r.error, "connect", undefined); e.address = o.host; e.port = o.port; this.destroy(e); }); return this; }
      this._id = r.id; this.remoteAddress = o.host; this.remotePort = o.port;
      const off = B.on("net", (ev) => { if (ev.id !== this._id) return; if (ev.data) { this.bytesRead += ev.data.byteLength; this.push(Buffer.from(ev.data)); } else if (ev.end) { this.push(null); } else if (ev.error) { off(); this.destroy(errnoError(ev.error, "read")); } else if (ev.connected) { this.connecting = false; this.pending = false; this.readyState = "open"; this.emit("connect"); this.emit("ready"); } });
      return this;
    }
    _read() {}
    _write(chunk, enc, cb) { const b = typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk; this.bytesWritten += b.byteLength; if (this._id != null) B.call("netWrite", this._id, b); cb(); }
    _final(cb) { if (this._id != null) B.call("netEnd", this._id); cb(); }
    _destroy(e, cb) { this.readyState = "closed"; if (this._id != null) { try { B.call("netEnd", this._id); } catch {} } cb(e); }
    setTimeout(ms, cb) { this.timeout = ms; if (cb) this.once("timeout", cb); return this; }
    setNoDelay() { return this; } setKeepAlive() { return this; } address() { return { address: this.localAddress, port: this.localPort, family: "IPv4" }; } ref() { return this; } unref() { return this; } resetAndDestroy() { this.destroy(); return this; }
  }
  class Server extends EventEmitter {
    constructor(opts, listener) { super(); if (typeof opts === "function") listener = opts; if (listener) this.on("connection", listener); this.listening = false; this._addr = null; this.maxConnections = undefined; }
    listen(...args) { let cb = args.find((a) => typeof a === "function"); const o = typeof args[0] === "object" && args[0] ? args[0] : { port: typeof args[0] === "number" || typeof args[0] === "string" && /^\d+$/.test(args[0]) ? Number(args[0]) : 0, host: typeof args[1] === "string" ? args[1] : undefined, path: typeof args[0] === "string" && !/^\d+$/.test(args[0]) ? args[0] : undefined }; const port = o.port || (o.path ? 0 : 40000 + Math.floor(Math.random() * 20000)); this._addr = o.path ? o.path : { address: o.host || "::", family: o.host && isIPv4(o.host) ? "IPv4" : "IPv6", port }; noteMissing(`net.Server.listen(${o.path || port})`, "call"); this.listening = true; if (cb) this.once("listening", cb); queueMicrotask(() => this.emit("listening")); return this; }
    address() { return this._addr; }
    close(cb) { this.listening = false; queueMicrotask(() => { this.emit("close"); cb && cb(); }); return this; }
    getConnections(cb) { cb(null, 0); } ref() { return this; } unref() { return this; } [Symbol.asyncDispose]() { return new Promise((r) => this.close(r)); }
  }
  const createConnection = (...args) => { let o = args[0], cb; if (typeof o !== "object") { o = { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined }; cb = args.find((a) => typeof a === "function"); } else cb = args[1]; const s = new Socket(); return s.connect(o, cb); };
  const net = { Socket, Server, Stream: Socket, createServer: (o, l) => new Server(o, l), createConnection, connect: createConnection, isIP, isIPv4, isIPv6, BlockList: class BlockList { constructor() { this.rules = []; } addAddress(a, f = "ipv4") { this.rules.push(`Address: ${f.toUpperCase()} ${a}`); } addRange(a, b, f = "ipv4") { this.rules.push(`Range: ${f.toUpperCase()} ${a}-${b}`); } addSubnet(a, p, f = "ipv4") { this.rules.push(`Subnet: ${f.toUpperCase()} ${a}/${p}`); } check() { return false; } }, SocketAddress: class SocketAddress { constructor(o = {}) { this.address = o.address || "127.0.0.1"; this.family = o.family || "ipv4"; this.port = o.port || 0; this.flowlabel = o.flowlabel || 0; } static parse(s) { const m = /^(.*?)(?::(\d+))?$/.exec(s); return m ? new SocketAddress({ address: m[1], port: Number(m[2] || 0) }) : undefined; } }, getDefaultAutoSelectFamily: () => true, setDefaultAutoSelectFamily() {}, getDefaultAutoSelectFamilyAttemptTimeout: () => 250, setDefaultAutoSelectFamilyAttemptTimeout() {} };
  // tls
  class TLSSocket extends Socket { constructor(sock, opts) { super(); this.encrypted = true; this.authorized = true; this.alpnProtocol = false; this.servername = opts && opts.servername; } getPeerCertificate() { return {}; } getProtocol() { return "TLSv1.3"; } getCipher() { return { name: "TLS_AES_256_GCM_SHA384", version: "TLSv1.3" }; } getSession() {} setSession() {} isSessionReused() { return false; } }
  const tlsConnect = (...args) => { let o = args[0], cb; if (typeof o !== "object") { o = { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined }; cb = args.find((a) => typeof a === "function"); } else cb = args[1]; const s = new TLSSocket(null, o); if (cb) s.once("secureConnect", cb); s.on("connect", () => s.emit("secureConnect")); return s.connect(Object.assign({}, o, { _tls: true })); };
  const tls = { TLSSocket, connect: tlsConnect, createServer: (o, l) => new Server(o, l), Server, createSecureContext: (o) => ({ context: o }), SecureContext: class {}, checkServerIdentity: () => undefined, getCiphers: () => ["tls_aes_256_gcm_sha384"], rootCertificates: [], DEFAULT_MIN_VERSION: "TLSv1.2", DEFAULT_MAX_VERSION: "TLSv1.3", DEFAULT_CIPHERS: "", DEFAULT_ECDH_CURVE: "auto", CLIENT_RENEG_LIMIT: 3, CLIENT_RENEG_WINDOW: 600 };
  // dns: resolution happens host-side in the gateway; only literal answers here
  const lookupErr = (host) => { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = "ENOTFOUND"; e.errno = -3008; e.syscall = "getaddrinfo"; e.hostname = host; return e; };
  const lookup = (host, opts, cb) => { if (typeof opts === "function") { cb = opts; opts = {}; } opts = typeof opts === "number" ? { family: opts } : opts || {}; const done = (addr, fam) => queueMicrotask(() => (opts.all ? cb(null, [{ address: addr, family: fam }]) : cb(null, addr, fam))); if (host === "localhost" || host === "127.0.0.1" || !host) return done("127.0.0.1", 4); if (isIPv4(host)) return done(host, 4); if (isIPv6(host)) return done(host, 6); noteMissing("dns.lookup(" + host + ")", "call"); queueMicrotask(() => cb(lookupErr(host))); };
  lookup[Symbol.for("nodejs.util.promisify.custom")] = (host, opts) => new Promise((res, rej) => lookup(host, opts, (e, a, f) => (e ? rej(e) : res(opts && opts.all ? a : { address: a, family: f }))));
  const dnsPromises = { lookup: (h, o) => lookup[Symbol.for("nodejs.util.promisify.custom")](h, o), resolve: async (h) => { noteMissing("dns.promises.resolve", "call"); throw lookupErr(h); }, resolve4: async (h) => { throw lookupErr(h); }, resolve6: async (h) => { throw lookupErr(h); }, resolveTxt: async (h) => { throw lookupErr(h); }, resolveSrv: async (h) => { throw lookupErr(h); }, resolveMx: async (h) => { throw lookupErr(h); }, reverse: async () => [], setServers() {}, getServers: () => ["8.8.8.8"], Resolver: class { resolve4(h, cb) { cb(lookupErr(h)); } setServers() {} } };
  const dns = { lookup, promises: dnsPromises, resolve: (h, t, cb) => (cb || t)(lookupErr(h)), resolve4: (h, o, cb) => (cb || o)(lookupErr(h)), resolve6: (h, o, cb) => (cb || o)(lookupErr(h)), resolveTxt: (h, cb) => cb(lookupErr(h)), resolveSrv: (h, cb) => cb(lookupErr(h)), reverse: (a, cb) => cb(null, []), setServers() {}, getServers: () => ["8.8.8.8"], setDefaultResultOrder() {}, getDefaultResultOrder: () => "verbatim", Resolver: dnsPromises.Resolver, ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256, NODATA: "ENODATA", NOTFOUND: "ENOTFOUND" };
  return { net, tls, dns };
}

// http/https over global fetch (the worker's fetch → /net/fetch gateway): enough for
// http.request/get + Agent objects + a Server that "listens" (the OAuth callback server needs to
// bind before the login URL is printed; nothing can reach it — recorded).
export function makeHttp(B, net, opts) {
  const STATUS_CODES = { 100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
  const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"];
  class Agent extends EventEmitter { constructor(o) { super(); this.options = o || {}; this.keepAlive = !!(o && o.keepAlive); this.maxSockets = (o && o.maxSockets) || Infinity; this.maxFreeSockets = 256; this.sockets = {}; this.freeSockets = {}; this.requests = {}; this.protocol = "http:"; this.defaultPort = 80; } destroy() {} getName() { return "localhost:80:"; } addRequest() {} }
  class IncomingMessage extends Readable {
    constructor(res, url) { super(); this.statusCode = res.status; this.statusMessage = res.statusText || STATUS_CODES[res.status] || ""; this.headers = {}; this.rawHeaders = []; res.headers.forEach((v, k) => { this.headers[k] = k === "set-cookie" ? [v] : v; this.rawHeaders.push(k, v); }); this.headersDistinct = {}; this.httpVersion = "1.1"; this.httpVersionMajor = 1; this.httpVersionMinor = 1; this.complete = false; this.url = url; this.method = null; this.socket = new net.Socket(); this.connection = this.socket; this.aborted = false; this.trailers = {}; this._reader = res.body ? res.body.getReader() : null; }
    _read() { if (!this._reader) { this.push(null); return; } this._reader.read().then(({ done, value }) => { if (done) { this.complete = true; this.push(null); } else this.push(Buffer.from(value)); }, (e) => this.destroy(e)); }
    setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
    _destroy(e, cb) { if (this._reader) this._reader.cancel().catch(() => {}); cb(e); }
  }
  class ClientRequest extends Writable {
    constructor(u, o, cb) {
      super({ decodeStrings: true, autoDestroy: false, emitClose: false });
      if (typeof u === "string" || u instanceof URL) { u = new URL(String(u)); o = Object.assign({}, o, { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, auth: u.username ? u.username + ":" + u.password : undefined }); }
      else { cb = o; o = u; }
      this.o = o || {}; this.method = (this.o.method || "GET").toUpperCase(); this.aborted = false; this.destroyed = false; this.reusedSocket = false;
      this._headers = {}; for (const [k, v] of Object.entries(this.o.headers || {})) this._headers[k.toLowerCase()] = v;
      this.path = this.o.path || "/"; this.host = this.o.hostname || this.o.host || "localhost"; this.protocol = this.o.protocol || (opts && opts.protocol) || "http:";
      this._chunks = []; this.socket = new net.Socket(); this.connection = this.socket; this.res = null; this._sent = false;
      if (cb) this.once("response", cb);
      queueMicrotask(() => this.emit("socket", this.socket));
    }
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; } getHeader(k) { return this._headers[k.toLowerCase()]; } removeHeader(k) { delete this._headers[k.toLowerCase()]; } getHeaders() { return Object.assign({}, this._headers); } getHeaderNames() { return Object.keys(this._headers); } hasHeader(k) { return k.toLowerCase() in this._headers; } getRawHeaderNames() { return Object.keys(this._headers); }
    setTimeout(ms, cb) { this._timeout = ms; if (cb) this.once("timeout", cb); return this; } setNoDelay() {} setSocketKeepAlive() {} flushHeaders() {}
    _write(chunk, enc, cb) { this._chunks.push(chunk); cb(); }
    _final(cb) { this._send(); cb(); }
    abort() { this.aborted = true; this.destroy(); }
    // destroy before the response arrived (or with an error) == abort the fetch; a plain destroy after
    // the response is what http.request users do to release the socket — nothing to do here
    _destroy(e, cb) { if (this._ac && (e || !this.res)) this._ac.abort(); cb(e); }
    _send() {
      if (this._sent) return; this._sent = true;
      const port = this.o.port ? ":" + this.o.port : "";
      const url = `${this.protocol}//${this.host}${port}${this.path}`;
      const headers = {}; for (const [k, v] of Object.entries(this._headers)) if (v != null && k !== "host" && k !== "content-length" && k !== "connection") headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      if (this.o.auth) headers.authorization = "Basic " + Buffer.from(this.o.auth).toString("base64");
      const body = this._chunks.length ? Buffer.concat(this._chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c))) : undefined;
      this._ac = new AbortController();
      const timer = this._timeout ? setTimeout(() => { this.emit("timeout"); }, this._timeout) : null;
      fetch(url, { method: this.method, headers, body: this.method === "GET" || this.method === "HEAD" ? undefined : body, signal: this._ac.signal, redirect: "manual" }).then((res) => {
        if (timer) clearTimeout(timer);
        const im = new IncomingMessage(res, this.path); im.req = this; this.res = im; this.emit("response", im);
      }, (e) => { if (timer) clearTimeout(timer); const err = e && e.name === "AbortError" ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) : Object.assign(new Error(String(e && e.message || e)), { code: "ECONNREFUSED", cause: e }); this.emit("error", err); });
    }
  }
  const request = (u, o, cb) => new ClientRequest(u, o, cb);
  const get = (u, o, cb) => { const r = request(u, o, cb); r.end(); return r; };
  class ServerResponse extends Writable { constructor(req) { super(); this.req = req; this.statusCode = 200; this.statusMessage = ""; this.headersSent = false; this._h = {}; this.finished = false; } setHeader(k, v) { this._h[k.toLowerCase()] = v; return this; } getHeader(k) { return this._h[k.toLowerCase()]; } removeHeader(k) { delete this._h[k.toLowerCase()]; } getHeaders() { return this._h; } hasHeader(k) { return k.toLowerCase() in this._h; } writeHead(c, m, h) { this.statusCode = c; if (typeof m === "object") h = m; else this.statusMessage = m || ""; if (h) for (const [k, v] of Object.entries(h)) this._h[k.toLowerCase()] = v; this.headersSent = true; return this; } _write(c, e, cb) { cb(); } _final(cb) { this.finished = true; cb(); } setTimeout() { return this; } flushHeaders() {} }
  class Server extends net.Server { constructor(o, l) { super(typeof o === "function" ? undefined : o, undefined); if (typeof o === "function") l = o; if (l) this.on("request", l); this.timeout = 0; this.keepAliveTimeout = 5000; this.headersTimeout = 60000; this.requestTimeout = 300000; this.maxHeadersCount = null; } setTimeout(ms, cb) { this.timeout = ms; if (cb) this.on("timeout", cb); return this; } closeAllConnections() {} closeIdleConnections() {} }
  const http = { STATUS_CODES, METHODS, Agent, globalAgent: new Agent({ keepAlive: true }), request, get, IncomingMessage, ClientRequest, ServerResponse, OutgoingMessage: Writable, Server, createServer: (o, l) => new Server(o, l), maxHeaderSize: 16384, validateHeaderName() {}, validateHeaderValue() {}, setMaxIdleHTTPParsers() {}, WebSocket: globalThis.WebSocket, CloseEvent: globalThis.CloseEvent, MessageEvent: globalThis.MessageEvent };
  const httpsAgent = class HttpsAgent extends Agent { constructor(o) { super(o); this.protocol = "https:"; this.defaultPort = 443; } };
  const https = Object.assign({}, http, { Agent: httpsAgent, globalAgent: new httpsAgent({ keepAlive: true }), request: (u, o, cb) => { const r = new ClientRequest(u, o, cb); if (!r.o.protocol) r.protocol = "https:"; return r; }, get: (u, o, cb) => { const r = https.request(u, o, cb); r.end(); return r; }, Server, createServer: (o, l) => new Server(o, l) });
  const http2 = { connect: (authority, o, cb) => { noteMissing("http2.connect", "call"); const s = new EventEmitter(); s.request = () => { const st = new Duplex({ read() {}, write(c, e, cb) { cb(); } }); queueMicrotask(() => st.emit("error", errnoError("ECONNREFUSED", "connect"))); return st; }; s.close = (cb) => cb && cb(); s.destroy = () => {}; s.setTimeout = () => {}; s.socket = new net.Socket(); s.destroyed = false; s.closed = false; queueMicrotask(() => s.emit("error", errnoError("ECONNREFUSED", "connect"))); return s; }, createServer: () => new Server(), createSecureServer: () => new Server(), constants: { HTTP2_HEADER_PATH: ":path", HTTP2_HEADER_METHOD: ":method", HTTP2_HEADER_STATUS: ":status", HTTP2_HEADER_AUTHORITY: ":authority", HTTP2_HEADER_SCHEME: ":scheme", HTTP2_HEADER_CONTENT_TYPE: "content-type", HTTP2_HEADER_CONTENT_LENGTH: "content-length", NGHTTP2_CANCEL: 8, HTTP_STATUS_OK: 200 }, sensitiveHeaders: Symbol("nodejs.http2.sensitiveHeaders"), getDefaultSettings: () => ({}), getPackedSettings: () => Buffer.alloc(0), Http2ServerRequest: class {}, Http2ServerResponse: class {} };
  return { http, https, http2 };
}
