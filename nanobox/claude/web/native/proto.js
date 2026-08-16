// nanobox "system node" wire protocol — the byte stream between the guest-side node shim
// (guest/nbnode/nbnode.c, talking to /dev/hvc1) and the host JS worker (browser V8) that executes
// the JavaScript. Binary, little-endian, both directions:
//
//   frame := u32 len (of everything after this field) | u8 op | u32 id | payload
//   payload fields, in the order listed per op: i32/u32 = 4 bytes, i64 = 8 bytes,
//   str = u32 n + n bytes utf-8, bin = u32 n + n bytes, list = u32 count + items
//
// HOST -> GUEST (requests; the guest replies with REPLY carrying the same id):
//   OPEN      1  str path, i32 flags (Linux O_* bits), i32 mode          -> reply: i32 fd
//   CLOSE     2  i32 fd
//   READ      3  i32 fd, u32 len, i64 off (-1 = current position)          -> reply: bin data
//   WRITE     4  i32 fd, i64 off (-1 = current), bin data                  -> reply: i32 written
//   STAT      5  str path         -> reply: STAT record (13 x i64: dev ino mode nlink uid gid rdev size blksize blocks atime_ns mtime_ns ctime_ns)
//   LSTAT     6  str path         -> STAT record
//   FSTAT     7  i32 fd           -> STAT record
//   READDIR   8  str path         -> reply: list of (str name, u8 dtype)
//   READLINK  9  str path         -> reply: str target
//   MKDIR    10  str path, i32 mode
//   UNLINK   11  str path
//   RMDIR    12  str path
//   RENAME   13  str from, str to
//   ACCESS   14  str path, i32 mode
//   CHMOD    15  str path, i32 mode
//   REALPATH 16  str path         -> reply: str
//   UTIMES   17  str path, i64 atime_ns, i64 mtime_ns
//   TRUNCATE 18  str path, i64 len
//   FTRUNCATE 19 i32 fd, i64 len
//   SYMLINK  20  str target, str path
//   LINK     21  str from, str to
//   FSYNC    22  i32 fd
//   CHOWN    23  str path, i32 uid, i32 gid
//   FCHMOD   24  i32 fd, i32 mode
//   STDOUT   30  bin data                      (written to the shim's stdout = the container tty)
//   STDERR   31  bin data
//   EXIT     32  i32 code                       (shim exits with that code; no reply)
//   TTY_RAW  33  i32 on                         (raw/cooked mode on the shim's stdin)
//   TTY_SIZE 34                                 -> reply: i32 cols, i32 rows
//   SPAWN    40  u32 cid, list argv(str), list env(str "K=V"), str cwd, i32 flags (bit0: pipe stdio, bit1: pty) -> reply: i32 pid
//   CHILD_STDIN 41 u32 cid, bin data            (empty bin = close the child's stdin)
//   KILL     42  u32 cid, i32 signal
//   GETPID   43                                 -> reply: i32 pid
//   HRTIME   44                                 -> reply: i64 monotonic ns  (rarely used; host clock is fine)
//   Replies carry: u8 op=REPLY(100), u32 id, i32 errno (0 = ok, else Linux errno; payload absent), payload as listed.
//
// GUEST -> HOST (events, id = 0):
//   HELLO    0  u32 version(1), list argv(str), list env(str), str cwd, i32 pid, i32 cols, i32 rows, i32 isatty bits(bit0 stdin,1 stdout,2 stderr)
//   REPLY  100  (see above)
//   STDIN  101  bin data              (bytes typed on the tty; empty = EOF)
//   RESIZE 102  i32 cols, i32 rows
//   CHILD_OUT 103 u32 cid, i32 fd(1|2), bin data (empty = that stream closed)
//   CHILD_EXIT 104 u32 cid, i32 code, i32 signal
//   SIGNAL 105  i32 signum           (SIGINT/SIGTERM/SIGHUP delivered to the shim)
//   LOG    106  str text             (shim diagnostics)
//
// Encoding helpers (used by the JS side; the C shim mirrors them).
(function (global) {
  const OP = { OPEN: 1, CLOSE: 2, READ: 3, WRITE: 4, STAT: 5, LSTAT: 6, FSTAT: 7, READDIR: 8, READLINK: 9, MKDIR: 10, UNLINK: 11, RMDIR: 12,
    RENAME: 13, ACCESS: 14, CHMOD: 15, REALPATH: 16, UTIMES: 17, TRUNCATE: 18, FTRUNCATE: 19, SYMLINK: 20, LINK: 21, FSYNC: 22, CHOWN: 23, FCHMOD: 24,
    STDOUT: 30, STDERR: 31, EXIT: 32, TTY_RAW: 33, TTY_SIZE: 34, SPAWN: 40, CHILD_STDIN: 41, KILL: 42, GETPID: 43, HRTIME: 44,
    HELLO: 0, REPLY: 100, STDIN: 101, RESIZE: 102, CHILD_OUT: 103, CHILD_EXIT: 104, SIGNAL: 105, LOG: 106 };
  const enc = new TextEncoder(), dec = new TextDecoder();
  // writer: collects parts, then frame(op, id) returns the framed Uint8Array
  class W {
    constructor() { this.parts = []; this.n = 0; }
    push(u8) { this.parts.push(u8); this.n += u8.length; return this; }
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return this.push(b); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return this.push(b); }
    u8(v) { return this.push(new Uint8Array([v & 255])); }
    i64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return this.push(b); }
    str(s) { const b = enc.encode(String(s)); this.u32(b.length); return this.push(b); }
    bin(u8) { u8 = u8 || new Uint8Array(0); this.u32(u8.length); return this.push(u8); }
    list(items, f) { this.u32(items.length); for (const it of items) f(this, it); return this; }
    frame(op, id) {
      const out = new Uint8Array(4 + 1 + 4 + this.n); const dv = new DataView(out.buffer);
      dv.setUint32(0, 1 + 4 + this.n, true); out[4] = op; dv.setUint32(5, id >>> 0, true);
      let o = 9; for (const p of this.parts) { out.set(p, o); o += p.length; }
      return out;
    }
  }
  // reader over one frame's payload
  class R {
    constructor(u8, o) { this.b = u8; this.o = o || 0; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
    i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
    u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
    u8() { return this.b[this.o++]; }
    i64() { const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; }
    i64n() { return Number(this.i64()); }
    str() { const n = this.u32(); const s = dec.decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
    bin() { const n = this.u32(); const s = this.b.slice(this.o, this.o + n); this.o += n; return s; }
    list(f) { const n = this.u32(); const out = []; for (let i = 0; i < n; i++) out.push(f(this)); return out; }
    left() { return this.b.length - this.o; }
  }
  // stream framer: feed(bytes) -> calls onFrame(op, id, R payload)
  function framer(onFrame) {
    let buf = new Uint8Array(0);
    return (chunk) => {
      const nb = new Uint8Array(buf.length + chunk.length); nb.set(buf); nb.set(chunk, buf.length); buf = nb;
      for (;;) {
        if (buf.length < 4) return;
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
        if (buf.length < 4 + len) return;
        const op = buf[4], id = new DataView(buf.buffer, buf.byteOffset).getUint32(5, true);
        const payload = buf.subarray(9, 4 + len);
        buf = buf.slice(4 + len);
        onFrame(op, id, new R(payload));
      }
    };
  }
  const readStat = (r) => { const f = ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "atimeNs", "mtimeNs", "ctimeNs"]; const st = {}; for (const k of f) st[k] = r.i64(); return st; };
  global.NanoboxProto = { OP, W, R, framer, readStat, VERSION: 1 };
})(typeof self !== "undefined" ? self : globalThis);
