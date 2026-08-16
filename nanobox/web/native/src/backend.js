// The syscall backend interface — the ONLY way the Node-compat shims touch files, the terminal,
// child processes and sockets. One object, RPC-shaped operations, so that a different backend can
// slot in without touching the shims:
//
//   backend #1 (this file, MemBackend): in-memory rootfs unpacked from the OCI image layout
//              (NanoboxFs tree from web/oci.js) + a writable overlay (the tree itself is mutable),
//              tty = the page's xterm (through the worker port), spawn/net = recorded failures.
//   backend #2 (the VM track): a guest-side `node` shim inside the emulated Linux guest that
//              executes the same operations for real (files, tty, child processes, sockets) —
//              JS keeps running on the host V8. It lives in another worker: SyncChannel (below)
//              turns its postMessage replies into the synchronous contract with Atomics.wait.
//
// Contract:
//   B.call(op, ...args)      synchronous — returns the result or throws {__errno, syscall, path}
//                            (rehydrated to a Node errno Error by the shim, see errors.js)
//   B.callAsync(op, ...args) Promise of the same (local backends: Promise.resolve(call()))
//   B.on(kind, fn)           events pushed by the backend: "tty" {data|resize|eof}, "proc"
//                            {pid, stream, data} | {pid, exit, signal}, "net" {id, data|end|error}
//
// Operations (paths are absolute-or-cwd-relative strings, bytes are Uint8Array; the shim does the
// Node-level API surface — encodings, options objects, callbacks, streams — on top of these):
//   info()                              {env, argv, execPath, cwd, uid, gid, hostname, pid}
//   chdir(path)
//   fs: stat(path, follow) fstat(fd) readdir(path) -> [{name,type}]  readlink(path) realpath(path)
//       access(path, mode) open(path, flags, mode) -> fd  close(fd)  read(fd, len, pos|null) -> bytes
//       write(fd, bytes, pos|null) -> n  readFile(pathOrFd) -> bytes  writeFile(path, bytes, flags, mode)
//       mkdir(path, recursive, mode) -> firstCreated|undefined  rmdir(path) unlink(path) rename(a, b)
//       symlink(target, path) link(a, b) chmod(path, mode) chown(path, uid, gid) utimes(path, atime, mtime)
//       truncate(pathOrFd, len) copyFile(a, b, flags) rm(path, recursive, force) mkdtemp(prefix) fsync(fd)
//   tty: ttySize() -> {cols, rows}  ttyWrite(fd, bytes)  ttySetRaw(bool)  isatty(fd)
//   proc: spawn({file, args, cwd, env, stdio}) -> {pid} | {error: code}   procInput(pid, bytes|null)
//         spawnSync(spec) -> {status, signal, stdout, stderr} | {error: code}
//         procKill(pid, signal)
//   net: netConnect({host, port, tls}) -> {id} | {error: code}   netWrite(id, bytes)  netEnd(id)
//
// Stat records: {dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs, mtimeMs,
// ctimeMs, birthtimeMs} — mode carries the S_IF* type bits.
import { ERRNO } from "./errors.js";

export const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFCHR = 0o020000, S_IFIFO = 0o010000, S_IFSOCK = 0o140000;
export const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 0o100, EXCL: 0o200, NOCTTY: 0o400, TRUNC: 0o1000, APPEND: 0o2000, NONBLOCK: 0o4000, DSYNC: 0o10000, DIRECTORY: 0o200000, NOFOLLOW: 0o400000, SYNC: 0o4010000, CLOEXEC: 0o2000000 };
export const F_OK = 0, X_OK = 1, W_OK = 2, R_OK = 4;

const enc = new TextEncoder(), dec = new TextDecoder();
const err = (code, syscall, path, dest) => { const e = { __errno: code, syscall, path, dest }; return e; };
const FIXED_MS = 1700000000000; // timestamps of image files (deterministic, same epoch web/wasifs.js uses)

