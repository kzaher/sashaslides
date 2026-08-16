// Backend #2: the syscall-backend contract (backend.js) on top of the VM track's guest-side node
// shim client (web/native/guest.js `NanoboxGuest`, wire protocol web/native/proto.js). Files, the
// tty and child processes are executed INSIDE the emulated Linux guest by `nbnode`
// (guest/nbnode/nbnode.c); the JavaScript stays on the host V8. `g.sync.*` blocks this worker with
// Atomics.wait on the guest->host ring until the reply arrives (that is why the layer runs in its
// own worker), the async twins `g.*` serve the promise/callback APIs.
//
//   const gb = new GuestBackend({ g, image })   g = NanoboxGuest.connect({ringSab, inSab}) after HELLO;
//                                               image = MemBackend over the unpacked OCI rootfs (fast path)
//
// Fast path (docs/system-node.md): the guest's rootfs IS the OCI image the runtime worker already
// holds in memory, so reads of image paths never cross the channel (~8–20 MB/s) — unless this layer
// wrote/removed/renamed under that path (then the guest is authoritative), or the path is under
// /dev /proc /sys /tmp /run /root/.claude* etc. (guest-only by nature). Everything else → guest.
import { S_IFDIR } from "./backend.js";

const err = (code, syscall, path) => ({ __errno: code, syscall, path });
const DT = { 1: "fifo", 2: "char", 4: "dir", 6: "block", 8: "file", 10: "link", 12: "socket" };
const SIG = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15, SIGCHLD: 17, SIGWINCH: 28 };
const SIGNAME = Object.fromEntries(Object.entries(SIG).map(([k, v]) => [v, k]));
const GUEST_ONLY = /^\/(dev|proc|sys|tmp|run|var\/tmp|var\/run|root|home)(\/|$)/;
const statOf = (s) => ({ dev: Number(s.dev), ino: Number(s.ino), mode: Number(s.mode), nlink: Number(s.nlink), uid: Number(s.uid), gid: Number(s.gid), rdev: Number(s.rdev), size: Number(s.size), blksize: Number(s.blksize), blocks: Number(s.blocks), atimeMs: Number(s.atimeNs) / 1e6, mtimeMs: Number(s.mtimeNs) / 1e6, ctimeMs: Number(s.ctimeNs) / 1e6, birthtimeMs: Number(s.ctimeNs) / 1e6 });
const dirents = (l) => l.map((e) => ({ name: e.name, type: DT[e.type] || "file" }));
const cat = (a) => { const n = a.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n); let k = 0; for (const c of a) { o.set(c, k); k += c.length; } return o; };
const envList = (env) => Object.entries(env || {}).map(([k, v]) => k + "=" + v);
const toErr = (e, op, path) => (e && e.code ? err(e.code, op, path) : e && e.__errno ? e : err("EIO", op, path));

