// Backend #2 adapter: the syscall backend contract (backend.js) on top of the VM track's guest-side
// node shim client (web/native/guest.js `NanoboxGuest`, wire protocol web/native/proto.js): files,
// tty and child processes are executed INSIDE the emulated Linux guest, JS stays on the host V8.
//
//   const gb = new GuestBackend({ transport | port+ringSab, rxRing?, image?: MemBackend, env, argv, cwd })
//   gb.callAsync(op, ...args)   every op of the contract, mapped onto guest.js calls (always available)
//   gb.call(op, ...args)        synchronous — needs `rxRing`: a NanoboxHcRing SAB the VM worker fills
//                              with the guest->host bytes (Atomics.notify on the tail). Without it a
//                              sync call throws ENOSYS: readFileSync & co. cannot block on postMessage.
//   gb.on("tty"|"proc", fn)     STDIN/RESIZE/CHILD_OUT/CHILD_EXIT events, translated
//
// Routing (docs/system-node.md): image files already sit in host memory (the unpacked OCI rootfs),
// so read-only ops on paths that exist in `image` (a MemBackend over that tree) are answered there
// and never cross the channel; writes and everything else go to the guest.
import { S_IFDIR, S_IFLNK, S_IFCHR, S_IFIFO, S_IFSOCK } from "./backend.js";

const enc = new TextEncoder();
const err = (code, syscall, path) => ({ __errno: code, syscall, path });
const DT = { 1: "fifo", 2: "char", 4: "dir", 6: "block", 8: "file", 10: "link", 12: "socket" };
const READ_OPS = new Set(["stat", "readdir", "readlink", "realpath", "access", "readFile"]);