// ---------------------------------------------------------------------------------------------------
// backend #1: in-memory tree (web/wasifs.js node shapes: {t:"d",e:Map} {t:"f",data} {t:"l",target}
// + our {t:"c",dev} char devices), everything writable in place.
export class MemBackend {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.cwd = (opts && opts.cwd) || "/";
    this.fds = new Map(); // fd -> {node, path, flags, pos, append}
    this.nextFd = 20;
    this.listeners = new Map();
    this.spawnLog = [];
    this.netLog = [];
    this.tty = { cols: 80, rows: 24, raw: false, write: (opts && opts.ttyWrite) || (() => {}) };
    this.stats = { calls: 0, ops: {} };
    let ino = 1000000;
    this.newIno = () => ino++;
    this._devices();
  }
  // --- contract ---
  call(op, ...args) {
    this.stats.calls++; this.stats.ops[op] = (this.stats.ops[op] || 0) + 1;
    const f = this[op];
    if (typeof f !== "function") throw err("ENOSYS", op);
    return f.apply(this, args);
  }
  callAsync(op, ...args) { try { return Promise.resolve(this.call(op, ...args)); } catch (e) { return Promise.reject(e); } }
  on(kind, fn) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(fn); return () => this.listeners.get(kind).delete(fn); }
  emit(kind, ev) { const s = this.listeners.get(kind); if (s) for (const f of s) { try { f(ev); } catch (e) { console.error("[backend] listener", e); } } }

  info() { return { env: this.opts.env || {}, argv: this.opts.argv || ["/usr/local/bin/node", "/usr/local/bin/claude"], execPath: "/usr/local/bin/node", cwd: this.cwd, uid: 0, gid: 0, hostname: "nanobox", pid: 1 }; }
  chdir(p) { const n = this._resolve(p, true); if (!n) throw err("ENOENT", "chdir", p); if (n.node.t !== "d") throw err("ENOTDIR", "chdir", p); this.cwd = n.path; }

  // --- tree helpers ---
  _devices() {
    const F = this._F();
    const dev = (path, name) => { const n = F.add(this.root, path, { data: new Uint8Array(0) }); n.t = "c"; n.dev = name; n.mode = 0o666; };
    if (!F.lookup(this.root, "dev")) F.add(this.root, "dev", { dir: true });
    for (const d of ["null", "zero", "urandom", "random", "tty", "stdin", "stdout", "stderr", "full"]) dev("dev/" + d, d);
    F.add(this.root, "dev/fd", { dir: true });
    F.add(this.root, "dev/shm", { dir: true });
    F.add(this.root, "dev/pts", { dir: true });
    F.add(this.root, "proc/self", { dir: true });
    for (const d of ["tmp", "root", "run", "var/tmp", "home"]) if (!F.lookup(this.root, d)) F.add(this.root, d, { dir: true });
  }
  _F() { return (typeof self !== "undefined" ? self : globalThis).NanoboxFs; }
  _abs(p) {
    if (p instanceof Uint8Array) p = dec.decode(p);
    if (typeof p !== "string") p = String(p);
    if (!p.startsWith("/")) p = this.cwd.replace(/\/$/, "") + "/" + p;
    const out = [];
    for (const part of p.split("/")) { if (!part || part === ".") continue; if (part === "..") out.pop(); else out.push(part); }
    return out;
  }
  // resolve a path to {node, path (canonical, symlink-free, absolute), parent, name}; follows
  // intermediate symlinks always, the last one when `follow`
  _resolve(p, follow, hops = 0) {
    if (hops > 40) throw err("ELOOP", "open", String(p));
    const parts = this._abs(p);
    let node = this.root, path = [];
    for (let i = 0; i < parts.length; i++) {
      if (node.t !== "d") return null;
      const name = parts[i];
      const child = node.e.get(name);
      if (!child) return { node: null, parent: node, name, path: "/" + [...path, name].join("/") };
      const last = i === parts.length - 1;
      if (child.t === "l" && (!last || follow)) {
        const target = child.target.startsWith("/") ? child.target : "/" + [...path, child.target].join("/");
        const rest = parts.slice(i + 1).join("/");
        return this._resolve(target + (rest ? "/" + rest : ""), follow, hops + 1);
      }
      path.push(name);
      if (last) return { node: child, parent: node, name, path: "/" + path.join("/") };
      node = child;
    }
    return { node, parent: null, name: "", path: "/" };
  }
  _need(p, follow, syscall) { const r = this._resolve(p, follow); if (!r || !r.node) throw err("ENOENT", syscall, String(p)); return r; }
  _data(n) { if (typeof n.data === "function") n.data = n.data(); return n.data; }
  _mode(n) { return n.mode != null ? n.mode : n.t === "d" ? 0o755 : n.t === "l" ? 0o777 : 0o644; }
  _statOf(n) {
    const type = n.t === "d" ? S_IFDIR : n.t === "l" ? S_IFLNK : n.t === "c" ? S_IFCHR : S_IFREG;
    const size = n.t === "d" ? 4096 : n.t === "l" ? enc.encode(n.target).length : n.t === "c" ? 0 : this._data(n).byteLength;
    const m = n.mtimeMs != null ? n.mtimeMs : FIXED_MS;
    return { dev: 2049, ino: n.ino || 0, mode: type | (this._mode(n) & 0o7777), nlink: n.t === "d" ? 2 : 1, uid: 0, gid: 0, rdev: 0, size, blksize: 4096, blocks: Math.ceil(size / 512), atimeMs: m, mtimeMs: m, ctimeMs: m, birthtimeMs: m };
  }
  _fd(fd, syscall) { const f = this.fds.get(fd); if (!f) throw err("EBADF", syscall); return f; }
  _setData(n, bytes) { n.data = bytes; n.mtimeMs = Date.now(); }
  _ensure(n, len) { // grow a file's storage to hold `len` bytes (over-allocated buffer, exact-length view)
    let d = this._data(n);
    if (d.byteLength >= len && d.byteOffset === 0 && d.buffer.byteLength >= len) { n.data = new Uint8Array(d.buffer, 0, len); return n.data; }
    if (d.byteOffset === 0 && d.buffer.byteLength >= len && !n.shared) { n.data = new Uint8Array(d.buffer, 0, len); return n.data; }
    const cap = Math.max(len, d.byteLength * 2, 4096);
    const nd = new Uint8Array(new ArrayBuffer(cap), 0, len);
    nd.set(d.subarray(0, Math.min(d.byteLength, len)));
    n.data = nd; n.shared = false;
    return nd;
  }

  // --- fs ops ---
  stat(p, follow = true) { const r = this._need(p, follow, follow ? "stat" : "lstat"); return this._statOf(r.node); }
  fstat(fd) { const f = this._fd(fd, "fstat"); if (f.tty) return { dev: 0, ino: 0, mode: S_IFCHR | 0o620, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 1024, blocks: 0, atimeMs: FIXED_MS, mtimeMs: FIXED_MS, ctimeMs: FIXED_MS, birthtimeMs: FIXED_MS }; return this._statOf(f.node); }
  readdir(p) {
    const r = this._need(p, true, "scandir");
    if (r.node.t !== "d") throw err("ENOTDIR", "scandir", String(p));
    return [...r.node.e.entries()].map(([name, n]) => ({ name, type: n.t === "d" ? "dir" : n.t === "l" ? "link" : n.t === "c" ? "char" : "file" }));
  }
  readlink(p) { const r = this._need(p, false, "readlink"); if (r.node.t !== "l") throw err("EINVAL", "readlink", String(p)); return r.node.target; }
  realpath(p) { const r = this._need(p, true, "realpath"); return r.path; }
  access(p, mode = 0) { const r = this._need(p, true, "access"); if ((mode & W_OK) && r.node.readonly) throw err("EACCES", "access", String(p)); return undefined; }
  open(p, flags = 0, mode = 0o666) {
    const follow = !(flags & O.NOFOLLOW);
    let r = this._resolve(p, follow);
    if (!r) throw err("ENOTDIR", "open", String(p));
    if (r.node && r.node.t === "l") throw err("ELOOP", "open", String(p));
    if (!r.node) {
      if (!(flags & O.CREAT)) throw err("ENOENT", "open", String(p));
      if (!r.parent) throw err("ENOENT", "open", String(p));
      const n = { t: "f", data: new Uint8Array(0), ino: this.newIno(), mode: mode & 0o7777, mtimeMs: Date.now() };
      r.parent.e.set(r.name, n); r = { node: n, path: r.path };
    } else if ((flags & O.CREAT) && (flags & O.EXCL)) throw err("EEXIST", "open", String(p));
    const n = r.node;
    if (n.t === "d" && (flags & 3) !== O.RDONLY) throw err("EISDIR", "open", String(p));
    if ((flags & O.DIRECTORY) && n.t !== "d") throw err("ENOTDIR", "open", String(p));
    if (n.t === "f" && (flags & O.TRUNC) && (flags & 3) !== O.RDONLY) this._setData(n, new Uint8Array(0));
    const fd = this.nextFd++;
    this.fds.set(fd, { node: n, path: r.path, flags, pos: 0, append: !!(flags & O.APPEND), tty: n.t === "c" && /^(tty|stdin|stdout|stderr)$/.test(n.dev) });
    return fd;
  }
  close(fd) { if (!this.fds.delete(fd)) throw err("EBADF", "close"); }
  read(fd, len, pos = null) {
    const f = this._fd(fd, "read");
    const n = f.node;
    if (n.t === "d") throw err("EISDIR", "read");
    if (n.t === "c") {
      if (n.dev === "zero" || n.dev === "full") return new Uint8Array(len);
      if (n.dev === "urandom" || n.dev === "random") { const b = new Uint8Array(len); for (let i = 0; i < len; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(len, i + 65536))); return b; }
      return new Uint8Array(0); // null, tty: EOF (tty input comes through events)
    }
    const d = this._data(n);
    const at = pos == null ? f.pos : pos;
    const out = d.slice(at, Math.min(d.byteLength, at + len));
    if (pos == null) f.pos += out.byteLength;
    return out;
  }
  write(fd, bytes, pos = null) {
    const f = this._fd(fd, "write");
    const n = f.node;
    if (n.t === "c") { if (f.tty || n.dev === "stdout" || n.dev === "stderr") this.ttyWrite(1, bytes); return bytes.byteLength; }
    if (n.t !== "f") throw err("EBADF", "write");
    let at = f.append ? this._data(n).byteLength : pos == null ? f.pos : pos;
    const d = this._ensure(n, Math.max(this._data(n).byteLength, at + bytes.byteLength));
    d.set(bytes, at); n.mtimeMs = Date.now();
    if (pos == null || f.append) f.pos = at + bytes.byteLength;
    return bytes.byteLength;
  }
  readFile(p) {
    if (typeof p === "number") { const f = this._fd(p, "read"); const d = this._data(f.node); const out = d.slice(f.pos); f.pos = d.byteLength; return out; }
    const r = this._need(p, true, "open");
    if (r.node.t === "d") throw err("EISDIR", "read");
    if (r.node.t === "c") return this.read(this._tmpfd(r.node), 65536);
    return this._data(r.node).slice();
  }
  _tmpfd(node) { const fd = this.nextFd++; this.fds.set(fd, { node, path: "", flags: 0, pos: 0 }); return fd; }
  writeFile(p, bytes, flags = O.WRONLY | O.CREAT | O.TRUNC, mode = 0o666) {
    if (typeof p === "number") { this.write(p, bytes); return; }
    const fd = this.open(p, flags, mode); try { this.write(fd, bytes); } finally { this.close(fd); }
  }
  mkdir(p, recursive = false, mode = 0o777) {
    const parts = this._abs(p);
    if (!recursive) {
      const r = this._resolve(p, true);
      if (!r) throw err("ENOTDIR", "mkdir", String(p));
      if (r.node) throw err("EEXIST", "mkdir", String(p));
      if (!r.parent) throw err("ENOENT", "mkdir", String(p));
      r.parent.e.set(r.name, { t: "d", e: new Map(), ino: this.newIno(), mode: mode & 0o7777, mtimeMs: Date.now() });
      return undefined;
    }
    let first;
    for (let i = 1; i <= parts.length; i++) {
      const sub = "/" + parts.slice(0, i).join("/");
      const r = this._resolve(sub, true);
      if (r && r.node) { if (r.node.t !== "d") throw err("ENOTDIR", "mkdir", String(p)); continue; }
      if (!r || !r.parent) throw err("ENOENT", "mkdir", String(p));
      r.parent.e.set(r.name, { t: "d", e: new Map(), ino: this.newIno(), mode: mode & 0o7777, mtimeMs: Date.now() });
      if (first === undefined) first = sub;
    }
    return first;
  }
  rmdir(p) { const r = this._need(p, false, "rmdir"); if (r.node.t !== "d") throw err("ENOTDIR", "rmdir", String(p)); if (r.node.e.size) throw err("ENOTEMPTY", "rmdir", String(p)); if (!r.parent) throw err("EBUSY", "rmdir", String(p)); r.parent.e.delete(r.name); }
  unlink(p) { const r = this._need(p, false, "unlink"); if (r.node.t === "d") throw err("EISDIR", "unlink", String(p)); r.parent.e.delete(r.name); }
  rename(a, b) {
    const ra = this._need(a, false, "rename");
    const rb = this._resolve(b, false);
    if (!rb || !rb.parent) throw err("ENOENT", "rename", String(a), String(b));
    if (rb.node && rb.node.t === "d" && rb.node.e.size) throw err("ENOTEMPTY", "rename", String(a), String(b));
    ra.parent.e.delete(ra.name); rb.parent.e.set(rb.name, ra.node);
  }
  symlink(target, p) { const r = this._resolve(p, false); if (!r || !r.parent) throw err("ENOENT", "symlink", target, String(p)); if (r.node) throw err("EEXIST", "symlink", target, String(p)); r.parent.e.set(r.name, { t: "l", target: String(target), ino: this.newIno() }); }
  link(a, b) { const ra = this._need(a, true, "link"); const rb = this._resolve(b, false); if (!rb || !rb.parent) throw err("ENOENT", "link", String(a), String(b)); if (rb.node) throw err("EEXIST", "link", String(a), String(b)); rb.parent.e.set(rb.name, ra.node); }
  chmod(p, mode) { const r = this._need(p, true, "chmod"); r.node.mode = mode & 0o7777; }
  chown() {}
  utimes(p, atime, mtime) { const r = this._need(p, true, "utime"); r.node.mtimeMs = mtime; }
  truncate(p, len = 0) {
    const n = typeof p === "number" ? this._fd(p, "ftruncate").node : this._need(p, true, "open").node;
    if (n.t !== "f") throw err("EISDIR", "truncate", String(p));
    const d = this._data(n);
    if (len <= d.byteLength) this._setData(n, d.slice(0, len)); else this._ensure(n, len);
  }
  copyFile(a, b, flags = 0) { const ra = this._need(a, true, "copyfile"); if (ra.node.t !== "f") throw err("EISDIR", "copyfile", String(a)); const rb = this._resolve(b, true); if (!rb || !rb.parent && !rb.node) throw err("ENOENT", "copyfile", String(a), String(b)); if (rb.node && (flags & 1)) throw err("EEXIST", "copyfile", String(a), String(b)); this.writeFile(b, this._data(ra.node).slice(), O.WRONLY | O.CREAT | O.TRUNC, this._mode(ra.node)); }
  rm(p, recursive = false, force = false) {
    const r = this._resolve(p, false);
    if (!r || !r.node) { if (force) return; throw err("ENOENT", "rm", String(p)); }
    if (r.node.t === "d") { if (!recursive) throw err("EISDIR", "rm", String(p)); if (!r.parent) throw err("EPERM", "rm", String(p)); }
    r.parent.e.delete(r.name);
  }
  mkdtemp(prefix) { const s = String(prefix) + Math.random().toString(36).slice(2, 8); this.mkdir(s, false, 0o700); return s; }
  fsync() {}
  fdatasync() {}

  // --- tty ---
  ttySize() { return { cols: this.tty.cols, rows: this.tty.rows }; }
  ttyWrite(fd, bytes) { this.tty.write(fd, bytes); return bytes.byteLength; }
  ttySetRaw(on) { this.tty.raw = !!on; return true; }
  isatty(fd) { return fd === 0 || fd === 1 || fd === 2; }
  // page -> backend
  ttyInput(bytes) { this.emit("tty", { data: bytes }); }
  ttyResize(cols, rows) { this.tty.cols = cols; this.tty.rows = rows; this.emit("tty", { resize: { cols, rows } }); }

  // --- processes (backend #1: nothing can run; recorded so backend #2 knows what to forward) ---
  spawn(spec) { this.spawnLog.push({ file: spec.file, args: spec.args, cwd: spec.cwd, t: Date.now() }); return { error: "ENOENT" }; }
  spawnSync(spec) { this.spawnLog.push({ file: spec.file, args: spec.args, cwd: spec.cwd, sync: true, t: Date.now() }); return { error: "ENOENT" }; }
  procInput() { throw err("ESRCH", "write"); }
  procKill() { return false; }

  // --- sockets (backend #1: HTTP goes through global fetch → the /net/fetch gateway; raw TCP/TLS refused) ---
  netConnect(spec) { this.netLog.push(spec); return { error: "ECONNREFUSED" }; }
  netWrite() { throw err("ENOTCONN", "write"); }
  netEnd() {}
}

