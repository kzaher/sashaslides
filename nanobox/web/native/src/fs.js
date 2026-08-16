// Node `fs` (sync + callback + promises + streams) on top of the syscall backend (backend.js).
// No file data lives here: every operation is one B.call / B.callAsync.
import { Buffer } from "buffer";
import { Readable, Writable } from "readable-stream";
import { EventEmitter } from "events";
import { errnoError, rethrow } from "./errors.js";
import { O, S_IFMT, S_IFDIR, S_IFREG, S_IFLNK, S_IFCHR, S_IFIFO, S_IFSOCK, F_OK, R_OK, W_OK, X_OK } from "./backend.js";
import { noteMissing } from "./record.js";

import { reportError } from "./report.js";
import { isErrno } from "./errors.js";
export function makeFs(B) {
  const constants = {
    F_OK, R_OK, W_OK, X_OK, O_RDONLY: O.RDONLY, O_WRONLY: O.WRONLY, O_RDWR: O.RDWR, O_CREAT: O.CREAT, O_EXCL: O.EXCL, O_NOCTTY: O.NOCTTY,
    O_TRUNC: O.TRUNC, O_APPEND: O.APPEND, O_DIRECTORY: O.DIRECTORY, O_NOFOLLOW: O.NOFOLLOW, O_SYNC: O.SYNC, O_DSYNC: O.DSYNC, O_NONBLOCK: O.NONBLOCK, O_CLOEXEC: O.CLOEXEC,
    S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFBLK: 0o060000, S_IFIFO, S_IFLNK, S_IFSOCK, S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
    S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20, S_IXGRP: 0o10, S_IRWXO: 0o7, S_IROTH: 0o4, S_IWOTH: 0o2, S_IXOTH: 0o1,
    UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
    UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3, UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7,
    UV_FS_O_FILEMAP: 0, EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1,
  };
  const pathOf = (p) => {
    if (typeof p === "string") return p;
    if (Buffer.isBuffer(p) || p instanceof Uint8Array) return Buffer.from(p).toString();
    if (p instanceof URL) { if (p.protocol !== "file:") throw errnoError("EINVAL", "open", p.href); return decodeURIComponent(p.pathname); }
    if (p && typeof p.href === "string" && p.protocol === "file:") return decodeURIComponent(p.pathname);
    if (typeof p === "number") return p;
    const e = new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? "null" : typeof p}`); e.code = "ERR_INVALID_ARG_TYPE"; throw e;
  };
  const encOf = (o) => (typeof o === "string" ? o : o && o.encoding) || null;
  const toBytes = (data, encoding) => {
    if (data instanceof Uint8Array) return data;
    if (typeof data === "string") return Buffer.from(data, encoding || "utf8");
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.from(String(data), encoding || "utf8");
  };
  const wrap = (bytes, encoding) => { const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); return encoding && encoding !== "buffer" ? b.toString(encoding) : b; };
  const flagsOf = (f, def = "r") => {
    if (f == null) f = def;
    if (typeof f === "number") return f;
    switch (f) {
      case "r": return O.RDONLY; case "rs": case "sr": return O.RDONLY | O.SYNC; case "r+": return O.RDWR; case "rs+": case "sr+": return O.RDWR | O.SYNC;
      case "w": return O.WRONLY | O.CREAT | O.TRUNC; case "wx": case "xw": return O.WRONLY | O.CREAT | O.TRUNC | O.EXCL;
      case "w+": return O.RDWR | O.CREAT | O.TRUNC; case "wx+": case "xw+": return O.RDWR | O.CREAT | O.TRUNC | O.EXCL;
      case "a": return O.WRONLY | O.CREAT | O.APPEND; case "ax": case "xa": return O.WRONLY | O.CREAT | O.APPEND | O.EXCL; case "as": case "sa": return O.WRONLY | O.CREAT | O.APPEND | O.SYNC;
      case "a+": return O.RDWR | O.CREAT | O.APPEND; case "ax+": case "xa+": return O.RDWR | O.CREAT | O.APPEND | O.EXCL; case "as+": case "sa+": return O.RDWR | O.CREAT | O.APPEND | O.SYNC;
    }
    const e = new TypeError(`The argument 'flags' is invalid. Received ${JSON.stringify(f)}`); e.code = "ERR_INVALID_ARG_VALUE"; throw e;
  };
  const sync = (op, ...args) => { try { return B.call(op, ...args); } catch (e) { rethrow(e); } };
  const asyncOp = (op, ...args) => B.callAsync(op, ...args).catch((e) => rethrow(e));

  class Stats {
    constructor(s) { Object.assign(this, s); this.atime = new Date(s.atimeMs); this.mtime = new Date(s.mtimeMs); this.ctime = new Date(s.ctimeMs); this.birthtime = new Date(s.birthtimeMs); }
    isFile() { return (this.mode & S_IFMT) === S_IFREG; }
    isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
    isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
    isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
    isBlockDevice() { return (this.mode & S_IFMT) === 0o060000; }
    isFIFO() { return (this.mode & S_IFMT) === S_IFIFO; }
    isSocket() { return (this.mode & S_IFMT) === S_IFSOCK; }
  }
  const mkStats = (s, opts) => { const st = new Stats(s); if (opts && opts.bigint) for (const k of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks"]) st[k] = BigInt(st[k]); return st; };
  const DT = { file: 1, dir: 2, link: 3, fifo: 4, socket: 5, char: 6, block: 7 };
  class Dirent {
    constructor(name, type, parentPath) { this.name = name; this[Symbol.for("type")] = type; this.parentPath = parentPath; this.path = parentPath; }
    isFile() { return this[Symbol.for("type")] === "file"; }
    isDirectory() { return this[Symbol.for("type")] === "dir"; }
    isSymbolicLink() { return this[Symbol.for("type")] === "link"; }
    isCharacterDevice() { return this[Symbol.for("type")] === "char"; }
    isBlockDevice() { return this[Symbol.for("type")] === "block"; }
    isFIFO() { return this[Symbol.for("type")] === "fifo"; }
    isSocket() { return this[Symbol.for("type")] === "socket"; }
  }
  const joinP = (a, b) => (a.endsWith("/") ? a + b : a + "/" + b);
  function readdirImpl(list, p, opts, recurse) {
    const withTypes = opts && opts.withFileTypes, enc = encOf(opts);
    const out = [];
    const walk = (dir, rel, entries) => {
      for (const e of entries) {
        const name = rel ? joinP(rel, e.name) : e.name;
        out.push(withTypes ? new Dirent(e.name, e.type, rel ? joinP(p, rel) : p) : enc === "buffer" ? Buffer.from(name) : name);
        if (recurse && e.type === "dir") { const sub = list(joinP(dir, e.name)); if (sub) walk(joinP(dir, e.name), name, sub); }
      }
    };
    walk(p, "", list(p));
    return out;
  }
  const readdirSync = (p, opts) => { p = pathOf(p); return readdirImpl((d) => sync("readdir", d), p, opts, opts && opts.recursive); };

  // ---- sync ----
  const fs = {
    constants, F_OK, R_OK, W_OK, X_OK, Stats, Dirent,
    existsSync(p) { try { sync("stat", pathOf(p), true); return true; } catch { return false; } },
    accessSync(p, mode = F_OK) { sync("access", pathOf(p), mode); },
    statSync(p, opts) { try { return mkStats(sync("stat", pathOf(p), true), opts); } catch (e) { if (opts && opts.throwIfNoEntry === false && e.code === "ENOENT") return undefined; throw e; } },
    lstatSync(p, opts) { try { return mkStats(sync("stat", pathOf(p), false), opts); } catch (e) { if (opts && opts.throwIfNoEntry === false && e.code === "ENOENT") return undefined; throw e; } },
    fstatSync(fd, opts) { return mkStats(sync("fstat", fd), opts); },
    statfsSync() { return { type: 0xef53, bsize: 4096, blocks: 1e6, bfree: 5e5, bavail: 5e5, files: 1e5, ffree: 5e4 }; },
    readFileSync(p, opts) { const enc = encOf(opts); const flag = opts && typeof opts === "object" && opts.flag; if (typeof p !== "number" && flag && flag !== "r") { const fd = fs.openSync(p, flag); try { return wrap(sync("readFile", fd), enc); } finally { fs.closeSync(fd); } } return wrap(sync("readFile", pathOf(p)), enc); },
    writeFileSync(p, data, opts) { const enc = encOf(opts); const o = typeof opts === "object" && opts || {}; sync("writeFile", pathOf(p), toBytes(data, enc), flagsOf(o.flag, "w"), o.mode == null ? 0o666 : o.mode); },
    appendFileSync(p, data, opts) { const enc = encOf(opts); const o = typeof opts === "object" && opts || {}; sync("writeFile", pathOf(p), toBytes(data, enc), flagsOf(o.flag, "a"), o.mode == null ? 0o666 : o.mode); },
    readdirSync,
    mkdirSync(p, opts) { const o = typeof opts === "number" ? { mode: opts } : opts || {}; return sync("mkdir", pathOf(p), !!o.recursive, o.mode == null ? 0o777 : o.mode); },
    rmdirSync(p, opts) { if (opts && opts.recursive) return sync("rm", pathOf(p), true, false); sync("rmdir", pathOf(p)); },
    rmSync(p, opts) { const o = opts || {}; sync("rm", pathOf(p), !!o.recursive, !!o.force); },
    unlinkSync(p) { sync("unlink", pathOf(p)); },
    renameSync(a, b) { sync("rename", pathOf(a), pathOf(b)); },
    readlinkSync(p, opts) { const r = sync("readlink", pathOf(p)); return encOf(opts) === "buffer" ? Buffer.from(r) : r; },
    realpathSync: Object.assign((p, opts) => { const r = sync("realpath", pathOf(p)); return encOf(opts) === "buffer" ? Buffer.from(r) : r; }, { native: (p, opts) => fs.realpathSync(p, opts) }),
    symlinkSync(target, p) { sync("symlink", pathOf(target), pathOf(p)); },
    linkSync(a, b) { sync("link", pathOf(a), pathOf(b)); },
    chmodSync(p, mode) { sync("chmod", pathOf(p), typeof mode === "string" ? parseInt(mode, 8) : mode); },
    lchmodSync(p, mode) { fs.chmodSync(p, mode); },
    fchmodSync(fd, mode) { noteMissing("fs.fchmodSync", "call"); },
    chownSync(p, uid, gid) { sync("chown", pathOf(p), uid, gid); },
    lchownSync(p, uid, gid) { sync("chown", pathOf(p), uid, gid); },
    fchownSync() {},
    utimesSync(p, at, mt) { sync("utimes", pathOf(p), toMs(at), toMs(mt)); },
    lutimesSync(p, at, mt) { sync("utimes", pathOf(p), toMs(at), toMs(mt)); },
    futimesSync() {},
    truncateSync(p, len = 0) { sync("truncate", pathOf(p), len); },
    ftruncateSync(fd, len = 0) { sync("truncate", fd, len); },
    copyFileSync(a, b, mode = 0) { sync("copyFile", pathOf(a), pathOf(b), mode); },
    cpSync(a, b, opts) { copyTree(pathOf(a), pathOf(b), opts || {}); },
    mkdtempSync(prefix, opts) { const r = sync("mkdtemp", pathOf(prefix)); return encOf(opts) === "buffer" ? Buffer.from(r) : r; },
    openSync(p, flags, mode) { return sync("open", pathOf(p), flagsOf(flags), mode == null ? 0o666 : typeof mode === "string" ? parseInt(mode, 8) : mode); },
    closeSync(fd) { sync("close", fd); },
    readSync(fd, buffer, offset, length, position) {
      if (offset != null && typeof offset === "object") { const o = offset; offset = o.offset; length = o.length; position = o.position; }
      if (offset == null) offset = 0; if (length == null) length = buffer.byteLength - offset;
      if (typeof position === "bigint") position = Number(position);
      const out = sync("read", fd, length, position == null || position < 0 ? null : position);
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(out, offset);
      return out.byteLength;
    },
    writeSync(fd, data, a, b, c) {
      let bytes, position = null;
      if (typeof data === "string") { position = a; bytes = Buffer.from(data, b || "utf8"); }
      else if (a != null && typeof a === "object") { bytes = data.subarray(a.offset || 0, (a.offset || 0) + (a.length == null ? data.byteLength - (a.offset || 0) : a.length)); position = a.position; }
      else { const off = a || 0, len = b == null ? data.byteLength - off : b; bytes = new Uint8Array(data.buffer, data.byteOffset + off, len); position = c; }
      return sync("write", fd, bytes, position == null || position < 0 ? null : position);
    },
    writevSync(fd, buffers, position) { let n = 0; for (const b of buffers) n += fs.writeSync(fd, b, 0, b.byteLength, position == null ? null : position + n); return n; },
    readvSync(fd, buffers, position) { let n = 0; for (const b of buffers) { const r = fs.readSync(fd, b, 0, b.byteLength, position == null ? null : position + n); n += r; if (r < b.byteLength) break; } return n; },
    fsyncSync(fd) { sync("fsync", fd); },
    fdatasyncSync(fd) { sync("fsync", fd); },
    opendirSync(p, opts) { return new Dir(pathOf(p), opts); },
    watch(p, opts, listener) { if (typeof opts === "function") { listener = opts; opts = {}; } const w = new FSWatcher(pathOf(p), opts, "watch"); if (listener) w.on("change", listener); return w; },
    // fs.watchFile/watch: the guest has no inotify channel to us, so poll the backend's stat — the
    // interval the caller asks for (config reload, plugin/skill directories: seconds, not frames)
    watchFile(p, opts, listener) {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      const key = pathOf(p);
      const w = watchers.get(key) || new FSWatcher(key, opts, "watchFile");
      watchers.set(key, w);
      if (listener) w.on("changeStat", listener);
      return w;
    },
    unwatchFile(p, listener) {
      const key = pathOf(p), w = watchers.get(key); if (!w) return;
      if (listener) w.off("changeStat", listener); else w.removeAllListeners("changeStat");
      if (w.listenerCount("changeStat") === 0) { w.close(); watchers.delete(key); }
    },
    createReadStream(p, opts) { return new ReadStream(p, opts); },
    createWriteStream(p, opts) { return new WriteStream(p, opts); },
    globSync() { noteMissing("fs.globSync", "call"); return []; },
  };
  const toMs = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? (t < 1e11 ? t * 1000 : t) : Date.now());
  function copyTree(a, b, o) {
    const st = fs.lstatSync(a);
    if (st.isDirectory()) { if (!o.recursive) throw errnoError("EISDIR", "cp", a); try { fs.mkdirSync(b, { recursive: true }); } catch {} for (const e of fs.readdirSync(a)) copyTree(joinP(a, e), joinP(b, e), o); }
    else if (st.isSymbolicLink()) { try { fs.symlinkSync(fs.readlinkSync(a), b); } catch (e) { if (!o.force && e.code === "EEXIST") throw e; } }
    else { if (!o.force && fs.existsSync(b) && o.errorOnExist) throw errnoError("EEXIST", "cp", b); fs.copyFileSync(a, b); }
  }

  // Polling watcher (there is no inotify path from the guest to this worker): stat every
  // `interval` ms and report the transitions node's watchers report. Cheap: one stat per file per
  // tick, on paths the program itself asked us to watch.
  class FSWatcher extends EventEmitter {
    constructor(path, opts, kind) {
      super();
      this.path = path; this.closed = false;
      const interval = Math.max(200, (opts && opts.interval) || 1000);
      let prev = statOrNull(path);
      if (kind === "watchFile" && opts && opts.bigint === undefined) queueMicrotask(() => { if (prev) this.emit("changeStat", prev, prev); });
      this._timer = setInterval(() => {
        const now = statOrNull(path);
        if (same(prev, now)) return;
        const before = prev; prev = now;
        if (kind === "watchFile") { this.emit("changeStat", now || zeroStat(), before || zeroStat()); return; }
        this.emit("change", now && before ? "change" : "rename", path.replace(/^.*\//, ""));
      }, interval);
    }
    close() { if (this.closed) return; this.closed = true; clearInterval(this._timer); this.emit("close"); }
    ref() { return this; } unref() { return this; }
  }
  const watchers = new Map();
  function statOrNull(p) { try { return fs.statSync(p); } catch { return null; } }
  function zeroStat() { return { dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 0, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, isFile: () => false, isDirectory: () => false }; }
  function same(a, b) { if (!a || !b) return !a && !b; return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino && a.mode === b.mode; }
  class Dir {
    constructor(p, opts) { this.path = p; this._entries = null; this._i = 0; this._opts = opts; }
    _load() { if (!this._entries) this._entries = readdirImpl((d) => sync("readdir", d), this.path, { withFileTypes: true }, false); }
    readSync() { this._load(); return this._i < this._entries.length ? this._entries[this._i++] : null; }
    read(cb) { const p = Promise.resolve().then(() => this.readSync()); if (cb) { p.then((v) => cb(null, v), (e) => cb(e)); return; } return p; }
    closeSync() {} close(cb) { if (cb) queueMicrotask(() => cb(null)); else return Promise.resolve(); }
    async *[Symbol.asyncIterator]() { this._load(); while (this._i < this._entries.length) yield this._entries[this._i++]; }
    [Symbol.asyncDispose]() { return this.close(); }
  }

  // ---- streams ----
  class ReadStream extends Readable {
    constructor(p, opts) {
      opts = typeof opts === "string" ? { encoding: opts } : opts || {};
      super({ highWaterMark: opts.highWaterMark || 64 * 1024, encoding: opts.encoding, emitClose: true, autoDestroy: true, signal: opts.signal });
      this.path = p == null ? undefined : pathOf(p);
      this.fd = opts.fd == null ? null : opts.fd;
      this.flags = opts.flags == null ? "r" : opts.flags; this.mode = opts.mode == null ? 0o666 : opts.mode;
      this.start = opts.start; this.end = opts.end == null ? Infinity : opts.end; this.pos = this.start;
      this.autoClose = opts.autoClose !== false; this.bytesRead = 0; this.pending = true;
      if (this.fd == null) {
        asyncOp("open", this.path, flagsOf(this.flags), this.mode).then((fd) => { this.fd = fd; this.pending = false; this.emit("open", fd); this.emit("ready"); }, (e) => this.destroy(e));
      } else { this.pending = false; queueMicrotask(() => this.emit("ready")); }
    }
    _read(n) {
      if (this.fd == null) { this.once("open", () => this._read(n)); return; }
      const remaining = this.end === Infinity ? n : Math.min(n, this.end - (this.pos == null ? 0 : this.pos) + 1);
      if (remaining <= 0) { this.push(null); return; }
      asyncOp("read", this.fd, remaining, this.pos == null ? null : this.pos).then((bytes) => {
        if (bytes.byteLength === 0) { this.push(null); return; }
        if (this.pos != null) this.pos += bytes.byteLength;
        this.bytesRead += bytes.byteLength;
        this.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }, (e) => this.destroy(e));
    }
    _destroy(err, cb) { if (this.fd != null && this.autoClose) { const fd = this.fd; this.fd = null; asyncOp("close", fd).then(() => cb(err), (e) => cb(err || e)); } else cb(err); }
    close(cb) { if (cb) this.once("close", cb); this.destroy(); }
  }
  class WriteStream extends Writable {
    constructor(p, opts) {
      opts = typeof opts === "string" ? { encoding: opts } : opts || {};
      super({ highWaterMark: opts.highWaterMark, decodeStrings: true, defaultEncoding: opts.encoding || "utf8", emitClose: true, autoDestroy: true, signal: opts.signal });
      this.path = p == null ? undefined : pathOf(p);
      this.fd = opts.fd == null ? null : opts.fd;
      this.flags = opts.flags == null ? "w" : opts.flags; this.mode = opts.mode == null ? 0o666 : opts.mode;
      this.pos = opts.start; this.autoClose = opts.autoClose !== false; this.bytesWritten = 0; this.pending = true;
      if (this.fd == null) {
        asyncOp("open", this.path, flagsOf(this.flags), this.mode).then((fd) => { this.fd = fd; this.pending = false; this.emit("open", fd); this.emit("ready"); }, (e) => this.destroy(e));
      } else { this.pending = false; queueMicrotask(() => this.emit("ready")); }
    }
    _write(chunk, enc, cb) {
      if (this.fd == null) { this.once("open", () => this._write(chunk, enc, cb)); return; }
      const bytes = toBytes(chunk, enc);
      asyncOp("write", this.fd, bytes, this.pos == null ? null : this.pos).then((n) => { this.bytesWritten += n; if (this.pos != null) this.pos += n; cb(); }, cb);
    }
    _writev(chunks, cb) { const all = Buffer.concat(chunks.map((c) => toBytes(c.chunk, c.encoding))); this._write(all, "buffer", cb); }
    _destroy(err, cb) { if (this.fd != null && this.autoClose) { const fd = this.fd; this.fd = null; asyncOp("close", fd).then(() => cb(err), (e) => cb(err || e)); } else cb(err); }
    close(cb) { if (cb) { if (this.closed) { queueMicrotask(cb); return; } this.once("close", cb); } if (!this.writableFinished) this.end(); else this.destroy(); }
    _final(cb) { cb(); }
  }
  fs.ReadStream = ReadStream; fs.WriteStream = WriteStream; fs.FileReadStream = ReadStream; fs.FileWriteStream = WriteStream; fs.Dir = Dir; fs.FSWatcher = FSWatcher;

  // ---- promises ----
  class FileHandle extends EventEmitter {
    constructor(fd) { super(); this.fd = fd; }
    async read(buffer, offset, length, position) {
      if (buffer == null || !(buffer instanceof Uint8Array)) { const o = buffer || {}; buffer = o.buffer || Buffer.alloc(16384); offset = o.offset || 0; length = o.length == null ? buffer.byteLength - offset : o.length; position = o.position; }
      const n = await promises._readInto(this.fd, buffer, offset || 0, length == null ? buffer.byteLength - (offset || 0) : length, position);
      return { bytesRead: n, buffer };
    }
    async write(data, a, b, c) { if (typeof data === "string") { const bytes = Buffer.from(data, b || "utf8"); const n = await asyncOp("write", this.fd, bytes, a == null ? null : a); return { bytesWritten: n, buffer: data }; } const off = (a && typeof a === "object" ? a.offset : a) || 0; const len = (a && typeof a === "object" ? a.length : b); const pos = a && typeof a === "object" ? a.position : c; const bytes = new Uint8Array(data.buffer, data.byteOffset + off, len == null ? data.byteLength - off : len); const n = await asyncOp("write", this.fd, bytes, pos == null ? null : pos); return { bytesWritten: n, buffer: data }; }
    async writev(bufs, position) { let n = 0; for (const b of bufs) { const r = await this.write(b, 0, b.byteLength, position == null ? null : position + n); n += r.bytesWritten; } return { bytesWritten: n, buffers: bufs }; }
    async readFile(opts) { return wrap(await asyncOp("readFile", this.fd), encOf(opts)); }
    async writeFile(data, opts) { await asyncOp("write", this.fd, toBytes(data, encOf(opts)), null); }
    async appendFile(data, opts) { return this.writeFile(data, opts); }
    async stat(opts) { return mkStats(await asyncOp("fstat", this.fd), opts); }
    async truncate(len = 0) { await asyncOp("truncate", this.fd, len); }
    async sync() {} async datasync() {}
    async chmod() {} async chown() {} async utimes() {}
    async close() { if (this.fd == null) return; const fd = this.fd; this.fd = null; await asyncOp("close", fd); this.emit("close"); }
    createReadStream(opts) { return new ReadStream(null, Object.assign({}, opts, { fd: this.fd })); }
    createWriteStream(opts) { return new WriteStream(null, Object.assign({}, opts, { fd: this.fd })); }
    readLines(opts) { return require_readline().createInterface({ input: this.createReadStream(opts), crlfDelay: Infinity }); }
    readableWebStream() { return Readable.toWeb ? Readable.toWeb(this.createReadStream()) : new ReadableStream(); }
    [Symbol.asyncDispose]() { return this.close(); }
  }
  let require_readline = () => ({ createInterface: () => { throw new Error("readline unavailable"); } });
  const promises = {
    constants,
    async access(p, mode = F_OK) { await asyncOp("access", pathOf(p), mode); },
    async stat(p, opts) { return mkStats(await asyncOp("stat", pathOf(p), true), opts); },
    async lstat(p, opts) { return mkStats(await asyncOp("stat", pathOf(p), false), opts); },
    async statfs() { return fs.statfsSync(); },
    async readFile(p, opts) { if (p instanceof FileHandle) return p.readFile(opts); const o = typeof opts === "object" && opts || {}; if (o.signal && o.signal.aborted) throw abortErr(); const flag = o.flag; if (typeof p !== "number" && flag && flag !== "r") { const fd = await asyncOp("open", pathOf(p), flagsOf(flag), 0o666); try { return wrap(await asyncOp("readFile", fd), encOf(opts)); } finally { await asyncOp("close", fd); } } return wrap(await asyncOp("readFile", pathOf(p)), encOf(opts)); },
    async writeFile(p, data, opts) { if (p instanceof FileHandle) return p.writeFile(data, opts); const o = typeof opts === "object" && opts || {}; if (data && typeof data === "object" && typeof data[Symbol.asyncIterator] === "function" && !(data instanceof Uint8Array)) { const parts = []; for await (const c of data) parts.push(toBytes(c, encOf(opts))); data = Buffer.concat(parts); } await asyncOp("writeFile", pathOf(p), toBytes(data, encOf(opts)), flagsOf(o.flag, "w"), o.mode == null ? 0o666 : o.mode); },
    async appendFile(p, data, opts) { const o = typeof opts === "object" && opts || {}; await asyncOp("writeFile", pathOf(p), toBytes(data, encOf(opts)), flagsOf(o.flag, "a"), o.mode == null ? 0o666 : o.mode); },
    async readdir(p, opts) { p = pathOf(p); if (opts && opts.recursive) return readdirImpl((d) => { try { return sync("readdir", d); } catch { return []; } }, p, opts, true); const list = await asyncOp("readdir", p); return readdirImpl(() => list, p, opts, false); },
    async mkdir(p, opts) { const o = typeof opts === "number" ? { mode: opts } : opts || {}; return asyncOp("mkdir", pathOf(p), !!o.recursive, o.mode == null ? 0o777 : o.mode); },
    async rmdir(p, opts) { if (opts && opts.recursive) return asyncOp("rm", pathOf(p), true, false); await asyncOp("rmdir", pathOf(p)); },
    async rm(p, opts) { const o = opts || {}; await asyncOp("rm", pathOf(p), !!o.recursive, !!o.force); },
    async unlink(p) { await asyncOp("unlink", pathOf(p)); },
    async rename(a, b) { await asyncOp("rename", pathOf(a), pathOf(b)); },
    async readlink(p, opts) { const r = await asyncOp("readlink", pathOf(p)); return encOf(opts) === "buffer" ? Buffer.from(r) : r; },
    async realpath(p, opts) { const r = await asyncOp("realpath", pathOf(p)); return encOf(opts) === "buffer" ? Buffer.from(r) : r; },
    async symlink(t, p) { await asyncOp("symlink", pathOf(t), pathOf(p)); },
    async link(a, b) { await asyncOp("link", pathOf(a), pathOf(b)); },
    async chmod(p, mode) { await asyncOp("chmod", pathOf(p), typeof mode === "string" ? parseInt(mode, 8) : mode); },
    async lchmod(p, mode) { return promises.chmod(p, mode); },
    async chown(p, uid, gid) { await asyncOp("chown", pathOf(p), uid, gid); },
    async lchown(p, uid, gid) { await asyncOp("chown", pathOf(p), uid, gid); },
    async utimes(p, at, mt) { await asyncOp("utimes", pathOf(p), toMs(at), toMs(mt)); },
    async lutimes(p, at, mt) { await asyncOp("utimes", pathOf(p), toMs(at), toMs(mt)); },
    async truncate(p, len = 0) { await asyncOp("truncate", pathOf(p), len); },
    async copyFile(a, b, mode = 0) { await asyncOp("copyFile", pathOf(a), pathOf(b), mode); },
    async cp(a, b, opts) { copyTree(pathOf(a), pathOf(b), opts || {}); },
    async mkdtemp(prefix, opts) { const r = await asyncOp("mkdtemp", pathOf(prefix)); return encOf(opts) === "buffer" ? Buffer.from(r) : r; },
    async open(p, flags, mode) { return new FileHandle(await asyncOp("open", pathOf(p), flagsOf(flags), mode == null ? 0o666 : mode)); },
    async opendir(p, opts) { return new Dir(pathOf(p), opts); },
    async _readInto(fd, buffer, offset, length, position) { const out = await asyncOp("read", fd, length, position == null || position < 0 ? null : Number(position)); new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(out, offset); return out.byteLength; },
    watch(p, opts) { noteMissing("fs.promises.watch", "call"); return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } }; },
    async glob() { noteMissing("fs.promises.glob", "call"); return []; },
    FileHandle,
  };
  const abortErr = () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; return e; };
  fs.promises = promises;
  fs.FileHandle = FileHandle;
  fs._setReadline = (r) => { require_readline = () => r; };

  // ---- callback API: derived from promises ----
  const cbify = (name, pfn, mapResult) => {
    fs[name] = function (...args) {
      let cb = args[args.length - 1];
      if (typeof cb === "function") args = args.slice(0, -1); else cb = null;
      const p = pfn(...args);
      if (!cb) { p.catch(() => {}); return; }
      p.then((v) => cb(null, ...(mapResult ? mapResult(v, args) : [v])), (e) => cb(e));
    };
  };
  for (const n of ["access", "stat", "lstat", "statfs", "readFile", "writeFile", "appendFile", "readdir", "mkdir", "rmdir", "rm", "unlink", "rename", "readlink", "realpath", "symlink", "link", "chmod", "lchmod", "chown", "lchown", "utimes", "lutimes", "truncate", "copyFile", "cp", "mkdtemp"]) cbify(n, promises[n]);
  fs.realpath.native = fs.realpath;
  fs.exists = (p, cb) => { promises.access(p).then(() => cb && cb(true), () => cb && cb(false)); };
  cbify("open", (p, flags, mode) => asyncOp("open", pathOf(p), flagsOf(flags), mode == null || typeof mode === "function" ? 0o666 : mode));
  cbify("close", (fd) => asyncOp("close", fd));
  cbify("fstat", async (fd, opts) => mkStats(await asyncOp("fstat", fd), opts));
  cbify("fsync", (fd) => asyncOp("fsync", fd)); cbify("fdatasync", (fd) => asyncOp("fsync", fd));
  cbify("ftruncate", (fd, len) => asyncOp("truncate", fd, len || 0));
  cbify("fchmod", async () => {}); cbify("fchown", async () => {}); cbify("futimes", async () => {});
  cbify("opendir", (p, opts) => Promise.resolve(new Dir(pathOf(p), typeof opts === "object" ? opts : undefined)));
  fs.read = function (fd, buffer, offset, length, position, cb) {
    if (typeof buffer === "function") { cb = buffer; buffer = Buffer.alloc(16384); offset = 0; length = buffer.byteLength; position = null; }
    else if (buffer && !(buffer instanceof Uint8Array)) { const o = buffer; cb = offset; buffer = o.buffer || Buffer.alloc(16384); offset = o.offset || 0; length = o.length == null ? buffer.byteLength - offset : o.length; position = o.position; }
    else if (typeof offset === "function") { cb = offset; offset = 0; length = buffer.byteLength; position = null; }
    else if (typeof offset === "object" && offset) { cb = length; const o = offset; offset = o.offset || 0; length = o.length == null ? buffer.byteLength - offset : o.length; position = o.position; }
    else if (typeof length === "function") { cb = length; length = buffer.byteLength - offset; position = null; }
    else if (typeof position === "function") { cb = position; position = null; }
    promises._readInto(fd, buffer, offset, length, position).then((n) => cb(null, n, buffer), (e) => cb(e));
  };
  fs.write = function (fd, data, a, b, c, d) {
    let cb = [a, b, c, d].find((x) => typeof x === "function");
    const rest = [a, b, c].map((x) => (typeof x === "function" ? undefined : x));
    Promise.resolve().then(() => fs.writeSync(fd, data, ...rest)).then((n) => cb && cb(null, n, data), (e) => cb && cb(e));
  };
  fs.writev = function (fd, bufs, position, cb) { if (typeof position === "function") { cb = position; position = null; } Promise.resolve().then(() => fs.writevSync(fd, bufs, position)).then((n) => cb && cb(null, n, bufs), (e) => cb && cb(e)); };
  fs.readv = function (fd, bufs, position, cb) { if (typeof position === "function") { cb = position; position = null; } Promise.resolve().then(() => fs.readvSync(fd, bufs, position)).then((n) => cb && cb(null, n, bufs), (e) => cb && cb(e)); };
  fs.glob = (p, o, cb) => { noteMissing("fs.glob", "call"); (cb || o)(null, []); };
  // report every NON-errno exception escaping an fs entry point (TypeErrors from option handling,
  // encodings, missing pieces of the shim...) with the caller's stack — the CLI swallows them into
  // "Error writing file"-style messages; errno errors are reported by errnoError itself
  const wrapReport = (obj, name, label) => {
    const f = obj[name]; if (typeof f !== "function") return;
    obj[name] = function (...a) {
      try { const r = f.apply(this, a); if (r && typeof r.then === "function") return r.then(undefined, (e) => { if (!isErrno(e)) reportError("fs-throw", e, { fn: label + name }); throw e; }); return r; }
      catch (e) { if (!isErrno(e)) reportError("fs-throw", e, { fn: label + name }); throw e; }
    };
  };
  for (const k of Object.keys(fs)) if (k !== "promises" && k !== "constants" && typeof fs[k] === "function" && !/^[A-Z]/.test(k)) wrapReport(fs, k, "fs.");
  for (const k of Object.keys(promises)) if (typeof promises[k] === "function" && !/^[A-Z]/.test(k)) wrapReport(promises, k, "fs.promises.");
  return fs;
}
