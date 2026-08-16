// `process`, `tty`, `os` for the worker: everything host-specific comes from the backend.
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Readable, Writable } from "readable-stream";
import { noteMissing, stubFn } from "./record.js";
import { errnoError } from "./errors.js";

export const NODE_VERSION = "v22.23.2"; // what the claude-npm image ships (usr/local/bin/node)

export function makeTty(B) {
  class WriteStream extends Writable {
    constructor(fd) {
      super({ decodeStrings: false, highWaterMark: 1 << 20 });
      this.fd = fd; this.isTTY = true; this._type = "tty"; this.isRaw = false;
      const s = B.call("ttySize"); this.columns = s.cols; this.rows = s.rows;
      B.on("tty", (ev) => { if (ev.resize) { this.columns = ev.resize.cols; this.rows = ev.resize.rows; this.emit("resize"); } });
    }
    _write(chunk, enc, cb) { B.call("ttyWrite", this.fd, typeof chunk === "string" ? Buffer.from(chunk, enc === "buffer" ? "utf8" : enc) : chunk); cb(); }
    _writev(chunks, cb) { for (const c of chunks) B.call("ttyWrite", this.fd, typeof c.chunk === "string" ? Buffer.from(c.chunk, c.encoding === "buffer" ? "utf8" : c.encoding) : c.chunk); cb(); }
    // Node's tty.WriteStream.write is synchronous for ttys: keep that (Ink relies on ordering, not on drain)
    write(chunk, enc, cb) { if (typeof enc === "function") { cb = enc; enc = undefined; } B.call("ttyWrite", this.fd, typeof chunk === "string" ? Buffer.from(chunk, enc || "utf8") : chunk); if (cb) queueMicrotask(cb); return true; }
    getWindowSize() { return [this.columns, this.rows]; }
    getColorDepth() { return 24; }
    hasColors(n) { return true; }
    clearLine(dir, cb) { this.write(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K"); if (cb) cb(); return true; }
    clearScreenDown(cb) { this.write("\x1b[0J"); if (cb) cb(); return true; }
    cursorTo(x, y, cb) { if (typeof y === "function") { cb = y; y = undefined; } this.write(y == null ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`); if (cb) cb(); return true; }
    moveCursor(dx, dy, cb) { let s = ""; if (dx < 0) s += `\x1b[${-dx}D`; else if (dx > 0) s += `\x1b[${dx}C`; if (dy < 0) s += `\x1b[${-dy}A`; else if (dy > 0) s += `\x1b[${dy}B`; this.write(s); if (cb) cb(); return true; }
    ref() { return this; } unref() { return this; }
    _destroy(e, cb) { cb(e); }
  }
  class ReadStream extends Readable {
    constructor(fd) {
      super({ highWaterMark: 65536 });
      this.fd = fd; this.isTTY = true; this.isRaw = false; this._type = "tty";
      B.on("tty", (ev) => { if (ev.data) { const b = Buffer.from(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength); this.push(b); } else if (ev.eof) this.push(null); });
    }
    _read() {}
    setRawMode(on) { this.isRaw = !!on; B.call("ttySetRaw", !!on); return this; }
    ref() { return this; } unref() { return this; }
  }
  return { isatty: (fd) => !!B.call("isatty", fd), WriteStream, ReadStream };
}

export function makeOs(B, info) {
  const env = info.env;
  const os = {
    EOL: "\n", devNull: "/dev/null",
    platform: () => "linux", type: () => "Linux", arch: () => "x64", machine: () => "x86_64", release: () => "6.1.0-nanobox", version: () => "#1 SMP nanobox",
    hostname: () => info.hostname || "nanobox", homedir: () => env.HOME || "/root", tmpdir: () => env.TMPDIR || env.TMP || env.TEMP || "/tmp",
    endianness: () => "LE", uptime: () => performance.now() / 1000, loadavg: () => [0, 0, 0],
    totalmem: () => 4 * 1024 ** 3, freemem: () => 2 * 1024 ** 3, availableParallelism: () => (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4,
    cpus: () => Array.from({ length: os.availableParallelism() }, () => ({ model: "nanobox virtual cpu", speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
    networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] }),
    userInfo: () => ({ uid: info.uid, gid: info.gid, username: "root", homedir: env.HOME || "/root", shell: "/bin/sh" }),
    getPriority: () => 0, setPriority: () => {},
    constants: { signals: SIGNALS, errno: {}, priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }, UV_UDP_REUSEADDR: 4, dlopen: {} },
  };
  return os;
}
export const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31 };

export function makeProcess(B, tty, opts) {
  const info = B.call("info");
  const proc = new EventEmitter();
  proc.setMaxListeners(0);
  const t0 = performance.timeOrigin || Date.now();
  const hr = () => performance.now() * 1e6; // ns
  Object.assign(proc, {
    title: "node", version: NODE_VERSION, versions: { node: NODE_VERSION.slice(1), v8: "12.4.254.21-node.33", uv: "1.51.0", zlib: "1.3.1", brotli: "1.1.0", ares: "1.34.5", modules: "127", nghttp2: "1.64.0", napi: "10", llhttp: "9.3.0", openssl: "3.0.16", cldr: "47.0", icu: "77.1", tz: "2025b", unicode: "16.0", acorn: "8.15.0", undici: "6.21.2" },
    arch: "x64", platform: "linux", release: { name: "node", lts: "Jod", sourceUrl: "", headersUrl: "" },
    argv: info.argv.slice(), argv0: "node", execArgv: [], execPath: info.execPath, pid: info.pid, ppid: 0, exitCode: undefined,
    env: info.env, config: { variables: {}, target_defaults: {} }, features: { inspector: false, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: true, tls: true, cached_builtins: true, typescript: false },
    debugPort: 9229, allowedNodeEnvironmentFlags: new Set(), sourceMapsEnabled: false, noDeprecation: false, throwDeprecation: false, traceDeprecation: false,
    cwd: () => B.call("info").cwd,
    chdir: (d) => { try { B.call("chdir", d); } catch (e) { throw errnoError(e.__errno || "ENOENT", "chdir", d); } },
    umask: (m) => 0o22, getuid: () => info.uid, geteuid: () => info.uid, getgid: () => info.gid, getegid: () => info.gid, getgroups: () => [0],
    setuid() {}, setgid() {}, seteuid() {}, setegid() {}, initgroups() {}, setgroups() {},
    uptime: () => performance.now() / 1000,
    hrtime: Object.assign((prev) => { const ns = hr(); let s = Math.floor(ns / 1e9), n = Math.floor(ns % 1e9); if (prev) { s -= prev[0]; n -= prev[1]; if (n < 0) { s--; n += 1e9; } } return [s, n]; }, { bigint: () => BigInt(Math.floor(hr())) }),
    memoryUsage: Object.assign(() => ({ rss: 200e6, heapTotal: 150e6, heapUsed: 100e6, external: 10e6, arrayBuffers: 5e6 }), { rss: () => 200e6 }),
    cpuUsage: (prev) => { const u = Math.floor(performance.now() * 1000); return { user: u - (prev ? prev.user : 0), system: 0 }; },
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 200000, sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0, minorPageFault: 0, majorPageFault: 0, swappedOut: 0, fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0, signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 }),
    availableMemory: () => 2 * 1024 ** 3, constrainedMemory: () => 0,
    nextTick: (fn, ...args) => { queueMicrotask(() => fn(...args)); },
    emitWarning: (w, type, code) => { const msg = typeof w === "string" ? w : w && w.message; if (proc.listenerCount("warning")) { const e = w instanceof Error ? w : Object.assign(new Error(msg), { name: (typeof type === "object" ? type.type : type) || "Warning", code: typeof type === "object" ? type.code : code }); proc.emit("warning", e); } else if (!proc.noDeprecation || !/Deprecation/.test(String(type))) console.error(`(node:${info.pid}) ${(typeof type === "object" ? type.type : type) || "Warning"}: ${msg}`); },
    kill: (pid, sig) => { if (pid === info.pid) { proc.emit(typeof sig === "string" ? sig : "SIGTERM"); return true; } return B.call("procKill", pid, sig || "SIGTERM"); },
    abort: () => { throw new Error("process.abort()"); },
    exit: (code) => { if (code != null) proc.exitCode = code; const c = proc.exitCode || 0; if (!proc._exiting) { proc._exiting = true; proc.emit("exit", c); } if (opts && opts.onExit) opts.onExit(c); throw new ProcessExit(c); },
    reallyExit: (code) => { if (opts && opts.onExit) opts.onExit(code || 0); throw new ProcessExit(code || 0); },
    binding: (n) => { noteMissing("process.binding(" + n + ")", "call"); throw new Error("No such module: " + n); },
    _linkedBinding: (n) => { noteMissing("process._linkedBinding(" + n + ")", "call"); throw new Error("No such binding: " + n); },
    dlopen: () => { const e = new Error("dlopen is not supported in the browser runtime"); e.code = "ERR_DLOPEN_FAILED"; throw e; },
    getBuiltinModule: (id) => (opts && opts.getBuiltinModule ? opts.getBuiltinModule(id) : undefined),
    _getActiveHandles: () => [], _getActiveRequests: () => [], getActiveResourcesInfo: () => [],
    setUncaughtExceptionCaptureCallback: (fn) => { proc._uncaughtCapture = fn; }, hasUncaughtExceptionCaptureCallback: () => !!proc._uncaughtCapture,
    setSourceMapsEnabled() {}, ref() {}, unref() {}, loadEnvFile() {}, execve() { throw new Error("execve unsupported"); },
    report: { getReport: () => ({ header: { nodejsVersion: NODE_VERSION, glibcVersionRuntime: "2.39", osName: "Linux", arch: "x64" }, javascriptStack: {}, nativeStack: [], javascriptHeap: {}, resourceUsage: {}, libuv: [], workers: [], environmentVariables: info.env, userLimits: {}, sharedObjects: [] }), writeReport: () => "", directory: "", filename: "", compact: false, signal: "SIGUSR2", reportOnFatalError: false, reportOnSignal: false, reportOnUncaughtException: false, excludeNetwork: false },
    channel: undefined, connected: false, send: undefined, disconnect: undefined,
    stdout: null, stderr: null, stdin: null,
    finalization: { register() {}, unregister() {}, registerBeforeExit() {} },
    permission: { has: () => true },
    _exiting: false, _rawDebug: (...a) => console.error(...a), _tickCallback() {}, _events: undefined,
    openStdin: () => proc.stdin, assert: (c, m) => { if (!c) throw new Error(m || "assertion failed"); },
    mainModule: undefined,
  });
  proc.stdout = new tty.WriteStream(1); proc.stderr = new tty.WriteStream(2); proc.stdin = new tty.ReadStream(0);
  proc.stdout._isStdio = true; proc.stderr._isStdio = true;
  proc.stdout.destroySoon = proc.stdout.destroy; proc.stderr.destroySoon = proc.stderr.destroy;
  proc[Symbol.toStringTag] = "process";
  return proc;
}
export class ProcessExit extends Error { constructor(code) { super("process.exit(" + code + ")"); this.code = code; this.isProcessExit = true; } }
