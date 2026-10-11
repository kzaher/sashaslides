// nbnode unit test: drives a real nbnode binary over a socketpair (fd 3, NBNODE_FD=3) using the SAME
// encoder/decoder the host uses (web/native/proto.js), so framing + dispatch are checked end to end
// without a VM.  Usage: node test.mjs [path/to/nbnode]   (default ./nbnode-host, then ./nbnode)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(here, "../../web/native/proto.js")); // sets globalThis.NanoboxProto
const { OP, W, framer, readStat } = globalThis.NanoboxProto;

const bin = process.argv[2] ? path.resolve(process.argv[2]) : (fs.existsSync(path.join(here, "nbnode-host")) ? path.join(here, "nbnode-host") : path.join(here, "nbnode"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nbnode-test-"));
let failures = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { failures++; console.log("  FAIL:", what); } else console.log("  ok:", what); };
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(typeof a === "bigint" ? String(a) : a)}, want ${JSON.stringify(typeof b === "bigint" ? String(b) : b)})`);
const dec = new TextDecoder(), enc = new TextEncoder();
const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0o100, O_TRUNC = 0o1000, ENOENT = 2, ENOTTY = 25, ESRCH = 3, EINVAL = 22;

console.log("nbnode test binary:", bin);
const child = spawn(bin, ["/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--foo", "bar baz"],
  { cwd: tmp, env: { ...process.env, NBNODE_FD: "3", NBNODE_DEBUG: "1" }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
const chan = child.stdio[3];
let stdoutText = "", stderrText = "";
child.stdout.on("data", (d) => (stdoutText += d));
child.stderr.on("data", (d) => (stderrText += d));
const exitP = new Promise((res) => child.on("exit", (code, sig) => res({ code, sig })));

// --- frame plumbing: pending replies by id, event queue + waiters
const pending = new Map(), events = [], waiters = [], logs = [];
const feed = framer((op, id, r) => {
  if (op === OP.REPLY) { const p = pending.get(id); pending.delete(id); const err = r.i32(); p && p({ err, r }); return; }
  if (op === OP.LOG) { logs.push(r.str()); return; }
  events.push({ op, r });
  for (let i = 0; i < waiters.length; i++) if (waiters[i]()) { waiters.splice(i, 1); i--; }
});
chan.on("data", (d) => feed(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
let nextId = 1;
const call = (op, build) => new Promise((res) => { const id = nextId++; const w = new W(); if (build) build(w); pending.set(id, res); chan.write(w.frame(op, id)); });
const okCall = async (op, build) => { const { err, r } = await call(op, build); if (err) throw new Error(`${Object.keys(OP).find((k) => OP[k] === op)} -> errno ${err}`); return r; };
const waitEvent = (pred, what) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout waiting for " + what)), 5000);
  const chk = () => { const i = events.findIndex(pred); if (i < 0) return false; clearTimeout(t); res(events.splice(i, 1)[0]); return true; };
  if (!chk()) waiters.push(chk);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---- HELLO
  const hello = await waitEvent((e) => e.op === OP.HELLO, "HELLO");
  const hr = hello.r;
  eq(hr.u32(), 1, "HELLO version");
  const argv = hr.list((r) => r.str());
  eq(argv.length, 4, "HELLO argv length (argv[0] included)");
  eq(argv[0], bin, "HELLO argv[0]");
  eq(argv[3], "bar baz", "HELLO argv[3]");
  const env = hr.list((r) => r.str());
  ok(env.includes("NBNODE_FD=3"), "HELLO env carries NBNODE_FD=3");
  eq(hr.str(), fs.realpathSync(tmp), "HELLO cwd");
  eq(hr.i32(), child.pid, "HELLO pid");
  const cols = hr.i32(), rows = hr.i32();
  eq(cols + rows, 0, "HELLO cols/rows = 0 (no tty)");
  eq(hr.i32(), 0, "HELLO isatty bits = 0");
  eq(hr.left(), 0, "HELLO payload fully consumed");

  // ---- GETPID / HRTIME / TTY_SIZE / TTY_RAW
  eq((await okCall(OP.GETPID)).i32(), child.pid, "GETPID");
  ok((await okCall(OP.HRTIME)).i64() > 0n, "HRTIME > 0");
  eq((await call(OP.TTY_SIZE)).err, ENOTTY, "TTY_SIZE without a tty -> ENOTTY");
  eq((await call(OP.TTY_RAW, (w) => w.i32(1))).err, ENOTTY, "TTY_RAW without a tty -> ENOTTY");

  // ---- fs round trips
  const f = path.join(tmp, "file.txt");
  const fd = (await okCall(OP.OPEN, (w) => w.str(f).i32(O_WRONLY | O_CREAT | O_TRUNC).i32(0o644))).i32();
  ok(fd >= 3, "OPEN O_WRONLY|O_CREAT|O_TRUNC -> fd " + fd);
  eq((await okCall(OP.WRITE, (w) => w.i32(fd).i64(-1).bin(enc.encode("hello world")))).i32(), 11, "WRITE 11 bytes at current pos");
  eq((await okCall(OP.WRITE, (w) => w.i32(fd).i64(6).bin(enc.encode("WORLD")))).i32(), 5, "pWRITE at off 6");
  await okCall(OP.FSYNC, (w) => w.i32(fd));
  const fst = readStat(await okCall(OP.FSTAT, (w) => w.i32(fd)));
  eq(fst.size, 11n, "FSTAT size");
  await okCall(OP.CLOSE, (w) => w.i32(fd));
  eq(fs.readFileSync(f, "utf8"), "hello WORLD", "file content on disk");
  const st = readStat(await okCall(OP.STAT, (w) => w.str(f)));
  eq(st.size, 11n, "STAT size");
  eq(Number(st.mode & 0o170000n), 0o100000, "STAT mode is S_IFREG");
  eq(Number(st.mode & 0o777n), 0o644 & ~process.umask(), "STAT perms");
  ok(st.mtimeNs > 1_600_000_000n * 1_000_000_000n, "STAT mtime_ns plausible");
  eq(st.ino, BigInt(fs.statSync(f).ino), "STAT ino matches node");
  const rfd = (await okCall(OP.OPEN, (w) => w.str(f).i32(O_RDONLY).i32(0))).i32();
  eq(dec.decode((await okCall(OP.READ, (w) => w.i32(rfd).u32(100).i64(-1))).bin()), "hello WORLD", "READ up to 100 at current pos");
  eq(dec.decode((await okCall(OP.READ, (w) => w.i32(rfd).u32(5).i64(6))).bin()), "WORLD", "pREAD 5 at off 6");
  eq((await okCall(OP.READ, (w) => w.i32(rfd).u32(10).i64(-1))).bin().length, 0, "READ at EOF -> empty");
  await okCall(OP.CLOSE, (w) => w.i32(rfd));
  eq((await call(OP.CLOSE, (w) => w.i32(rfd))).err, 9, "double CLOSE -> EBADF");
  eq((await call(OP.STAT, (w) => w.str(path.join(tmp, "nope")))).err, ENOENT, "STAT missing -> ENOENT");
  await okCall(OP.MKDIR, (w) => w.str(path.join(tmp, "sub")).i32(0o755));
  await okCall(OP.SYMLINK, (w) => w.str("file.txt").str(path.join(tmp, "lnk")));
  eq((await okCall(OP.READLINK, (w) => w.str(path.join(tmp, "lnk")))).str(), "file.txt", "READLINK");
  eq(Number(readStat(await okCall(OP.LSTAT, (w) => w.str(path.join(tmp, "lnk")))).mode & 0o170000n), 0o120000, "LSTAT is S_IFLNK");
  eq((await okCall(OP.REALPATH, (w) => w.str(path.join(tmp, "sub", "..", "lnk")))).str(), fs.realpathSync(f), "REALPATH resolves");
  const ents = (await okCall(OP.READDIR, (w) => w.str(tmp))).list((r) => [r.str(), r.u8()]).sort();
  eq(JSON.stringify(ents), JSON.stringify([["file.txt", 8], ["lnk", 10], ["sub", 4]]), "READDIR names + d_type (no . / ..)");
  await okCall(OP.RENAME, (w) => w.str(path.join(tmp, "sub")).str(path.join(tmp, "sub2")));
  eq((await call(OP.ACCESS, (w) => w.str(path.join(tmp, "sub2")).i32(0))).err, 0, "ACCESS renamed dir");
  await okCall(OP.CHMOD, (w) => w.str(f).i32(0o600));
  eq(fs.statSync(f).mode & 0o777, 0o600, "CHMOD applied");
  await okCall(OP.UTIMES, (w) => w.str(f).i64(1_000_000_000_000_000_000n).i64(2_000_000_000_500_000_000n));
  eq(fs.statSync(f).mtimeMs, 2_000_000_000_500, "UTIMES mtime (ns -> ms)");
  await okCall(OP.TRUNCATE, (w) => w.str(f).i64(5));
  eq(fs.readFileSync(f, "utf8"), "hello", "TRUNCATE to 5");
  await okCall(OP.LINK, (w) => w.str(f).str(path.join(tmp, "hard")));
  eq(fs.statSync(f).nlink, 2, "LINK -> nlink 2");
  await okCall(OP.UNLINK, (w) => w.str(path.join(tmp, "hard")));
  await okCall(OP.UNLINK, (w) => w.str(path.join(tmp, "lnk")));
  await okCall(OP.RMDIR, (w) => w.str(path.join(tmp, "sub2")));
  eq((await call(OP.RMDIR, (w) => w.str(path.join(tmp, "sub2")))).err, ENOENT, "RMDIR twice -> ENOENT");
  eq((await call(OP.OPEN, (w) => w.str(f))).err, EINVAL, "truncated payload -> EINVAL");
  eq((await call(99)).err, 38, "unknown op -> ENOSYS");
  // split + coalesced frames: write two frames in one chunk, then one frame byte by byte
  { const a = new W().str(f).frame(OP.STAT, 9001), b = new W().frame(OP.GETPID, 9002);
    const p1 = new Promise((r) => pending.set(9001, r)), p2 = new Promise((r) => pending.set(9002, r));
    chan.write(Buffer.concat([Buffer.from(a), Buffer.from(b)]));
    eq(readStat((await p1).r).size, 5n, "two frames in one write: first"); eq((await p2).r.i32(), child.pid, "two frames in one write: second");
    const c = new W().str(f).frame(OP.STAT, 9003); const p3 = new Promise((r) => pending.set(9003, r));
    for (const byte of c) { chan.write(Buffer.from([byte])); await sleep(1); }
    eq(readStat((await p3).r).size, 5n, "frame delivered byte by byte"); }

  // ---- STDOUT / STDERR
  await okCall(OP.STDOUT, (w) => w.bin(enc.encode("out-line\n")));
  await okCall(OP.STDERR, (w) => w.bin(enc.encode("err-line\n")));
  await sleep(50);
  eq(stdoutText, "out-line\n", "STDOUT written to fd 1");
  ok(stderrText.includes("err-line\n"), "STDERR written to fd 2");

  // ---- SPAWN /bin/echo hi with piped stdio
  const pid = (await okCall(OP.SPAWN, (w) => w.u32(1).list(["/bin/echo", "hi"], (w, s) => w.str(s)).list([], () => {}).str("").i32(1))).i32();
  ok(pid > 0, "SPAWN echo -> pid " + pid);
  const outE = await waitEvent((e) => e.op === OP.CHILD_OUT && e.r.o === 0 && (() => { const c = e.r.u32(), fd = e.r.i32(), d = e.r.bin(); e.r.o = 0; return c === 1 && fd === 1 && d.length > 0; })(), "CHILD_OUT data");
  { const r = outE.r; r.u32(); r.i32(); eq(dec.decode(r.bin()), "hi\n", "CHILD_OUT stdout payload"); }
  const closeOut = await waitEvent((e) => e.op === OP.CHILD_OUT && (() => { const c = e.r.u32(), fd = e.r.i32(), d = e.r.bin(); e.r.o = 0; return c === 1 && fd === 1 && d.length === 0; })(), "CHILD_OUT stdout EOF");
  ok(closeOut, "CHILD_OUT stdout EOF");
  const closeErr = await waitEvent((e) => e.op === OP.CHILD_OUT && (() => { const c = e.r.u32(), fd = e.r.i32(), d = e.r.bin(); e.r.o = 0; return c === 1 && fd === 2 && d.length === 0; })(), "CHILD_OUT stderr EOF");
  ok(closeErr, "CHILD_OUT stderr EOF");
  const ex = await waitEvent((e) => e.op === OP.CHILD_EXIT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 1; })(), "CHILD_EXIT");
  { const r = ex.r; r.u32(); eq(r.i32(), 0, "CHILD_EXIT code 0"); eq(r.i32(), 0, "CHILD_EXIT signal 0"); }
  eq((await call(OP.KILL, (w) => w.u32(1).i32(15))).err, ESRCH, "KILL exited child -> ESRCH");

  // ---- SPAWN cat with CHILD_STDIN + close, cwd + env honoured
  await okCall(OP.SPAWN, (w) => w.u32(2).list(["sh", "-c", "cat; echo \"$FOO $PWD\" >&2"], (w, s) => w.str(s)).list(["FOO=fooval", "PATH=/usr/bin:/bin"], (w, s) => w.str(s)).str(tmp).i32(1));
  await okCall(OP.CHILD_STDIN, (w) => w.u32(2).bin(enc.encode("abc")));
  await okCall(OP.CHILD_STDIN, (w) => w.u32(2).bin(enc.encode("def")));
  await okCall(OP.CHILD_STDIN, (w) => w.u32(2).bin(new Uint8Array(0)));
  let catOut = "", catErr = "";
  for (;;) {
    const e = await waitEvent((e) => e.op === OP.CHILD_OUT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 2; })(), "cat CHILD_OUT");
    e.r.u32(); const fd = e.r.i32(), d = dec.decode(e.r.bin());
    if (fd === 1) catOut += d; else catErr += d;
    if (catOut === "abcdef" && catErr.endsWith("\n")) break;
  }
  eq(catOut, "abcdef", "CHILD_STDIN bytes reached cat");
  eq(catErr, `fooval ${fs.realpathSync(tmp)}\n`, "SPAWN env + cwd applied");
  const ex2 = await waitEvent((e) => e.op === OP.CHILD_EXIT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 2; })(), "cat CHILD_EXIT");
  { const r = ex2.r; r.u32(); eq(r.i32(), 0, "cat exit code 0"); }

  // ---- SPAWN failure, KILL
  eq((await call(OP.SPAWN, (w) => w.u32(3).list(["/nonexistent/prog"], (w, s) => w.str(s)).list([], () => {}).str("").i32(1))).err, ENOENT, "SPAWN missing binary -> ENOENT (no CHILD_EXIT)");
  await okCall(OP.SPAWN, (w) => w.u32(4).list(["sleep", "30"], (w, s) => w.str(s)).list([], () => {}).str("").i32(1));
  await sleep(30);
  eq((await call(OP.KILL, (w) => w.u32(4).i32(15))).err, 0, "KILL sleep SIGTERM");
  const ex4 = await waitEvent((e) => e.op === OP.CHILD_EXIT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 4; })(), "sleep CHILD_EXIT");
  { const r = ex4.r; r.u32(); eq(r.i32(), -1, "killed child code -1"); eq(r.i32(), 15, "killed child signal 15"); }
  ok(!events.some((e) => e.op === OP.CHILD_EXIT), "no stray CHILD_EXIT for the failed spawn");

  // ---- SPAWN with a pty (flags bit1): child sees a tty, output arrives as fd 1 (stderr merged)
  await okCall(OP.SPAWN, (w) => w.u32(5).list(["sh", "-c", "tty >/dev/null && echo istty; echo err >&2"], (w, s) => w.str(s)).list([], () => {}).str("").i32(2));
  let ptyOut = "";
  for (;;) {
    const e = await waitEvent((e) => e.op === OP.CHILD_OUT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 5; })(), "pty CHILD_OUT");
    e.r.u32(); e.r.i32(); const d = e.r.bin(); if (d.length === 0) break; ptyOut += dec.decode(d);
  }
  eq(ptyOut, "istty\r\nerr\r\n", "pty child output (tty, CRLF, stderr merged)");
  const ex5 = await waitEvent((e) => e.op === OP.CHILD_EXIT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 5; })(), "pty CHILD_EXIT");
  { const r = ex5.r; r.u32(); eq(r.i32(), 0, "pty child exit 0"); }

  // ---- CHILD_RESIZE: the HOST sets this pty's geometry (the sandbox page's shell pane has its own
  // width, which is not the console the shim is attached to)
  eq((await call(OP.CHILD_RESIZE, (w) => w.u32(99).i32(80).i32(24))).err, ESRCH, "CHILD_RESIZE unknown cid -> ESRCH");
  await okCall(OP.SPAWN, (w) => w.u32(6).list(["sh", "-c", "sleep 0.3; stty size; sleep 0.6; stty size"], (w, s) => w.str(s)).list([], () => {}).str("").i32(2));
  eq((await call(OP.CHILD_RESIZE, (w) => w.u32(6).i32(123).i32(45))).err, 0, "CHILD_RESIZE on a pty child");
  setTimeout(() => call(OP.CHILD_RESIZE, (w) => w.u32(6).i32(61).i32(17)), 500);   // a SECOND resize (the divider drag)
  let szOut = "";
  for (;;) {
    const e = await waitEvent((e) => e.op === OP.CHILD_OUT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 6; })(), "resize CHILD_OUT");
    e.r.u32(); e.r.i32(); const d = e.r.bin(); if (d.length === 0) break; szOut += dec.decode(d);
  }
  const sz = szOut.trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  eq(sz[0], "45 123", "the pty child sees the size the host set (stty size = rows cols)");
  eq(sz[1], "17 61", "a SECOND CHILD_RESIZE reaches the same pty (the split view's divider drag)");
  await waitEvent((e) => e.op === OP.CHILD_EXIT && (() => { const c = e.r.u32(); e.r.o = 0; return c === 6; })(), "resize child CHILD_EXIT");

  // ---- signals forwarded, not fatal
  process.kill(child.pid, "SIGINT");
  const sg = await waitEvent((e) => e.op === OP.SIGNAL, "SIGNAL");
  eq(sg.r.i32(), 2, "SIGNAL SIGINT forwarded");
  process.kill(child.pid, "SIGWINCH");
  const rz = await waitEvent((e) => e.op === OP.RESIZE, "RESIZE");
  eq(rz.r.i32() + rz.r.i32(), 0, "RESIZE on SIGWINCH (0x0, no tty)");
  eq((await okCall(OP.GETPID)).i32(), child.pid, "shim still alive after SIGINT");

  // ---- stdin forwarding: bytes typed -> STDIN events; close -> empty STDIN
  child.stdin.write("typed\n");
  const si = await waitEvent((e) => e.op === OP.STDIN, "STDIN");
  eq(dec.decode(si.r.bin()), "typed\n", "STDIN bytes forwarded");
  child.stdin.end();
  const si2 = await waitEvent((e) => e.op === OP.STDIN, "STDIN EOF");
  eq(si2.r.bin().length, 0, "STDIN EOF announced as empty");

  // ---- LOG frames were produced (NBNODE_DEBUG=1)
  ok(logs.some((l) => l.startsWith("<- OPEN")), "LOG tracing to host works (" + logs.length + " lines)");

  // ---- EXIT
  chan.write(new W().i32(7).frame(OP.EXIT, 0));
  const { code } = await Promise.race([exitP, sleep(3000).then(() => ({ code: "timeout" }))]);
  eq(code, 7, "EXIT 7 -> process exit code");
} catch (e) {
  failures++; console.log("  EXCEPTION:", e.stack || e);
  console.log("  stderr from shim:", stderrText);
} finally {
  child.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