export class GuestBackend {
  constructor(cfg) {
    const g0 = (typeof self !== "undefined" ? self : globalThis);
    const P = g0.NanoboxProto, Ring = g0.NanoboxHcRing, Guest = g0.NanoboxGuest;
    if (!P || !Guest) throw new Error("GuestBackend needs proto.js + guest.js (importScripts them first)");
    this.P = P; this.cfg = cfg || {};
    this.image = cfg.image || null;
    this.listeners = new Map();
    this.stats = { calls: 0, ops: {}, sync: 0, guest: 0, image: 0 };
    this.tty = { cols: 80, rows: 24 };
    this.fdOwner = new Map(); // fd -> "image" | "guest"  (image fds come from the MemBackend, guest fds from nbnode)
    this.cid = 1;
    // transport: we own it, so a synchronous receive path (rxRing) can be driven from call()
    let lastSentId = 0;
    const tx = cfg.ringSab ? Ring.writer(cfg.ringSab) : null;
    const transport = { send: (u8) => { lastSentId = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(5, true); if (tx) tx.write(u8); else cfg.transport.send(u8); }, onData: null };
    this._lastSentId = () => lastSentId;
    this.g = Guest.connect({ transport });
    const theirFeed = (b) => transport.onData(b);
    // async receive path: guest->host bytes as messages from the VM worker
    if (cfg.port) { cfg.port.onmessage = (m) => { const d = m.data; if (d && d.type === "hc") theirFeed(new Uint8Array(d.data)); }; if (cfg.port.start) cfg.port.start(); }
    else if (cfg.transport && cfg.transport.onData === undefined) cfg.transport.onData = theirFeed;
    // sync receive path (optional): the same bytes through a SAB ring we can Atomics.wait on
    this.rx = cfg.rxRing ? { ctl: new Int32Array(cfg.rxRing, 0, 3), reader: Ring.reader(cfg.rxRing) } : null;
    this._theirFeed = theirFeed;
    // events
    this.g.onHello = (h) => { this.hello = h; this.tty.cols = h.cols; this.tty.rows = h.rows; this.emit("hello", h); };
    this.g.onStdin = (u8) => this.emit("tty", u8.length ? { data: u8 } : { eof: true });
    this.g.onResize = (cols, rows) => { this.tty.cols = cols; this.tty.rows = rows; this.emit("tty", { resize: { cols, rows } }); };
    this.g.onChildOut = (cid, fd, u8) => this.emit("proc", { pid: cid, stream: fd === 2 ? "stderr" : "stdout", data: u8 });
    this.g.onChildExit = (cid, code, sig) => this.emit("proc", { pid: cid, exit: code, signal: sig || null });
    this.g.onSignal = (s) => this.emit("signal", { signal: s });
  }
  on(kind, fn) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(fn); return () => this.listeners.get(kind).delete(fn); }
  emit(kind, ev) { const s = this.listeners.get(kind); if (s) for (const f of s) { try { f(ev); } catch (e) { console.error("[guest-backend] listener", e); } } }

  // ---- routing ----
  _viaImage(op, args) {
    if (!this.image) return false;
    if (READ_OPS.has(op) && typeof args[0] === "string") { try { this.image._need(args[0], op !== "readlink"); return true; } catch { return false; } }
    if ((op === "read" || op === "fstat" || op === "close") && this.fdOwner.get(args[0]) === "image") return true;
    if (op === "open" && typeof args[0] === "string" && ((args[1] | 0) & 3) === 0 && !((args[1] | 0) & 0o100)) { try { this.image._need(args[0], true); return true; } catch { return false; } }
    return false;
  }
  callAsync(op, ...args) {
    this.stats.calls++; this.stats.ops[op] = (this.stats.ops[op] || 0) + 1;
    if (this._viaImage(op, args)) { this.stats.image++; try { const v = this.image.call(op, ...args); if (op === "open") this.fdOwner.set(v, "image"); if (op === "close") this.fdOwner.delete(args[0]); return Promise.resolve(v); } catch (e) { return Promise.reject(e); } }
    this.stats.guest++;
    const f = this._ops[op];
    if (!f) return Promise.reject(err("ENOSYS", op));
    return f.call(this, ...args).catch((e) => { throw e && e.code ? err(e.code, op, typeof args[0] === "string" ? args[0] : undefined) : e; });
  }
  call(op, ...args) {
    if (this._viaImage(op, args) || !/^(stat|fstat|readdir|readlink|realpath|access|open|close|read|write|readFile|writeFile|mkdir|rmdir|unlink|rename|symlink|link|chmod|chown|utimes|truncate|copyFile|rm|mkdtemp|fsync|ttySize|spawnSync|info|chdir)$/.test(op)) {
      // pure host-side ops (image reads, tty writes, info) never block
      if (!this.rx || this._viaImage(op, args) || /^(info|chdir|ttyWrite|ttySetRaw|isatty|procKill|procInput|netConnect|netWrite|netEnd)$/.test(op)) return this._syncLocal(op, args);
    }
    if (!this.rx) throw err("ENOSYS", op + " (synchronous call needs the rxRing SAB; only callAsync is available on this transport)");
    return this._syncGuest(op, args);
  }
  _syncLocal(op, args) {
    this.stats.calls++; this.stats.ops[op] = (this.stats.ops[op] || 0) + 1;
    if (this._viaImage(op, args)) { this.stats.image++; const v = this.image.call(op, ...args); if (op === "open") this.fdOwner.set(v, "image"); if (op === "close") this.fdOwner.delete(args[0]); return v; }
    switch (op) {
      case "info": return this.info();
      case "chdir": this.cwd = args[0]; return undefined;
      case "ttyWrite": this._ops.ttyWrite.call(this, ...args); return args[1].byteLength;
      case "ttySetRaw": this.g.ttyRaw(!!args[0]); return true;
      case "isatty": return this.hello ? !!(this.hello.isatty & (1 << args[0])) : args[0] < 3;
      case "ttySize": return { cols: this.tty.cols, rows: this.tty.rows };
      case "procKill": this.g.kill(args[0], typeof args[1] === "string" ? (SIG[args[1]] || 15) : args[1] | 0); return true;
      case "procInput": this.g.childStdin(args[0], args[1] || new Uint8Array(0)); return undefined;
      case "netConnect": return { error: "ECONNREFUSED" };
      case "netWrite": throw err("ENOTCONN", "write");
      case "netEnd": return undefined;
    }
    throw err("ENOSYS", op);
  }
  // Synchronous request: send through guest.js (its promise resolves later, harmlessly), then pump the
  // rx ring with Atomics.wait until the REPLY frame with our id arrives; parse that payload here.
  _syncGuest(op, args) {
    this.stats.sync++;
    if (op === "spawnSync") return this._spawnSync(args[0]);
    // one guest request, answered synchronously
    const one = (fnName, fargs, parse) => {
      const p = this.g[fnName](...fargs); p.catch(() => {});
      const reply = this._pumpUntilReply(this._lastSentId());
      if (reply.errno) throw err(ERRNO[reply.errno] || "EIO", op, typeof args[0] === "string" ? args[0] : undefined);
      return parse ? parse(reply.r) : undefined;
    };
    // composite ops
    switch (op) {
      case "readFile": { const [p] = args; const fd = typeof p === "number" ? p : one("open", [p, 0, 0], (r) => r.i32()); const parts = []; try { for (;;) { const b = one("read", [fd, 1 << 20, -1], (r) => r.bin()); if (!b.length) break; parts.push(b); } } finally { if (typeof p !== "number") one("close", [fd]); } return cat(parts); }
      case "writeFile": { const [p, bytes, flags = 0o1101, mode = 0o666] = args; if (typeof p === "number") { one("write", [p, bytes, -1], (r) => r.i32()); return; } const fd = one("open", [p, flags, mode], (r) => r.i32()); try { one("write", [fd, bytes, -1], (r) => r.i32()); } finally { one("close", [fd]); } return; }
      case "mkdir": { const [p, recursive, mode = 0o777] = args; if (!recursive) { one("mkdir", [p, mode]); return undefined; } let first, cur = ""; for (const part of p.split("/").filter(Boolean)) { cur += "/" + part; try { one("mkdir", [cur, mode]); if (first === undefined) first = cur; } catch (e) { if (e.__errno !== "EEXIST") throw e; } } return first; }
      case "copyFile": { const data = this._syncGuest("readFile", [args[0]]); return this._syncGuest("writeFile", [args[1], data, (args[2] & 1) ? 0o1301 : 0o1101]); }
      case "rm": { const [p, recursive, force] = args; try { const st = one("lstat", [p], rStat(this.P)); if ((st.mode & 0o170000) === S_IFDIR) { if (!recursive) throw err("EISDIR", "rm", p); for (const e of one("readdir", [p], (r) => dirents(r.list((x) => ({ name: x.str(), type: x.u8() }))))) this._syncGuest("rm", [p.replace(/\/$/, "") + "/" + e.name, true, force]); one("rmdir", [p]); } else one("unlink", [p]); } catch (e) { if (force && e && e.__errno === "ENOENT") return; throw e; } return; }
      case "mkdtemp": { const p = args[0] + Math.random().toString(36).slice(2, 8); one("mkdir", [p, 0o700]); return p; }
    }
    const send = SYNC_SEND[op]; if (!send) throw err("ENOSYS", op + " (no synchronous mapping)");
    const [fnName, fargs, parse, transform] = send.call(this, ...args);
    const v = one(fnName, fargs, parse);
    return transform ? transform(v) : v;
  }
  _pumpUntilReply(id) {
    const P = this.P, OP = P.OP, ctl = this.rx.ctl, reader = this.rx.reader;
    let found = null;
    const framer = P.framer((op, fid, r) => { if (op === OP.REPLY && fid === id) { const errno = r.i32(); found = { errno, r }; } });
    const deadline = Date.now() + (this.cfg.timeoutMs || 60000);
    while (!found) {
      const tail = Atomics.load(ctl, 1), head = Atomics.load(ctl, 0);
      if (tail === head) { if (Date.now() > deadline) throw err("ETIMEDOUT", "guest"); Atomics.wait(ctl, 1, tail, 1000); continue; }
      const b = reader.read(1 << 20); if (!b) continue;
      framer(b);            // us: look for our reply, parsed synchronously
      this._theirFeed(b);   // guest.js: resolves its promise (microtask, later) and delivers events (STDIN, CHILD_OUT…)
    }
    return found;
  }
  _spawnSync(spec) {
    const cid = this.cid++;
    const p = this.g.spawn(cid, [spec.file, ...(spec.args || [])], Object.entries(spec.env || {}).map(([k, v]) => k + "=" + v), spec.cwd || "/", 1); p.catch(() => {});
    const id = this._lastSentId();
    const first = this._pumpUntilReply(id);
    if (first.errno) return { error: ERRNO[first.errno] || "ENOENT" };
    const pid = first.r.i32();
    // keep pumping until CHILD_EXIT for cid; collect its output
    const P = this.P, OP = P.OP, out = [], errs = []; let done = null;
    const framer = P.framer((op, fid, r) => { if (op === OP.CHILD_OUT) { const c = r.u32(), fd = r.i32(), b = r.bin(); if (c === cid) (fd === 2 ? errs : out).push(b); } else if (op === OP.CHILD_EXIT) { const c = r.u32(), code = r.i32(), sig = r.i32(); if (c === cid) done = { code, sig }; } });
    const ctl = this.rx.ctl, reader = this.rx.reader, deadline = Date.now() + (this.cfg.timeoutMs || 60000);
    while (!done) { const tail = Atomics.load(ctl, 1), head = Atomics.load(ctl, 0); if (tail === head) { if (Date.now() > deadline) throw err("ETIMEDOUT", "spawnSync"); Atomics.wait(ctl, 1, tail, 1000); continue; } const b = reader.read(1 << 20); if (!b) continue; framer(b); }
    const cat = (a) => { const n = a.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n); let k = 0; for (const c of a) { o.set(c, k); k += c.length; } return o; };
    return { pid, status: done.sig ? null : done.code, signal: done.sig ? SIGNAME[done.sig] || String(done.sig) : null, stdout: cat(out), stderr: cat(errs) };
  }
  info() { const h = this.hello || {}; const env = {}; for (const kv of h.env || []) { const i = kv.indexOf("="); const k = kv.slice(0, i); if (!(k in env)) env[k] = kv.slice(i + 1); } return { env: Object.keys(env).length ? env : this.cfg.env || {}, argv: (h.argv && h.argv.length ? ["/usr/local/bin/node", ...h.argv.slice(1)] : this.cfg.argv) || ["/usr/local/bin/node"], execPath: "/usr/local/bin/node", cwd: this.cwd || h.cwd || this.cfg.cwd || "/", uid: 0, gid: 0, hostname: "nanobox", pid: h.pid || 1 }; }
}
const ERRNO = { 1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 24: "EMFILE", 27: "EFBIG", 28: "ENOSPC", 29: "ESPIPE", 30: "EROFS", 32: "EPIPE", 36: "ENAMETOOLONG", 38: "ENOSYS", 39: "ENOTEMPTY", 40: "ELOOP", 95: "ENOTSUP" };
const SIG = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGUSR1: 10, SIGUSR2: 12 };
const SIGNAME = Object.fromEntries(Object.entries(SIG).map(([k, v]) => [v, k]));
const statOf = (s) => ({ dev: Number(s.dev), ino: Number(s.ino), mode: Number(s.mode), nlink: Number(s.nlink), uid: Number(s.uid), gid: Number(s.gid), rdev: Number(s.rdev), size: Number(s.size), blksize: Number(s.blksize), blocks: Number(s.blocks), atimeMs: Number(s.atimeNs) / 1e6, mtimeMs: Number(s.mtimeNs) / 1e6, ctimeMs: Number(s.ctimeNs) / 1e6, birthtimeMs: Number(s.ctimeNs) / 1e6 });
const dirents = (l) => l.map((e) => ({ name: e.name, type: DT[e.type] || "file" }));