// ---------------------------------------------------------------------------------------------------
// SyncChannel: the client half of a REMOTE backend. `port.postMessage({id, op, args})` goes to the
// responder (backend #2's worker); the reply is written into a SharedArrayBuffer and signalled with
// Atomics.notify, so a synchronous fs call (readFileSync…) blocks in Atomics.wait meanwhile.
// Reply layout in `sab`: Int32[0] = state (0 pending, 1 ready), Int32[1] = payload length,
// Int32[2] = 0 ok / 1 error, bytes from offset 16 = JSON (small) — payloads bigger than the buffer
// are sent in chunks: the responder writes a chunk, sets state=2, waits for state=3 (ack) …
// (`chunked` below). Events arrive as ordinary messages {event: kind, ...}.
export class SyncChannel {
  constructor(port, sab, opts) {
    this.port = port; this.i32 = new Int32Array(sab); this.u8 = new Uint8Array(sab); this.id = 1;
    this.listeners = new Map();
    this.opts = opts || {};
    port.onmessage = (m) => { const d = m.data; if (d && d.event) this.emit(d.event, d); };
  }
  on(kind, fn) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(fn); return () => this.listeners.get(kind).delete(fn); }
  emit(kind, ev) { const s = this.listeners.get(kind); if (s) for (const f of s) f(ev); }
  call(op, ...args) {
    const id = this.id++;
    Atomics.store(this.i32, 0, 0);
    this.port.postMessage({ id, op, args }, args.filter((a) => a instanceof Uint8Array).map((a) => a.buffer).filter((b) => !(b instanceof SharedArrayBuffer)));
    const parts = [];
    for (;;) {
      Atomics.wait(this.i32, 0, 0, this.opts.timeoutMs || 60000);
      const st = Atomics.load(this.i32, 0);
      if (st === 0) throw { __errno: "ETIMEDOUT", syscall: op };
      const len = this.i32[1], isErr = this.i32[2];
      parts.push(this.u8.slice(16, 16 + len));
      if (st === 2) { Atomics.store(this.i32, 0, 3); Atomics.notify(this.i32, 0); Atomics.wait(this.i32, 0, 3, this.opts.timeoutMs || 60000); continue; }
      const total = parts.reduce((n, p) => n + p.byteLength, 0), buf = new Uint8Array(total); let o = 0; for (const p of parts) { buf.set(p, o); o += p.byteLength; }
      const v = decodeReply(buf);
      if (isErr) throw v;
      return v;
    }
  }
  callAsync(op, ...args) { return new Promise((res, rej) => { try { res(this.call(op, ...args)); } catch (e) { rej(e); } }); }
}
// replies: tag byte 0 = JSON (utf-8), 1 = raw bytes (Uint8Array)
function decodeReply(buf) { if (!buf.byteLength) return undefined; if (buf[0] === 1) return buf.slice(1); return JSON.parse(dec.decode(buf.subarray(1))); }
export function encodeReply(v) { if (v instanceof Uint8Array) { const b = new Uint8Array(v.byteLength + 1); b[0] = 1; b.set(v, 1); return b; } const j = enc.encode(JSON.stringify(v === undefined ? null : v)); const b = new Uint8Array(j.byteLength + 1); b[0] = 0; b.set(j, 1); return b; }
// the responder half (runs where the real backend lives): serve(port, sab, backend)
export function serveSync(port, sab, backend) {
  const i32 = new Int32Array(sab), u8 = new Uint8Array(sab), room = u8.byteLength - 16;
  port.onmessage = async (m) => {
    const { id, op, args } = m.data; if (!id) return;
    let out, isErr = 0;
    try { out = encodeReply(await backend.callAsync(op, ...args)); } catch (e) { isErr = 1; out = encodeReply(e && e.__errno ? e : { __errno: "EIO", syscall: op, message: String(e && e.message || e) }); }
    let off = 0;
    for (;;) {
      const n = Math.min(room, out.byteLength - off);
      u8.set(out.subarray(off, off + n), 16); i32[1] = n; i32[2] = isErr; off += n;
      const last = off >= out.byteLength;
      Atomics.store(i32, 0, last ? 1 : 2); Atomics.notify(i32, 0);
      if (last) break;
      while (Atomics.load(i32, 0) !== 3) await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { emit: (kind, ev) => port.postMessage(Object.assign({ event: kind }, ev)) };
}