export class GuestBackend {
  constructor(cfg) {
    this.g = cfg.g; this.image = cfg.image || null;
    this.inCtl = cfg.inSab ? new Int32Array(cfg.inSab, 0, 3) : null; // guest->host ring control (to wait for events)
    this.listeners = new Map();
    this.stats = { calls: 0, ops: {}, guest: 0, image: 0 };
    this.dirty = new Set();          // paths (canonical strings) this layer wrote/removed/renamed: guest is authoritative below them
    this.fdOwner = new Map();        // fd -> "image" | "guest"
    this.cid = 1;
    this.tty = { cols: (cfg.g.hello && cfg.g.hello.cols) || 80, rows: (cfg.g.hello && cfg.g.hello.rows) || 24 };
    this.cwd = (cfg.g.hello && cfg.g.hello.cwd) || cfg.cwd || "/";
    const g = this.g;
    g.onStdin = (u8) => this.emit("tty", u8.length ? { data: u8 } : { eof: true });
    g.onResize = (cols, rows) => { this.tty.cols = cols; this.tty.rows = rows; this.emit("tty", { resize: { cols, rows } }); };
    g.onChildOut = (cid, fd, u8) => { if (u8.length) this.emit("proc", { pid: cid, stream: fd === 2 ? "stderr" : "stdout", data: u8 }); };
    g.onChildExit = (cid, code, sig) => this.emit("proc", { pid: cid, exit: sig ? null : code, signal: sig ? SIGNAME[sig] || String(sig) : null });
    g.onSignal = (s) => this.emit("signal", { signal: SIGNAME[s] || s });
  }
  on(kind, fn) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(fn); return () => this.listeners.get(kind).delete(fn); }
  emit(kind, ev) { const s = this.listeners.get(kind); if (s) for (const f of s) { try { f(ev); } catch (e) { console.error("[guest-backend] listener", e); } } }
  info() { const h = this.g.hello || {}; const env = {}; for (const kv of h.env || []) { const i = kv.indexOf("="); const k = kv.slice(0, i); if (!(k in env)) env[k] = kv.slice(i + 1); } return { env, argv: h.argv || [], execPath: (h.argv && h.argv[0]) || "/usr/local/bin/node", cwd: this.cwd, uid: 0, gid: 0, hostname: "nanobox", pid: h.pid || 1 }; }

  // ---- routing ----
  _abs(p) { if (typeof p !== "string") return null; if (!p.startsWith("/")) p = this.cwd.replace(/\/$/, "") + "/" + p; const out = []; for (const part of p.split("/")) { if (!part || part === ".") continue; if (part === "..") out.pop(); else out.push(part); } return "/" + out.join("/"); }
  _isDirty(abs) { if (this.dirty.has(abs)) return true; for (const d of this.dirty) if (d.startsWith(abs + "/") || abs.startsWith(d + "/")) return true; return false; }
  _markDirty(p) { const a = this._abs(p); if (a) this.dirty.add(a); }
  _imageHas(abs, follow) { try { const r = this.image._resolve(abs, follow); return !!(r && r.node); } catch { return false; } }
  // true when `op` can be answered from the in-memory image tree
  _viaImage(op, args) {
    if (!this.image) return false;
    switch (op) {
      case "stat": case "readFile": case "realpath": case "access": case "readlink": case "readdir": {
        const abs = this._abs(args[0]); if (!abs || GUEST_ONLY.test(abs) || this._isDirty(abs)) return false;
        return this._imageHas(abs, op !== "readlink" && !(op === "stat" && args[1] === false));
      }
      case "open": { const abs = this._abs(args[0]); const fl = args[1] | 0; if (!abs || (fl & 3) !== 0 || (fl & 0o100) || GUEST_ONLY.test(abs) || this._isDirty(abs)) return false; return this._imageHas(abs, true); }
      case "read": case "fstat": case "close": return this.fdOwner.get(args[0]) === "image";
      default: return false;
    }
  }
  _image(op, args) {
    this.stats.image++;
    const v = this.image.call(op, ...args);
    if (op === "open") this.fdOwner.set(v, "image"); else if (op === "close") this.fdOwner.delete(args[0]);
    return v;
  }
  _account(op) { this.stats.calls++; this.stats.ops[op] = (this.stats.ops[op] || 0) + 1; }

  call(op, ...args) {
    this._account(op);
    if (this._viaImage(op, args)) return this._image(op, args);
    this.stats.guest++;
    const f = SYNC[op];
    if (!f) throw err("ENOSYS", op);
    try { return f.call(this, ...args); } catch (e) { throw toErr(e, op, typeof args[0] === "string" ? args[0] : undefined); }
  }
  callAsync(op, ...args) {
    this._account(op);
    if (this._viaImage(op, args)) { try { return Promise.resolve(this._image(op, args)); } catch (e) { return Promise.reject(e); } }
    this.stats.guest++;
    const f = ASYNC[op] || (SYNC[op] && ((...a) => Promise.resolve().then(() => SYNC[op].call(this, ...a))));
    if (!f) return Promise.reject(err("ENOSYS", op));
    return f.call(this, ...args).catch((e) => { throw toErr(e, op, typeof args[0] === "string" ? args[0] : undefined); });
  }
}