// async mappings (guest.js promises)
GuestBackend.prototype._ops = {
  async info() { return this.info(); },
  async chdir(p) { this.cwd = p; },
  async stat(p, follow = true) { return statOf(await (follow ? this.g.stat(p) : this.g.lstat(p))); },
  async fstat(fd) { return statOf(await this.g.fstat(fd)); },
  async readdir(p) { return dirents(await this.g.readdir(p)); },
  async readlink(p) { return this.g.readlink(p); },
  async realpath(p) { return this.g.realpath(p); },
  async access(p, mode) { await this.g.access(p, mode | 0); },
  async open(p, flags, mode) { const fd = await this.g.open(p, flags | 0, mode | 0); this.fdOwner.set(fd, "guest"); return fd; },
  async close(fd) { this.fdOwner.delete(fd); await this.g.close(fd); },
  async read(fd, len, pos) { return this.g.read(fd, len, pos == null ? -1 : pos); },
  async write(fd, bytes, pos) { return this.g.write(fd, bytes, pos == null ? -1 : pos); },
  async readFile(p) { if (typeof p === "number") { const parts = []; for (;;) { const b = await this.g.read(p, 1 << 20, -1); if (!b.length) break; parts.push(b); } return cat(parts); } return this.g.readFile(p); },
  async writeFile(p, bytes, flags = 0o1101, mode = 0o666) { const fd = await this.g.open(p, flags, mode); try { await this.g.write(fd, bytes, -1); } finally { await this.g.close(fd); } },
  async mkdir(p, recursive, mode = 0o777) { if (!recursive) { await this.g.mkdir(p, mode); return undefined; } const parts = p.split("/").filter(Boolean); let first, cur = ""; for (const part of parts) { cur += "/" + part; try { await this.g.mkdir(cur, mode); if (first === undefined) first = cur; } catch (e) { if (e.code !== "EEXIST") throw e; } } return first; },
  async rmdir(p) { await this.g.rmdir(p); },
  async unlink(p) { await this.g.unlink(p); },
  async rename(a, b) { await this.g.rename(a, b); },
  async symlink(t, p) { await this.g.symlink(t, p); },
  async link(a, b) { await this.g.link(a, b); },
  async chmod(p, m) { await this.g.chmod(p, m); },
  async chown(p, u, g) { await this.g.chown(p, u, g); },
  async utimes(p, a, m) { await this.g.utimes(p, BigInt(Math.round(a * 1e6)), BigInt(Math.round(m * 1e6))); },
  async truncate(p, len) { if (typeof p === "number") await this.g.ftruncate(p, len); else await this.g.truncate(p, len); },
  async copyFile(a, b, flags) { const data = await this._ops.readFile.call(this, a); await this._ops.writeFile.call(this, b, data, (flags & 1) ? 0o1301 : 0o1101); },
  async rm(p, recursive, force) { try { const st = await this.g.lstat(p); if ((Number(st.mode) & 0o170000) === S_IFDIR) { if (!recursive) throw err("EISDIR", "rm", p); for (const e of await this.g.readdir(p)) await this._ops.rm.call(this, p.replace(/\/$/, "") + "/" + e.name, true, force); await this.g.rmdir(p); } else await this.g.unlink(p); } catch (e) { if (force && e && (e.code === "ENOENT" || e.__errno === "ENOENT")) return; throw e; } },
  async mkdtemp(prefix) { const p = prefix + Math.random().toString(36).slice(2, 8); await this.g.mkdir(p, 0o700); return p; },
  async fsync(fd) { await this.g.fsync(fd); },
  async fdatasync(fd) { await this.g.fsync(fd); },
  async ttySize() { return this.g.ttySize(); },
  async ttyWrite(fd, bytes) { (fd === 2 ? this.g.stderr : this.g.stdout)(bytes); return bytes.byteLength; },
  async ttySetRaw(on) { this.g.ttyRaw(!!on); return true; },
  async isatty(fd) { return this.hello ? !!(this.hello.isatty & (1 << fd)) : fd < 3; },
  async spawn(spec) { const cid = this.cid++; try { await this.g.spawn(cid, [spec.file, ...(spec.args || [])], Object.entries(spec.env || {}).map(([k, v]) => k + "=" + v), spec.cwd || "/", 1); return { pid: cid }; } catch (e) { return { error: e.code || "ENOENT" }; } },
  async spawnSync(spec) { const cid = this.cid++; try { await this.g.spawn(cid, [spec.file, ...(spec.args || [])], Object.entries(spec.env || {}).map(([k, v]) => k + "=" + v), spec.cwd || "/", 1); } catch (e) { return { error: e.code || "ENOENT" }; } return new Promise((res) => { const out = [], errs = []; const off = this.on("proc", (ev) => { if (ev.pid !== cid) return; if (ev.stream) (ev.stream === "stderr" ? errs : out).push(ev.data); else if (ev.exit !== undefined) { off(); res({ pid: cid, status: ev.signal ? null : ev.exit, signal: ev.signal, stdout: cat(out), stderr: cat(errs) }); } }); }); },
  async procInput(cid, bytes) { this.g.childStdin(cid, bytes || new Uint8Array(0)); },
  async procKill(cid, sig) { this.g.kill(cid, typeof sig === "string" ? (SIG[sig] || 15) : sig | 0); return true; },
  async netConnect() { return { error: "ECONNREFUSED" }; },
  async netWrite() { throw err("ENOTCONN", "write"); },
  async netEnd() {},
};
const cat = (a) => { const n = a.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n); let k = 0; for (const c of a) { o.set(c, k); k += c.length; } return o; };
// synchronous mappings: [guest.js method, args, replyParser(r), transform?] — one request per op
// (composite ops — readFile, writeFile, mkdir -p, copyFile, rm -r, mkdtemp — are sequenced in _syncGuest)
const rStat = (P) => (r) => statOf(P.readStat(r));
const SYNC_SEND = {
  stat(p, follow = true) { return [follow ? "stat" : "lstat", [p], rStat(this.P)]; },
  fstat(fd) { return ["fstat", [fd], rStat(this.P)]; },
  readdir(p) { return ["readdir", [p], (r) => dirents(r.list((x) => ({ name: x.str(), type: x.u8() })))]; },
  readlink(p) { return ["readlink", [p], (r) => r.str()]; },
  realpath(p) { return ["realpath", [p], (r) => r.str()]; },
  access(p, m) { return ["access", [p, m | 0], null]; },
  open(p, flags, mode) { return ["open", [p, flags | 0, mode | 0], (r) => r.i32(), (fd) => { this.fdOwner.set(fd, "guest"); return fd; }]; },
  close(fd) { this.fdOwner.delete(fd); return ["close", [fd], null]; },
  read(fd, len, pos) { return ["read", [fd, len, pos == null ? -1 : pos], (r) => r.bin()]; },
  write(fd, bytes, pos) { return ["write", [fd, bytes, pos == null ? -1 : pos], (r) => r.i32()]; },
  rmdir(p) { return ["rmdir", [p], null]; },
  unlink(p) { return ["unlink", [p], null]; },
  rename(a, b) { return ["rename", [a, b], null]; },
  symlink(t, p) { return ["symlink", [t, p], null]; },
  link(a, b) { return ["link", [a, b], null]; },
  chmod(p, m) { return ["chmod", [p, m], null]; },
  chown(p, u, g) { return ["chown", [p, u, g], null]; },
  utimes(p, a, m) { return ["utimes", [p, BigInt(Math.round(a * 1e6)), BigInt(Math.round(m * 1e6))], null]; },
  truncate(p, len) { return typeof p === "number" ? ["ftruncate", [p, len], null] : ["truncate", [p, len], null]; },
  fsync(fd) { return ["fsync", [fd], null]; },
  fdatasync(fd) { return ["fsync", [fd], null]; },
  ttySize() { return ["ttySize", [], (r) => ({ cols: r.i32(), rows: r.i32() })]; },
};