// synchronous ops (g.sync.*)
const SYNC = {
  info() { return this.info(); },
  chdir(p) { const a = this._abs(p); const st = statOf(this.g.sync.stat(a)); if ((st.mode & 0o170000) !== S_IFDIR) throw err("ENOTDIR", "chdir", p); this.cwd = a; },
  stat(p, follow = true) { return statOf(follow ? this.g.sync.stat(p) : this.g.sync.lstat(p)); },
  fstat(fd) { return statOf(this.g.sync.fstat(fd)); },
  readdir(p) { return dirents(this.g.sync.readdir(p)); },
  readlink(p) { return this.g.sync.readlink(p); },
  realpath(p) { return this.g.sync.realpath(p); },
  access(p, mode) { this.g.sync.access(p, mode | 0); },
  open(p, flags, mode) { if (((flags | 0) & 3) !== 0 || ((flags | 0) & 0o100)) this._markDirty(p); const fd = this.g.sync.open(p, flags | 0, mode == null ? 0o666 : mode); this.fdOwner.set(fd, "guest"); return fd; },
  close(fd) { this.fdOwner.delete(fd); this.g.sync.close(fd); },
  read(fd, len, pos) { return this.g.sync.read(fd, len, pos == null ? -1 : pos); },
  write(fd, bytes, pos) { return this.g.sync.write(fd, bytes, pos == null ? -1 : pos); },
  readFile(p) { if (typeof p === "number") { const parts = []; for (;;) { const b = this.g.sync.read(p, 1 << 20, -1); if (!b.length) break; parts.push(b); } return cat(parts); } return this.g.sync.readFile(p); },
  writeFile(p, bytes, flags = 0o1101, mode = 0o666) { if (typeof p === "number") { this.g.sync.write(p, bytes, -1); return; } this._markDirty(p); const fd = this.g.sync.open(p, flags, mode); try { this.g.sync.write(fd, bytes, -1); } finally { this.g.sync.close(fd); } },
  mkdir(p, recursive, mode = 0o777) { this._markDirty(p); if (!recursive) { this.g.sync.mkdir(p, mode); return undefined; } let first, cur = ""; for (const part of this._abs(p).split("/").filter(Boolean)) { cur += "/" + part; try { this.g.sync.mkdir(cur, mode); if (first === undefined) first = cur; } catch (e) { if (e.code !== "EEXIST") throw e; } } return first; },
  rmdir(p) { this._markDirty(p); this.g.sync.rmdir(p); },
  unlink(p) { this._markDirty(p); this.g.sync.unlink(p); },
  rename(a, b) { this._markDirty(a); this._markDirty(b); this.g.sync.rename(a, b); },
  symlink(t, p) { this._markDirty(p); this.g.sync.symlink(t, p); },
  link(a, b) { this._markDirty(b); this.g.sync.link(a, b); },
  chmod(p, m) { this._markDirty(p); this.g.sync.chmod(p, m); },
  chown(p, u, g) { this.g.sync.chown(p, u, g); },
  utimes(p, a, m) { this._markDirty(p); this.g.sync.utimes(p, BigInt(Math.round(a * 1e6)), BigInt(Math.round(m * 1e6))); },
  truncate(p, len = 0) { if (typeof p === "number") this.g.sync.ftruncate(p, len); else { this._markDirty(p); this.g.sync.truncate(p, len); } },
  copyFile(a, b, flags = 0) { const data = this.call("readFile", a); this.call("writeFile", b, data, (flags & 1) ? 0o1301 : 0o1101); },
  rm(p, recursive, force) { this._markDirty(p); try { const st = statOf(this.g.sync.lstat(p)); if ((st.mode & 0o170000) === S_IFDIR) { if (!recursive) throw err("EISDIR", "rm", p); for (const e of this.g.sync.readdir(p)) SYNC.rm.call(this, p.replace(/\/$/, "") + "/" + e.name, true, force); this.g.sync.rmdir(p); } else this.g.sync.unlink(p); } catch (e) { if (force && e && (e.code === "ENOENT" || e.__errno === "ENOENT")) return; throw e; } },
  mkdtemp(prefix) { const p = prefix + Math.random().toString(36).slice(2, 8); this._markDirty(p); this.g.sync.mkdir(p, 0o700); return p; },
  fsync(fd) { this.g.sync.fsync(fd); },
  fdatasync(fd) { this.g.sync.fsync(fd); },
  ttySize() { return { cols: this.tty.cols, rows: this.tty.rows }; },
  ttyWrite(fd, bytes) { (fd === 2 ? this.g.stderr : this.g.stdout)(bytes); return bytes.byteLength; },
  ttySetRaw(on) { this.g.ttyRaw(!!on); return true; },
  isatty(fd) { const h = this.g.hello; return h ? !!(h.isatty & (1 << fd)) : fd < 3; },
  spawn(spec) { const cid = this.cid++; try { this.g.sync.spawn(cid, [spec.file, ...(spec.args || [])], envList(spec.env), spec.cwd || this.cwd, 1); return { pid: cid }; } catch (e) { return { error: e.code || "ENOENT" }; } },
  spawnSync(spec) {
    // spawn, then keep draining the ring (events are dispatched by g.callSync's loop / g.drain) until CHILD_EXIT
    const cid = this.cid++;
    try { this.g.sync.spawn(cid, [spec.file, ...(spec.args || [])], envList(spec.env), spec.cwd || this.cwd, 1); } catch (e) { return { error: e.code || "ENOENT" }; }
    const out = [], errs = []; let done = null;
    const off = this.on("proc", (ev) => { if (ev.pid !== cid) return; if (ev.stream) (ev.stream === "stderr" ? errs : out).push(ev.data); else if (ev.exit !== undefined) done = ev; });
    const deadline = Date.now() + (spec.timeout || 60000);
    try {
      while (!done) {
        if (this.g.drain) this.g.drain();
        if (done) break;
        if (Date.now() > deadline) { this.g.kill(cid, 9); return { error: "ETIMEDOUT" }; }
        if (this.inCtl) { const tail = Atomics.load(this.inCtl, 1); if (tail === Atomics.load(this.inCtl, 0)) Atomics.wait(this.inCtl, 1, tail, 50); }
        else this.g.sync.getpid(); // no ring handle: a round trip as the wait, events arrive in between
      }
    } finally { off(); }
    return { pid: cid, status: done.exit, signal: done.signal, stdout: cat(out), stderr: cat(errs) };
  },
  procInput(cid, bytes) { this.g.childStdin(cid, bytes || new Uint8Array(0)); },
  procKill(cid, sig) { this.g.kill(cid, typeof sig === "string" ? (SIG[sig] || 15) : sig | 0); return true; },
  netConnect() { return { error: "ECONNREFUSED" }; },
  netWrite() { throw err("ENOTCONN", "write"); },
  netEnd() {},
  exit(code) { this.g.exit(code | 0); },
};
// async twins (g.*) where a promise API asks — anything without one falls back to the sync op
const ASYNC = {
  async stat(p, follow = true) { return statOf(await (follow ? this.g.stat(p) : this.g.lstat(p))); },
  async fstat(fd) { return statOf(await this.g.fstat(fd)); },
  async readdir(p) { return dirents(await this.g.readdir(p)); },
  async readlink(p) { return this.g.readlink(p); },
  async realpath(p) { return this.g.realpath(p); },
  async access(p, mode) { await this.g.access(p, mode | 0); },
  async open(p, flags, mode) { if (((flags | 0) & 3) !== 0 || ((flags | 0) & 0o100)) this._markDirty(p); const fd = await this.g.open(p, flags | 0, mode == null ? 0o666 : mode); this.fdOwner.set(fd, "guest"); return fd; },
  async close(fd) { this.fdOwner.delete(fd); await this.g.close(fd); },
  async read(fd, len, pos) { return this.g.read(fd, len, pos == null ? -1 : pos); },
  async write(fd, bytes, pos) { return this.g.write(fd, bytes, pos == null ? -1 : pos); },
  async readFile(p) { if (typeof p === "number") { const parts = []; for (;;) { const b = await this.g.read(p, 1 << 20, -1); if (!b.length) break; parts.push(b); } return cat(parts); } return this.g.readFile(p); },
  async writeFile(p, bytes, flags = 0o1101, mode = 0o666) { if (typeof p === "number") { await this.g.write(p, bytes, -1); return; } this._markDirty(p); const fd = await this.g.open(p, flags, mode); try { await this.g.write(fd, bytes, -1); } finally { await this.g.close(fd); } },
  async unlink(p) { this._markDirty(p); await this.g.unlink(p); },
  async rename(a, b) { this._markDirty(a); this._markDirty(b); await this.g.rename(a, b); },
  async spawn(spec) { const cid = this.cid++; try { await this.g.spawn(cid, [spec.file, ...(spec.args || [])], envList(spec.env), spec.cwd || this.cwd, 1); return { pid: cid }; } catch (e) { return { error: e.code || "ENOENT" }; } },
};
