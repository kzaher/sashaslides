#!/usr/bin/env node
// run.mjs — headless (node) driver for a container2wasm/Bochs engine (out.wasm), used as the tier-1
// differential-testing harness of the nanobox engine work.
//
//   node run.mjs <out.wasm> [--cmd "prog args"] [--stdin-file F] [--type "text@ms"]...
//                [--dump-dir DIR] [--timeout SEC] [--quiet] [--clock frozen|real] [--stats]
//                [--oci URL --spec FILE [--oci-cache DIR]]
//                [--checkpoint-out FILE --checkpoint-at LABEL [--checkpoint-gz]] [--checkpoint FILE]
//
// What it does:
//   * runs the engine on a WASI shim (same @bjorn3/browser_wasi_shim the browser page uses),
//     with a *deterministic* host: frozen clock (the guest's `t:` date is always the same and the
//     slowdown timer never sleeps), scripted stdin, no network;
//   * captures the console; whenever the guest prints "@@NANOBOX-DUMP:<label>@@" it snapshots the
//     guest RAM (guest-physical order, honouring Bochs' lazily-allocated block table) and prints a
//     SHA-256 + the exact icount/tick at which the snapshot was taken. Two engines are "identical"
//     when every (label, icount, sha256) triple matches;
//   * reports wall time, guest instructions and MIPS.
//
// The RAM accessors are exported by the nanobox-patched Bochs (nanobox.cc); with the unpatched
// upstream engine dumps are skipped and only timing/console are reported.
//
// Two caches make dev iterations shorter (see "checkpoints" below for the second):
//   --oci-cache DIR    keeps each *decompressed* layer tar as DIR/<digest>.tar (web/oci.js cache hook),
//                      so a run neither fetches nor gunzips the ~100 MB image (2.5 s -> ~0.3 s);
//   --checkpoint-out F --checkpoint-at LABEL   writes the whole engine state (wasm linear memory +
//                      the little JS-side state) at the guest's "@@NANOBOX-DUMP:LABEL@@" marker
//                      (or at --expect with LABEL "expect"); --checkpoint F resumes a later run there.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { WASI, wasi as wasitype, PreopenDirectory, File, Directory } from "@bjorn3/browser_wasi_shim";

const argv = process.argv.slice(2);
if (argv.length === 0) { console.error("usage: run.mjs <out.wasm> [options]"); process.exit(2); }
const opts = { wasm: argv[0], cmd: null, stdinFile: null, type: [], afterExpect: [], ioLog: null, pagesMark: null, dumpDir: null, timeout: 0, quiet: false, clock: "frozen", stats: false, transcript: null, noStdin: false, mounts: [], jit: null, jitDump: null, replies: [], savePhys: [], jitBundle: [], jitBundleOut: null, bundleFiles: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === "--cmd") opts.cmd = v();
  else if (a === "--stdin-file") opts.stdinFile = v();
  else if (a === "--type") opts.type.push(v());
  else if (a === "--after-expect") opts.afterExpect.push(v()); // TEXT@MS — type TEXT, MS ms after --expect fired; --expect then does NOT stop the run (it runs to --timeout)
  else if (a === "--stop-after-expect") opts.stopAfterExpect = Number(v()); // with --after-expect: finish MS ms after --expect fired (deterministic window, unlike the absolute --timeout)
  else if (a === "--io-log") opts.ioLog = v();                 // JSONL of every console/stdin event with {wallMs, icount, ticks}: key injected / stdin byte taken by the engine / guest output chunk
  else if (a === "--pages-mark") opts.pagesMark = v();         // with --pages: also write the page profile at each --after-expect injection, as PREFIX.<n>
  else if (a === "--dump-dir") opts.dumpDir = v();
  else if (a === "--timeout") opts.timeout = Number(v());
  else if (a === "--quiet") opts.quiet = true;
  else if (a === "--clock") opts.clock = v();
  else if (a === "--stats") opts.stats = true;
  else if (a === "--transcript") opts.transcript = v();
  else if (a === "--expect") opts.expect = v();      // stop (with a dump) once the console shows this text (substring)
  else if (a === "--expect-re") opts.expectRe = new RegExp(v(), "i"); // same, regular expression
  else if (a === "--reply") { const r = v(); const eq = r.indexOf("="); opts.replies.push({ re: new RegExp(r.slice(0, eq), "i"), send: JSON.parse('"' + r.slice(eq + 1) + '"'), done: false }); } // REGEX=TEXT: type TEXT once the console matches (onboarding prompts)
  else if (a === "--no-stdin") opts.noStdin = true;
  else if (a === "--mount") opts.mounts.push(v()); // NAME=DIR: DIR's files appear at /NAME in the container (via 9p, deterministic)
  else if (a === "--jit") opts.jit = v();           // LEVEL[:THRESHOLD] — enable the trace JIT (needs a nanobox-patched engine)
  else if (a === "--jit-dump") opts.jitDump = v();  // directory to write every compiled trace module to
  else if (a === "--jit-bundle-out") opts.jitBundleOut = v(); // at exit, write every module the engine installed (bytes, import keys, content keys) as a bundle (web/jit-bundle.js format)
  else if (a === "--jit-bundle") opts.jitBundle.push(...v().split(",").filter(Boolean)); // preload bundle(s): the engine's lookup hook is answered from them (instantiate only, no compile)
  else if (a === "--jit-maxlen") opts.jitMaxlen = v(); // debug: only compile traces up to N instructions
  else if (a === "--jit-region") opts.jitRegion = v(); // max blocks per region (nanobox_set_jit_region; 0/1 = single traces only)
  else if (a === "--dbg") opts.dbg = v();               // MODE:EVERY[:FROM:TO] trace fingerprint log (see nanobox.cc)
  else if (a === "--dbg-out") opts.dbgOut = v();        // file for the fingerprint log
  else if (a === "--no-hash") opts.noHash = true;       // skip RAM hashing at markers (timing runs)
  else if (a === "--save-phys") { const r = v(); const c = r.lastIndexOf(":"); opts.savePhys.push({ addr: Number(r.slice(0, c)), file: r.slice(c + 1) }); } // ADDR:FILE — write the 4 KiB guest-physical page at exit
  else if (a === "--focus") opts.focus = v();           // with --pages: LPAGE_HEX:FILE — per-offset histogram of trace starts inside that linear page
  else if (a === "--dump-start") opts.dumpStart = true;
  else if (a === "--init-only") opts.initOnly = true;     // raw (pre-wizer) module: call wizer.initialize instead of _start, then dump
  else if (a === "--watch") opts.watch = Number(v());     // physical address: report (icount/ticks/RIP) whenever its byte changes (checked at every poll)   // also snapshot RAM before the first instruction (the wizer state)
  else if (a === "--smc") opts.smc = v();               // write the SMC profile (physical page, count, first/last tick, masks) to FILE
  else if (a === "--pages") opts.pages = v();           // write the per-page instruction profile (linear page, count, phys page, flags, traces) to FILE
  else if (a === "--oci") opts.oci = v();               // external-bundle engines: image layout base URL (…/c2w/images/codex/), unpacked
                                                        // in-process (web/oci.js) and served to the guest via the built-in virtio-9p (web/wasifs.js)
  else if (a === "--spec") opts.spec = v();             // with --oci: the OCI runtime spec file (web/images/<image>/config.json)
  else if (a === "--net") opts.net = true;
  else if (a === "--hc-echo") opts.hcEcho = true;      // host channel smoke test: echo guest bytes back
  else if (a === "--nbnode-test") opts.nbnodeTest = true;
  else if (a === "--bundle-file") opts.bundleFiles.push(v()); // NAME=HOSTFILE -> /bundle/NAME in the container (mode 755) // system-node RPC test: drive the guest nbnode shim through the channel
  else if (a === "--hc-log") opts.hcLog = true;              // pass --net=socket (dead link: nothing ever connects); implied by --oci
  else if (a === "--oci-cache") opts.ociCache = v();    // with --oci: directory holding decompressed layer tars (<digest>.tar), filled on first use
  else if (a === "--checkpoint-out") opts.checkpointOut = v(); // write a checkpoint file when the guest reaches --checkpoint-at (JIT must be off)
  else if (a === "--checkpoint-at") opts.checkpointAt = v();   // marker label ("@@NANOBOX-DUMP:LABEL@@") or "expect" (when --expect fires)
  else if (a === "--checkpoint-gz") opts.checkpointGz = true;  // gzip the memory image (32 MiB chunks, level 1); default is a raw write (fastest to load)
  else if (a === "--checkpoint") opts.checkpoint = v();        // resume from a checkpoint file (same engine build, same image/spec/cmd)
  else if (a === "--aot-script") opts.aotScript = v();         // AOT precompilation (tools/aot-precompile.mjs): ESM file whose session({...}) runs INSIDE the engine's poll hook (between traces) once the guest printed the --aot-at marker; the run finishes right after it (bundle written by --jit-bundle-out)
  else if (a === "--aot-args") opts.aotArgs = v();             // JSON passed to session()
  else if (a === "--aot-at") opts.aotAt = v();
  else if (a === "--aot-mode-at") opts.aotModeAt = v();        // switch INTO AOT mode partway through the run: marker label ("@@NANOBOX-DUMP:LABEL@@") or "expect" (when --expect fires). Boot on the trace JIT (one-shot code is cheaper interpreted, TASKS.md R.5), run the session compiled. The switch releases every translation compiled before it (the two modes use different wasm signatures for a compiled function, so they cannot coexist in one table).
  else if (a === "--aot-fnmap") opts.aotFnmap = v();
  else if (a === "--aot-keys") opts.aotKeys = v();
  else if (a === "--tpl-bytes") opts.tplBytes = v();           // where the emitted bytes are: total template bytes per opcode (static, no execution counts needed)             // dump (entry address, content key, blocks) for every region formed — diff offline vs runtime (TASKS.md S.3)           // System.map: function boundaries for the AOT former (region = the containing function)                 // marker label that arms the session (default "aot": the guest prints @@NANOBOX-DUMP:aot@@)
  else { console.error("unknown option " + a); process.exit(2); }
}
if (opts.checkpointOut && !opts.checkpointAt) { console.error("--checkpoint-out needs --checkpoint-at LABEL"); process.exit(2); }
if (opts.checkpointOut && opts.jit) { console.error("--checkpoint-out: record with the JIT off (no --jit): a checkpoint must not hold iCache entries that point at JIT function-table slots"); process.exit(2); }
if (opts.checkpointOut && opts.dbg) { console.error("--checkpoint-out uses the engine's dbg hook slot; it cannot be combined with --dbg"); process.exit(2); }
if (opts.checkpoint && opts.initOnly) { console.error("--checkpoint and --init-only are exclusive"); process.exit(2); }
if ((opts.checkpoint || opts.checkpointOut) && opts.mounts.length) console.error("[harness] WARNING: --mount files are served by the WASI shim, whose open-file state is not part of a checkpoint");

const t0 = performance.now();
const FIXED_EPOCH_NS = 1_700_000_000n * 1_000_000_000n; // 2023-11-14T22:13:20Z, same as bochsrc time0
const wasmBytes = fs.readFileSync(opts.wasm);
await import("../web/jit-bundle.js"); // NanoboxJitBundle: bundle file format + engine tag (shared with the browser host)
const aotMod = opts.aotScript ? await import((await import("node:url")).pathToFileURL(path.resolve(opts.aotScript)).href) : null; // --aot-script
let aotArmed = false, aotDone = false, aotResult = null;
let aotModeArmed = false, aotModeDone = false, aotModeMs = 0, aotModeAtMs = 0;
await import("../web/native/hostchan.js"); // NanoboxHostChan: /dev/hvc1 <-> JS byte stream
await import("../web/native/proto.js"); await import("../web/native/hcring.js"); await import("../web/native/guest.js"); // system-node RPC client
import { Worker } from "worker_threads";
let hostChan = null, hostChanHandler = null;
const args = ["arg0"];
if (opts.noStdin) args.push("--no-stdin");
if (opts.oci || opts.net) args.push("--net=socket=listenfd=9", "--mac", "02:00:00:00:00:01"); // fd 9/10 are served by the netstub below
if (opts.oci) args.push("--external-bundle=9p=virtio:bundle");
if (opts.cmd) args.push(...shellSplit(opts.cmd));
function shellSplit(s) { // minimal quote-aware splitter: "a b" 'c d' e\ f
  const out = []; let cur = "", q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; }
    else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}
const fds = [undefined, undefined, undefined];
for (const m of opts.mounts) {
  const eq = m.indexOf("="); const name = m.slice(0, eq), dir = m.slice(eq + 1);
  const contents = {};
  for (const f of fs.readdirSync(dir)) { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) contents[f] = new File(fs.readFileSync(path.join(dir, f)), {}); }
  const pre = new PreopenDirectory("/" + name, contents);
  pre.dir.contents["."] = pre.dir; // the 9p server walks "." (same hack as c2w's cert dir)
  fds.push(pre);
}
const wasi = new WASI(args, [], fds, { debug: false });
let inst = null;
const mem = () => inst.exports.memory.buffer;

// ---- console ---------------------------------------------------------------------------------
let outBuf = "";           // rolling text for marker detection
const transcript = [];     // everything the guest wrote
const dumps = [];          // {label, icount, ticks, sha256, blocks, wallMs}
let markerCount = 0;
function onGuestOutput(bytes) {
  if (opts.ioLog) ioLog("out", { n: bytes.length, text: Buffer.from(bytes).toString("latin1").slice(0, 160) });
  transcript.push(Buffer.from(bytes));
  if (!opts.quiet) process.stdout.write(Buffer.from(bytes));
  outBuf += Buffer.from(bytes).toString("latin1");
  let m;
  while ((m = /@@NANOBOX-DUMP:([A-Za-z0-9_.-]+)@@/.exec(outBuf))) {
    takeDump(m[1]);
    outBuf = outBuf.slice(m.index + m[0].length);
  }
  // TUIs position every word with escape sequences; match against a de-escaped view
  const plain = outBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./g, " ").replace(/[ \t]+/g, " ");
  for (const r of opts.replies) if (!r.done && r.re.test(plain)) {
    r.done = true; stdinQueue = Buffer.concat([stdinQueue, Buffer.from(r.send)]); outBuf = "";
    console.error(`[harness] REPLY ${r.re} -> ${JSON.stringify(r.send)} at ${(performance.now() - t0).toFixed(1)} ms`);
    return;
  }
  if (!expectSeen && ((opts.expect && plain.includes(opts.expect)) || (opts.expectRe && opts.expectRe.test(plain)))) {
    expectSeen = true;
    takeDump("expect");
    console.error(`[harness] EXPECT ${opts.expect ? JSON.stringify(opts.expect) : opts.expectRe} seen at ${(performance.now() - t0).toFixed(1)} ms`);
    if (opts.afterExpect.length) { expectAtMs = performance.now() - t0; ioLog("expect", {}); } // keep running: the scripted keystrokes come next
    else if (ckpt.armed) ckpt.finishAfter = 0; // the checkpoint lands one trace later (see armCheckpoint); finish() then
    else finish(0);
  }
  if (outBuf.length > 4096) outBuf = outBuf.slice(-4096);
}
let expectSeen = false;
let expectAtMs = null;      // --after-expect: wall time (ms since t0) at which --expect fired

// ---- I/O event log (--io-log) ------------------------------------------------------------------
// Every console/stdin event stamped with wall time AND the guest's own clock (icount/ticks), so a
// keystroke can be isolated: "key" = harness queued the bytes, "poll" = the engine's virtio-console
// rx timer looked at stdin (hit=1 when it found something), "in" = the engine actually read the
// bytes, "out" = the guest wrote to the console.
const ioEvents = [];
function ioLog(kind, extra) {
  if (!opts.ioLog) return;
  const ex = inst && inst.exports;
  const rec = { kind, wallMs: +(performance.now() - t0).toFixed(3) };
  if (ex && ex.nanobox_icount_lo) {
    rec.icount = Number(u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi()));
    rec.ticks = Number(u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi()));
    rec.rip = "0x" + u64(ex.nanobox_rip_lo(), ex.nanobox_rip_hi()).toString(16);
  }
  ioEvents.push(Object.assign(rec, extra));
}

// ---- guest RAM snapshot ----------------------------------------------------------------------
function u64(lo, hi) { return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0); }
function takeDump(label) {
  const ex = inst.exports;
  const wallMs = performance.now() - t0;
  const rec = { label, wallMs: +wallMs.toFixed(1) };
  if (ex.nanobox_icount_lo) {
    rec.icount = u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi()).toString();
    rec.ticks = u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi()).toString();
    rec.rip = "0x" + u64(ex.nanobox_rip_lo(), ex.nanobox_rip_hi()).toString(16);
    if (ex.nanobox_jit_region_stat) rec.regions = { formed: ex.nanobox_jit_region_stat(0), blocks: ex.nanobox_jit_region_stat(1), compiled: ex.nanobox_jit_region_stat(2), cacheHits: ex.nanobox_jit_region_stat(3) };
    if (ex.nanobox_stat) rec.stats = { loops: ex.nanobox_stat(0), longjmps: ex.nanobox_stat(1), traces: ex.nanobox_stat(2), jitTraces: ex.nanobox_stat(3), jitCompiled: ex.nanobox_stat(4), loopbacks: ex.nanobox_stat(5), links: ex.nanobox_stat(6), slow: ex.nanobox_stat(7), linkFail: [8,9,10,11,12,13,14,15].map((i) => ex.nanobox_stat(i)), cache: ex.nanobox_jit_cache_stat ? [ex.nanobox_jit_cache_stat(0), ex.nanobox_jit_cache_stat(1), ex.nanobox_jit_cache_stat(2)] : null };
  }
  // compile volume so far: splits "what the boot cost" from "what the session cost" (the AOT startup
  // work needs both -- a policy that moves the compiles from the boot into the interactive path is
  // not a fix, TASKS.md T)
  rec.jit = { fns: jitState.installed, mb: +(jitState.bytes / 1e6).toFixed(1), compileMs: +jitState.compileMs.toFixed(0) };
  if (ex.nanobox_mem_block_ptr && !opts.noHash) Object.assign(rec, hashGuestRam(opts.dumpDir ? path.join(opts.dumpDir, `${String(markerCount).padStart(3, "0")}-${label}.ram`) : null));
  markerCount++;
  dumps.push(rec);
  console.error(`\n[harness] DUMP ${JSON.stringify(rec)}`);
  if (opts.checkpointOut && label === opts.checkpointAt) armCheckpoint(label);
  if (aotMod && label === (opts.aotAt || "aot")) { aotArmed = true; console.error(`[harness] AOT session armed at marker ${label} (runs at the next poll, between traces)`); }
  if (opts.aotModeAt && !aotModeDone && label === opts.aotModeAt) { aotModeArmed = true; console.error(`[harness] AOT mode armed at marker ${label} (switches at the next poll, between traces)`); }
}
// SHA-256 of all guest RAM in guest-physical order (unallocated blocks hash as zeros), optionally
// written to `file`; also the block map's own hash. Shared by markers and checkpoint verification.
function hashGuestRam(file) {
  const ex = inst.exports;
  const len = ex.nanobox_mem_len(), bs = ex.nanobox_mem_block_size();
  const nblocks = Math.floor(len / bs);
  const heap = new Uint8Array(mem());
  const hash = crypto.createHash("sha256");
  const zeros = new Uint8Array(bs);
  let allocated = 0;
  const map = [];
  let out = file ? fs.openSync(file, "w") : null;
  for (let b = 0; b < nblocks; b++) {
    const p = ex.nanobox_mem_block_ptr(b);
    let chunk;
    if (p) { chunk = heap.subarray(p, p + bs); allocated++; map.push(1); } else { chunk = zeros; map.push(0); }
    hash.update(chunk);
    if (out) fs.writeSync(out, chunk);
  }
  if (out) fs.closeSync(out);
  return { sha256: hash.digest("hex"), blocks: { allocated, total: nblocks, blockSize: bs, mapSha: crypto.createHash("sha256").update(Buffer.from(map)).digest("hex").slice(0, 16) } };
}

// ---- WASI hooks: deterministic host --------------------------------------------------------------
const imp = wasi.wasiImport;
const ERRNO_INVAL = 28, ERRNO_BADF = 8;
let stdinQueue = Buffer.alloc(0);
if (opts.stdinFile) stdinQueue = fs.readFileSync(opts.stdinFile);
const typed = opts.type.map((s) => { const at = s.lastIndexOf("@"); return { text: JSON.parse('"' + s.slice(0, at) + '"'), atMs: Number(s.slice(at + 1)), done: false }; });
const afterTyped = opts.afterExpect.map((s) => { const at = s.lastIndexOf("@"); return { text: JSON.parse('"' + s.slice(0, at) + '"'), atMs: Number(s.slice(at + 1)), done: false }; });
let keyMarks = 0;
function feedTyped() {
  const now = performance.now() - t0;
  for (const t of typed) if (!t.done && now >= t.atMs) { t.done = true; stdinQueue = Buffer.concat([stdinQueue, Buffer.from(t.text, "utf8")]); ioLog("key", { text: t.text }); }
  if (expectAtMs == null) return;
  if (opts.stopAfterExpect && now - expectAtMs >= opts.stopAfterExpect) { console.error(`[harness] STOP at expect+${(now - expectAtMs).toFixed(1)} ms`); finish(0); }
  for (const t of afterTyped) if (!t.done && now - expectAtMs >= t.atMs) {
    t.done = true; stdinQueue = Buffer.concat([stdinQueue, Buffer.from(t.text, "utf8")]);
    ioLog("key", { text: t.text });
    console.error(`[harness] KEY ${JSON.stringify(t.text)} at ${now.toFixed(1)} ms (expect+${(now - expectAtMs).toFixed(1)} ms)`);
    if (opts.pagesMark && opts.pages) writePagesProfile(`${opts.pagesMark}.${keyMarks}`, opts.focus ? `${opts.focus.slice(0, opts.focus.indexOf(":") + 1)}${opts.pagesMark}-focus.${keyMarks}` : null);
    keyMarks++;
  }
}
const shimFdRead = imp.fd_read.bind(imp);
imp.fd_read = (fd, iovs_ptr, iovs_len, nread_ptr) => {
  if (fd !== 0) return shimFdRead(fd, iovs_ptr, iovs_len, nread_ptr); // mounted files (raw-module boots read the disk images this way)
  feedTyped();
  const view = new DataView(mem()), heap = new Uint8Array(mem());
  const iovs = wasitype.Iovec.read_bytes_array(view, iovs_ptr, iovs_len);
  let n = 0;
  for (const io of iovs) {
    if (io.buf_len === 0 || stdinQueue.length === 0) continue;
    const take = Math.min(io.buf_len, stdinQueue.length);
    heap.set(stdinQueue.subarray(0, take), io.buf); stdinQueue = stdinQueue.subarray(take); n += take;
  }
  view.setUint32(nread_ptr, n, true);
  if (n && opts.ioLog) ioLog("in", { n, text: Buffer.from(heap.subarray(iovs[0].buf, iovs[0].buf + n)).toString("latin1") });
  return 0;
};
imp.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
  if (fd !== 1 && fd !== 2) return ERRNO_BADF;
  const view = new DataView(mem()), heap = new Uint8Array(mem());
  const iovs = wasitype.Ciovec.read_bytes_array(view, iovs_ptr, iovs_len);
  let n = 0;
  for (const io of iovs) { if (io.buf_len) { onGuestOutput(heap.slice(io.buf, io.buf + io.buf_len)); n += io.buf_len; } }
  view.setUint32(nwritten_ptr, n, true);
  return 0;
};
let virtualNs = 0n; // frozen clock still advances 1us per query so time never runs backwards
const sleeper = new Int32Array(new SharedArrayBuffer(4));
imp.clock_time_get = (id, precision, time_ptr) => {
  const view = new DataView(mem());
  let ns;
  if (opts.clock === "real") ns = BigInt(Date.now()) * 1_000_000n;
  else { virtualNs += 1000n; ns = FIXED_EPOCH_NS + virtualNs; }
  view.setBigUint64(time_ptr, ns, true);
  return 0;
};
let lastStat = 0;
imp.poll_oneoff = (in_ptr, out_ptr, nsubs, nevents_ptr) => {
  if (nsubs === 0) return ERRNO_INVAL;
  const view = new DataView(mem());
  const subs = [];
  for (let i = 0; i < nsubs; i++) {
    const base = in_ptr + i * 48;
    const userdata = view.getBigUint64(base, true), tag = view.getUint8(base + 8);
    if (tag === 0) subs.push({ userdata, tag, timeout: view.getBigUint64(base + 24, true) });
    else subs.push({ userdata, tag, fd: view.getUint32(base + 16, true) });
  }
  feedTyped();
  const events = [];
  const clock = subs.find((s) => s.tag === 0), rd = subs.find((s) => s.tag === 1 && s.fd === 0);
  if (rd && stdinQueue.length > 0) events.push({ userdata: rd.userdata, type: 1 });
  if (rd && opts.ioLog) ioLog("poll", { hit: events.length ? 1 : 0 });
  if (clock) {
    // Deterministic host: a clock wait never actually sleeps unless we're waiting for scripted stdin.
    if (events.length === 0 && opts.clock === "real" && clock.timeout > 0n) {
      Atomics.wait(sleeper, 0, 0, Number(clock.timeout / 1_000_000n));
    }
    events.push({ userdata: clock.userdata, type: 0 });
  }
  let o = out_ptr;
  for (const e of events) { view.setBigUint64(o, e.userdata, true); view.setUint16(o + 8, 0, true); view.setUint8(o + 10, e.type); view.setBigUint64(o + 16, 0n, true); view.setUint32(o + 24, 0, true); o += 32; }
  view.setUint32(nevents_ptr, events.length, true);
  if (opts.stats) { const now = performance.now(); if (now - lastStat > 5000) { lastStat = now; progress(); } }
  if (opts.watch != null) watchCheck();
  // --aot-mode-at: the switch releases compiled code, so it must run with no JIT frame on the stack.
  // poll_oneoff is reached from Bochs' timer handlers after a trace returned to cpu_loop, which is
  // the same "between traces" point --aot-script uses.
  if (aotModeArmed && !aotModeDone) { aotModeDone = true; aotModeArmed = false; applyAotMode(1); }
  if (aotArmed && !aotDone) {
    // --aot-script: the precompile session runs here, between traces (poll_oneoff is reached from
    // Bochs' timer handlers after a trace returned to cpu_loop), then the run ends: the modules the
    // engine installed during the session are in jitState.records for --jit-bundle-out
    aotDone = true;
    // the guest's output so far is handed to the session directly: --transcript is only written when
    // the run ends, and a session that needs to read what the guest printed (a user program's own
    // /proc map, to learn where its text landed) runs while the run is still going
    try { aotResult = aotMod.session({ inst, exports: inst.exports, memory: mem, args: opts.aotArgs ? JSON.parse(opts.aotArgs) : {}, jitState, engineTag, transcript: Buffer.concat(transcript).toString("latin1"), log: (m) => console.error(m) }); }
    catch (e) { console.error("[harness] AOT session failed:", e && e.stack || e); aotResult = { error: String(e && e.message || e) }; }
    finish(aotResult && aotResult.error ? 3 : 0);
  }
  // --timeout: the VM loop never yields, so a JS timer cannot fire; check the clock here instead
  if (opts.timeout && performance.now() - t0 > opts.timeout * 1000) { console.error("[harness] timeout"); finish(124); }
  return 0;
};
let watchLast = null;
function watchCheck() {
  const ex = inst.exports; const bs = ex.nanobox_mem_block_size(); const ptr = ex.nanobox_mem_block_ptr(Math.floor(opts.watch / bs));
  const v = ptr ? new Uint8Array(ex.memory.buffer)[ptr + (opts.watch % bs)] : 0;
  if (v !== watchLast) {
    watchLast = v;
    console.error(`[harness] WATCH 0x${opts.watch.toString(16)} = 0x${v.toString(16)} at icount=${u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi())} ticks=${u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi())} rip=0x${u64(ex.nanobox_rip_lo(), ex.nanobox_rip_hi()).toString(16)}`);
  }
}
for (const name of ["sock_accept", "sock_recv", "sock_send"]) imp[name] = () => ERRNO_BADF;
function progress() {
  const ex = inst.exports; if (!ex.nanobox_icount_lo) return;
  const ic = u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi());
  const s = (performance.now() - t0) / 1000;
  console.error(`[harness] t=${s.toFixed(1)}s icount=${ic} (${(Number(ic) / 1e6 / s).toFixed(1)} MIPS avg)` + (bundleFs ? ` fs=${JSON.stringify(bundleFs.stats)}` : "") + (netStub ? ` net=${JSON.stringify(netStub.stats)}` : ""));
}

// ---- JIT host: instantiate the trace modules the engine emits ------------------------------------
// The engine calls three hooks through function-table slots (see nanobox_jit.cc). We drop small
// wasm trampolines into those slots that forward to the JS functions below.
function trampoline(params, results, jsfn) {
  // (module (import "js" "f" (func $f T)) (func (export "f") T (local.get ...) (call $f)))
  const b = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  const vec = (arr) => [arr.length, ...arr];
  const type = [0x60, ...vec(params), ...vec(results)];
  const sec = (id, content) => [id, ...uleb(content.length), ...content];
  const body = [...params.flatMap((_, i) => [0x20, i]), 0x10, 0x00, 0x0b];
  const bytes = new Uint8Array([
    ...b,
    ...sec(1, [1, ...type]),
    ...sec(2, [1, 2, 0x6a, 0x73, 1, 0x66, 0x00, 0]),
    ...sec(3, [1, 0]),
    ...sec(7, [1, 1, 0x66, 0x00, 1]),
    ...sec(10, [1, ...uleb(body.length + 1), 0, ...body]),
  ]);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { js: { f: jsfn } }).exports.f;
}
function uleb(v) { const out = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; out.push(x); } while (v); return out; }
const jitState = { table: null, memory: null, fns: new Map(), free: [], installed: 0, released: 0, bytes: 0, compileMs: 0, tableMs: 0,
  // bundle support (see web/jit-bundle.js for the file format and the link-function story)
  records: [],            // every module the engine installed this run (slot 0 / slot 5), kept until exit for --jit-bundle-out
  fnRecord: new Map(),    // table index -> { rec, i }: which record/export a live slot came from (note() attaches the content key there)
  link: null,             // { slot, rec, inst }: the engine's shared link function, pinned (see pinLink); never released
  linkReuse: 0,           // installs answered with the pinned link slot (byte-identical re-installs after cache clears)
  batches: 0,             // slot-5 (multi-function module) installs
  bundle: new Map(),      // content key string -> { mod, keys, funcKeys, inst, fail } (preloaded, instantiated lazily)
  bundleLink: null,       // { mod, keys, bytes, slot } from the bundle, pinned in installJitHost
  bundleFns: new Map(),   // content key string -> table index (instantiated bundle functions; permanent slots)
  bundleSlots: new Set(), // table indices owned by bundle functions (release/releaseAll leave them alone)
  bundleHits: 0, bundleMisses: 0, bundleInst: 0, bundleModules: 0, bundleFiles: 0, bundleInstMs: 0, bundleLoadMs: 0, bundleCompiled: 0 };
const engineTag = NanoboxJitBundle.engineTagFormat(wasmBytes.length, crypto.createHash("sha256").update(NanoboxJitBundle.engineTagInput(wasmBytes)).digest("hex"));
// --jit-bundle: parse the index before the VM starts; a module is COMPILED and instantiated on the
// first lookup of one of its keys. Compiling every module up front is what made an AOT artifact
// unusable: the whole-kernel bundle is 2,329 batch modules / 580 MB, and a codex boot touches a few
// hundred of them -- paying V8 for all of it before the guest runs cost more than the compiling it
// was meant to save (TASKS.md R.2). With NANOBOX_BUNDLE_EAGER=1 the old behaviour is back for A/B. A bundle from another engine build is refused (its import keys / hook ABI
// need not match): warn and ignore it.
async function preloadBundles(files) {
  const t = performance.now();
  for (const f of files) {
    let b;
    try { b = NanoboxJitBundle.decode(fs.readFileSync(f)); }
    catch (e) { console.error(`[harness] JIT bundle ${f}: unreadable (${e.message}), ignored`); continue; }
    if (b.tag !== engineTag) { console.error(`[harness] JIT bundle ${f}: engine tag ${b.tag} != ${engineTag} (different engine build), ignored`); continue; }
    if (b.linkSlot && jitState.bundleLink && jitState.bundleLink.slot !== b.linkSlot) { console.error(`[harness] JIT bundle ${f}: link slot ${b.linkSlot} != ${jitState.bundleLink.slot} of an earlier bundle, ignored`); continue; }
    jitState.bundleFiles++;
    const eager = process.env.NANOBOX_BUNDLE_EAGER === "1";
    const mods = eager
      ? await Promise.all(b.modules.map((m) => WebAssembly.compile(m.bytes).catch((e) => { console.error(`[harness] JIT bundle ${f}: module rejected: ${e.message}`); return null; })))
      : b.modules.map(() => null);   // compiled on first use, in lookup()
    let dup = 0;
    for (let i = 0; i < b.modules.length; i++) {
      if (eager && !mods[i]) continue;
      const m = b.modules[i];
      if (m.funcKeys.length === 1 && NanoboxJitBundle.isLinkKey(...m.funcKeys[0])) {
        // the shared link function: same bytes in every bundle of this build; keep the first
        // the link function is pinned at a fixed table slot before the engine starts, so its module
        // is the one that must be compiled eagerly even in lazy mode
        if (!jitState.bundleLink) { let lm = mods[i]; try { if (!lm) lm = new WebAssembly.Module(m.bytes); } catch (e) { console.error(`[harness] JIT bundle ${f}: link module rejected: ${e.message}`); lm = null; }
          if (lm) jitState.bundleLink = { mod: lm, keys: m.keys, bytes: m.bytes, slot: b.linkSlot }; }
        continue;
      }
      const entry = { mod: mods[i], bytes: m.bytes, keys: m.keys, funcKeys: m.funcKeys, inst: null, fail: false };
      let used = false;
      for (const [lo, hi] of m.funcKeys) {
        if (!lo && !hi) continue;
        const ks = NanoboxJitBundle.keyString(lo, hi);
        if (jitState.bundle.has(ks)) { dup++; continue; } // first bundle wins (kernel bundle before image bundle)
        jitState.bundle.set(ks, entry); used = true;
      }
      if (used) jitState.bundleModules++;
    }
    console.error(`[harness] JIT bundle ${f}: ${b.modules.length} modules, ${jitState.bundle.size} keys${dup ? ` (${dup} duplicate keys skipped)` : ""}${b.linkSlot ? `, link fn @${b.linkSlot}` : ""}`);
  }
  jitState.bundleLoadMs = performance.now() - t;
}
function installJitHost(inst) {
  const ex = inst.exports;
  if (!ex.nanobox_hook_slot || !ex.__indirect_function_table) return;
  const table = ex.__indirect_function_table, memory = ex.memory;
  jitState.table = table; jitState.memory = memory;
  const allocSlot = () => {
    // slots: grow the table in big chunks (per-call table.grow is O(table size) in V8)
    if (!jitState.free.length) { const base = table.grow(65536); for (let k = 65535; k >= 0; k--) jitState.free.push(base + k); }
    return jitState.free.pop();
  };
  const imports = (keys) => {
    const h = {}; for (let i = 0; i < keys.length; i++) h[String(i)] = table.get(keys[i]);
    return { e: { m: memory, t: table }, h };
  };
  // The engine's shared link function (every trace tail-calls it through a table index baked into
  // the module) must sit at the same slot in every run for bundles to be position independent —
  // see jit-bundle.js. It is the first thing the engine installs, so pinning "the first install" at
  // the first free slot (= the table's initial length, a build constant) is deterministic; a bundle
  // records that slot + the module and the replaying host pins it from the bundle before the engine
  // starts. Byte-identical re-installs (the engine drops it on every cache clear) get the pinned
  // slot back; the pinned slot is never released.
  const pinLink = (rec, inst, want) => {
    const slot = allocSlot();
    if (want && slot !== want) { jitState.free.push(slot); return 0; }
    table.set(slot, inst.exports.r);
    jitState.link = { slot, rec, inst };
    return slot;
  };
  if (jitState.bundleLink) {
    const bl = jitState.bundleLink;
    let ok = 0;
    try { ok = pinLink({ bytes: bl.bytes, keys: bl.keys, funcKeys: [NanoboxJitBundle.LINK_KEY.slice()] }, new WebAssembly.Instance(bl.mod, imports(bl.keys)), bl.slot); }
    catch (e) { console.error("[harness] JIT bundle link module failed to instantiate:", e.message); }
    if (!ok) { console.error(`[harness] JIT bundle: cannot pin the link function at slot ${bl.slot} (table length ${table.length}); bundle disabled`); jitState.bundle.clear(); jitState.bundleModules = 0; }
    else console.error(`[harness] JIT bundle: link function pinned at slot ${ok}`);
  }
  // slot 0 / slot 5 share this: instantiate the module at [ptr,len) with imports h.i = table[keys[i]],
  // put its function exports (names[]) into fresh slots, remember bytes+keys for --jit-bundle-out
  const instantiate = (ptr, len, keysPtr, n, names) => {
    const bytes = new Uint8Array(memory.buffer, ptr, len).slice();
    const keys = new Uint32Array(memory.buffer, keysPtr, n).slice();
    if (jitState.link && names.length === 1 && NanoboxJitBundle.sameBytes(bytes, jitState.link.rec.bytes)) { jitState.linkReuse++; return [jitState.link.slot]; }
    let ins;
    const tc0 = performance.now();
    try {
      const mod = new WebAssembly.Module(bytes);
      ins = new WebAssembly.Instance(mod, imports(keys));
      jitState.compileMs += performance.now() - tc0;
    } catch (err) {
      console.error("[harness] JIT module rejected:", err.message);
      if (opts.jitDump) fs.writeFileSync(path.join(opts.jitDump, `bad-${jitState.installed}.wasm`), bytes);
      return null;
    }
    const rec = { bytes, keys, funcKeys: names.map(() => [0, 0]) };
    jitState.records.push(rec);
    jitState.installed += names.length; jitState.bytes += len;
    if (opts.jitDump) fs.writeFileSync(path.join(opts.jitDump, `t${String(jitState.installed).padStart(6, "0")}.wasm`), bytes);
    if (!jitState.link && names.length === 1 && jitState.records.length === 1) {
      // first install of the run: the link function (verified at exit: it never gets a note())
      const slot = pinLink(rec, ins, 0);
      jitState.fnRecord.set(slot, { rec, i: 0 });
      return [slot];
    }
    const idxs = [];
    const ts0 = performance.now();
    for (let i = 0; i < names.length; i++) {
      const f = ins.exports[names[i]];
      if (typeof f !== "function") { console.error(`[harness] JIT module has no export ${names[i]}`); for (const idx of idxs) { table.set(idx, null); jitState.free.push(idx); jitState.fns.delete(idx); jitState.fnRecord.delete(idx); } return null; }
      const idx = allocSlot();
      table.set(idx, f);
      jitState.fns.set(idx, ins);
      jitState.fnRecord.set(idx, { rec, i });
      idxs.push(idx);
    }
    jitState.tableMs += performance.now() - ts0;
    return idxs;
  };
  const install = (ptr, len, keysPtr, n) => { const r = instantiate(ptr, len, keysPtr, n, ["r"]); return r ? r[0] : 0; };
  const installBatch = (ptr, len, keysPtr, n, nfuncs, outPtr) => {
    if (len === 0 && nfuncs === 0) return 1; // capability probe: the placeholder answers 0, a host 1
    const names = []; for (let i = 0; i < nfuncs; i++) names.push("f" + i);
    const r = instantiate(ptr, len, keysPtr, n, names);
    if (!r) return 0;
    const dv = new DataView(memory.buffer); for (let i = 0; i < nfuncs; i++) dv.setUint32(outPtr + 4 * i, r[i], true);
    jitState.batches++;
    return 1;
  };
  // release: bundle slots and the link slot are permanent (a released one may be looked up again a
  // moment later, and there is nothing to free — the instance stays alive anyway); released engine
  // modules keep their record (bytes + keys) so --jit-bundle-out still dumps them, only the slot is recycled.
  const release = (idx) => { if (jitState.fns.delete(idx)) { table.set(idx, null); jitState.free.push(idx); jitState.released++; jitState.fnRecord.delete(idx); } };
  const releaseAll = () => { for (const idx of jitState.fns.keys()) { table.set(idx, null); jitState.free.push(idx); jitState.released++; jitState.fnRecord.delete(idx); } jitState.fns.clear(); };
  // note(fn, keyLo, keyHi): the engine's content key for a just-installed function -> into its record
  // (LINK_KEY: the engine tells us explicitly which slot is the link function)
  const note = (fn, lo, hi) => {
    const r = jitState.fnRecord.get(fn); if (!r) return;
    r.rec.funcKeys[r.i] = [lo >>> 0, hi >>> 0];
    if (NanoboxJitBundle.isLinkKey(lo, hi) && !(jitState.link && jitState.link.slot === fn)) { jitState.link = { slot: fn, rec: r.rec, inst: jitState.fns.get(fn) }; jitState.fns.delete(fn); } // explicit: permanent from now on
  };
  // lookup(keyLo, keyHi): pre-computed translation? Instantiating a bundle module binds ALL its
  // exports (a batch module holds many regions) and registers every key, so later lookups of its
  // siblings are plain map hits.
  const lookup = (lo, hi) => {
    if (NanoboxJitBundle.isLinkKey(lo, hi)) return jitState.link ? jitState.link.slot : 0;
    const ks = NanoboxJitBundle.keyString(lo, hi);
    let idx = jitState.bundleFns.get(ks);
    if (idx === undefined) {
      const entry = jitState.bundle.get(ks);
      if (entry && !entry.inst && !entry.fail) {
        const t = performance.now();
        try {
          if (!entry.mod) { entry.mod = new WebAssembly.Module(entry.bytes); jitState.bundleCompiled++; }
          entry.inst = new WebAssembly.Instance(entry.mod, imports(entry.keys));
        } catch (err) {
          entry.fail = true; console.error("[harness] JIT bundle module failed to instantiate:", err.message);
        }
        if (entry.inst) {
          const names = WebAssembly.Module.exports(entry.mod).filter((e) => e.kind === "function").map((e) => e.name);
          for (let i = 0; i < names.length && i < entry.funcKeys.length; i++) {
            const [flo, fhi] = entry.funcKeys[i];
            if (!flo && !fhi) continue;
            const fks = NanoboxJitBundle.keyString(flo, fhi);
            if (jitState.bundleFns.has(fks)) continue; // key served by an earlier module already
            const s = allocSlot();
            table.set(s, entry.inst.exports[names[i]]);
            jitState.bundleSlots.add(s); jitState.bundleFns.set(fks, s);
          }
          jitState.bundleInst++;
        }
        jitState.bundleInstMs += performance.now() - t;
        idx = jitState.bundleFns.get(ks);
      }
    }
    if (idx === undefined) { jitState.bundleMisses++; return 0; }
    jitState.bundleHits++;
    return idx;
  };
  if (ex.nanobox_dbg_hook_slot && opts.checkpointOut) {
    // checkpoint capture point: the hook runs between traces (see "checkpoints" below); armed by takeDump
    table.set(ex.nanobox_dbg_hook_slot(), trampoline([0x7f, 0x7f], [], () => { if (ckpt.armed) writeCheckpoint(); }));
  }
  if (ex.nanobox_dbg_hook_slot && opts.dbg) {
    const out = fs.openSync(opts.dbgOut || "dbg.log", "w");
    const chunks = []; let pending = 0;
    const flush = () => { if (chunks.length) { fs.writeSync(out, Buffer.concat(chunks)); chunks.length = 0; pending = 0; } };
    table.set(ex.nanobox_dbg_hook_slot(), trampoline([0x7f, 0x7f], [], (p, len) => {
      chunks.push(Buffer.from(new Uint8Array(memory.buffer, p, len))); pending += len; if (pending > 1 << 20) flush();
    }));
    process.on("exit", flush);
    const [mode, every, from, to] = opts.dbg.split(":").map(Number);
    ex.nanobox_dbg_set(mode, every || 100000, from || 0, to || 0);
    console.error(`[harness] dbg mode ${mode} every=${every || 100000} range=[${from || 0},${to || 0})`);
  }
  table.set(ex.nanobox_hook_slot(0), trampoline([0x7f, 0x7f, 0x7f, 0x7f], [0x7f], install));
  table.set(ex.nanobox_hook_slot(1), trampoline([0x7f], [], release));
  table.set(ex.nanobox_hook_slot(2), trampoline([], [], releaseAll));
  // slots 3..5 exist only in engines with the bundle hooks (nanobox_hook_slot returns 0 otherwise)
  if (ex.nanobox_hook_slot(3)) table.set(ex.nanobox_hook_slot(3), trampoline([0x7f, 0x7f], [0x7f], lookup));
  if (ex.nanobox_hook_slot(4)) table.set(ex.nanobox_hook_slot(4), trampoline([0x7f, 0x7f, 0x7f], [], note));
  if (ex.nanobox_hook_slot(5)) table.set(ex.nanobox_hook_slot(5), trampoline([0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f], [0x7f], installBatch));
  if (opts.jitBundle.length && !ex.nanobox_hook_slot(3)) console.error("[harness] WARNING: this engine has no lookup hook (slot 3); --jit-bundle has no effect");
  // host channel (/dev/hvc1 in the guest): --hc-echo echoes guest bytes back (device smoke test)
  hostChan = globalThis.NanoboxHostChan ? NanoboxHostChan.attach(inst, table, trampoline) : null;
  if (hostChan) {
    if (opts.nbnodeTest) {
      // the runtime side lives in a worker thread (this thread never yields to its event loop while
      // the VM runs); host->guest bytes come through the shared ring read by the engine's hook
      const ring = NanoboxHcRing.create(1 << 20); const rr = NanoboxHcRing.reader(ring.sab);
      table.set(ex.nanobox_hc_hook_slot(1), trampoline([0x7f, 0x7f], [0x7f], (ptr, max) => { const b = rr.read(max); if (!b) return 0; new Uint8Array(mem()).set(b, ptr); return b.length; }));
      const inRing = NanoboxHcRing.create(4 << 20); const inW = NanoboxHcRing.writer(inRing.sab);
      const w = new Worker(new URL("./nbnode-test-worker.mjs", import.meta.url), { workerData: { ringSab: ring.sab, inSab: inRing.sab } });
      w.on("error", (e) => console.error("[nbnode-test] worker error " + (e && e.stack || e)));
      hostChanHandler = (b) => inW.write(b);   // guest -> host through the SAB ring (sync-capable, like the browser)
    }
    let hcIn = 0;
    hostChan.onData = (b) => {
      hcIn += b.length;
      const txt = new TextDecoder().decode(b);
      if (opts.hcEcho) { const m = /^bench (\d+)\n/.exec(txt); if (m) { const n = Number(m[1]); const chunk = new Uint8Array(65536).fill(66); for (let s = 0; s < n; s += chunk.length) hostChan.send(s + chunk.length <= n ? chunk : chunk.subarray(0, n - s)); console.error(`[hc] bench: queued ${n} bytes for the guest`); } else hostChan.send(b); }
      if (opts.hcLog) console.error("[hc] guest->host " + b.length + " bytes (total " + hcIn + "): " + JSON.stringify(txt.slice(0, 80)));
      if (hostChanHandler) hostChanHandler(b);
    };
  }
  if (opts.jit) {
    const [lvl, thr] = opts.jit.split(":");
    ex.nanobox_set_jit(Number(lvl), Number(thr || 0));
    if (process.env.NANOBOX_JIT_EAGER && ex.nanobox_set_jit_eager) { ex.nanobox_set_jit_eager(1); console.error("[harness] JIT page-eager sweep on (recording mode)"); }
    if (process.env.NANOBOX_LINKDIRECT && ex.nanobox_set_jit_linkdirect) { ex.nanobox_set_jit_linkdirect(1); console.error("[harness] JIT link hop: direct return_call to an import"); }
    if (process.env.NANOBOX_JIT_MERGE && ex.nanobox_set_jit_merge) { ex.nanobox_set_jit_merge(1); console.error("[harness] JIT merged push/pop runs on"); }
    if (process.env.NANOBOX_JIT_PROBE2 === "0" && ex.nanobox_set_jit_probe2) { ex.nanobox_set_jit_probe2(0); console.error("[harness] JIT two-entry probe cache OFF (A/B)"); }
    if (process.env.NANOBOX_OUTLINE != null && ex.nanobox_set_jit_outline) { ex.nanobox_set_jit_outline(Number(process.env.NANOBOX_OUTLINE)); console.error(`[harness] JIT outline mask ${process.env.NANOBOX_OUTLINE}`); }
    if (opts.jitMaxlen && ex.nanobox_set_jit_maxlen) ex.nanobox_set_jit_maxlen(Number(opts.jitMaxlen));
    if (opts.jitRegion != null && ex.nanobox_set_jit_region) ex.nanobox_set_jit_region(Number(opts.jitRegion));
    // AOT mode (TASKS.md R): NANOBOX_AOT=1 -> function-scope static regions, compile on first touch, relaxed
    // boundaries, direct conditions; identity with the reference engine is NOT expected in this mode.
    // NANOBOX_FLAGS=mask overrides nanobox_jit_flags afterwards (A/B of the direct-condition bits etc.)
    // --aot-mode-at: boot on the trace JIT and switch into AOT mode at a marker (see applyAotMode)
    if (opts.aotModeAt) console.error(`[harness] AOT mode DEFERRED to marker ${opts.aotModeAt} (booting on the trace JIT)`);
    else if (process.env.NANOBOX_AOT != null && ex.nanobox_set_jit_aot) { ex.nanobox_set_jit_aot(Number(process.env.NANOBOX_AOT)); console.error(`[harness] JIT AOT mode ${process.env.NANOBOX_AOT}`); }
    if (process.env.NANOBOX_FLAGS != null && ex.nanobox_set_jit_flags) { ex.nanobox_set_jit_flags(Number(process.env.NANOBOX_FLAGS)); console.error(`[harness] JIT flags mask ${process.env.NANOBOX_FLAGS}`); }
    // AOT mode sets threshold 1 (compile at the first touch); the offline translators need the
    // opposite -- the JIT on so the session can drive it, but the BOOT compiling nothing, or the
    // artifact ends up holding a recording of that boot instead of the precompiled code.
    // --aot-fnmap: guest function boundaries (System.map). Under AOT the engine roots a region at the
    // containing function instead of at the block the guest entered, so the regions it forms are the
    // ones the offline translator built and a precompiled artifact can actually match (TASKS.md S.3).
    if (opts.aotFnmap && ex.nanobox_aot_fnmap_add) {
      const text = fs.readFileSync(opts.aotFnmap, "utf8");
      const at = (n) => { const m = new RegExp("^([0-9a-f]{16}) [A-Za-z] " + n + "$", "m").exec(text); return m ? BigInt("0x" + m[1]) : null; };
      const stext = at("_stext") || at("_text"), etext = at("_etext");
      const addrs = [];
      for (const line of text.split("\n")) {
        const m = /^([0-9a-f]{16}) [tTwW] /.exec(line);
        if (!m) continue;
        const a = BigInt("0x" + m[1]);
        if (stext && (a < stext || a >= etext)) continue;
        addrs.push(a);
      }
      addrs.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      ex.nanobox_aot_fnmap_reset();
      let prev = -1n;
      for (const a of addrs) { if (a === prev) continue; prev = a; ex.nanobox_aot_fnmap_add(Number(a & 0xffffffffn) >>> 0, Number(a >> 32n) >>> 0); }
      console.error(`[harness] AOT function map: ${ex.nanobox_aot_fnmap_count()} functions from ${path.basename(opts.aotFnmap)}`);
    }
    if (opts.aotKeys && ex.nanobox_keylog_enable) ex.nanobox_keylog_enable(1);
    if (process.env.NANOBOX_THRESHOLD != null && ex.nanobox_set_jit) { ex.nanobox_set_jit(lvl, Number(process.env.NANOBOX_THRESHOLD)); console.error(`[harness] JIT threshold ${process.env.NANOBOX_THRESHOLD} (after AOT mode)`); }
    // AOT-from-boot: NANOBOX_AOT_THRESHOLD is the AOT-mode threshold (the deferred switch applies the
    // same variable at the switch, leaving the trace-JIT boot on the ordinary one)
    if (!opts.aotModeAt && Number(process.env.NANOBOX_AOT || 0) && process.env.NANOBOX_AOT_THRESHOLD != null) {
      if (ex.nanobox_set_jit_aot_threshold) ex.nanobox_set_jit_aot_threshold(Number(process.env.NANOBOX_AOT_THRESHOLD));
      else ex.nanobox_set_jit(lvl, Number(process.env.NANOBOX_AOT_THRESHOLD));
      console.error(`[harness] AOT threshold ${process.env.NANOBOX_AOT_THRESHOLD}`);
    }
    // AOT-mode formation knobs (A/B of the region former: successors that join a region)
    for (const [env, fn, what] of [["NANOBOX_AOT_DETFORM", "nanobox_set_jit_aot_detform", "deterministic formation: the region depends on the code bytes only"],
                                   ["NANOBOX_AOT_SWEEP", "nanobox_set_jit_aot_sweep", "detform: build the whole containing function at a first touch"],
                                   ["NANOBOX_AOT_POOLRESET", "nanobox_set_jit_aot_poolreset", "offline sweeps: reset the iCache instruction pool between functions"],
                                   ["NANOBOX_AOT_DEDUPE", "nanobox_set_jit_aot_dedupe", "successor already translated elsewhere is NOT copied in"],
                                   ["NANOBOX_AOT_MINHOT", "nanobox_set_jit_aot_minhot", "successor joins only above this execution count"],
                                   ["NANOBOX_AOT_AHEAD", "nanobox_set_jit_aot_ahead", "decode successors that are not in the iCache yet"],
                                   ["NANOBOX_AOT_TICK", "nanobox_set_jit_aot_tick", "iterations between full syncs on a self-loop back edge"],
                                   ["NANOBOX_AOT_NOSTACK", "nanobox_set_jit_aot_nostack", "CALL/RET keep the return address on a host shadow stack, nothing is written to the emulated stack"]]) {
      if (process.env[env] != null && ex[fn]) { ex[fn](Number(process.env[env])); console.error(`[harness] AOT former: ${env}=${process.env[env]} (${what})`); }
    }
    if (opts.jitDump) fs.mkdirSync(opts.jitDump, { recursive: true });
    console.error(`[harness] JIT enabled: level=${lvl} threshold=${thr || "default"}`);
  }
}
// --aot-mode-at: turn AOT mode on partway through a run (harness `--aot-mode-at expect|LABEL`).
// TASKS.md R.5: a boot is millions of ONE-SHOT trace entries and a compiled entry costs ~400 ns more
// than interpreting one, so the trace JIT's threshold is what makes a boot fast; AOT's win is the
// steady state. Booting on the trace JIT and switching afterwards keeps both. The engine releases
// everything compiled before the switch (nanobox_set_jit_aot -> nanobox_jit_cache_clear on a mode
// change): a compiled function's wasm signature differs between the modes (bit 9 passes rip/ic0 as
// parameters), so pre-switch and post-switch code cannot share one function table.
function applyAotMode(on) {
  const ex = inst.exports;
  if (!ex.nanobox_set_jit_aot) { console.error("[harness] AOT mode: engine has no nanobox_set_jit_aot"); return; }
  const t = performance.now();
  ex.nanobox_set_jit_aot(on);
  if (process.env.NANOBOX_FLAGS != null && ex.nanobox_set_jit_flags) ex.nanobox_set_jit_flags(Number(process.env.NANOBOX_FLAGS));
  // NANOBOX_AOT_THRESHOLD applies ONLY from the switch on (NANOBOX_THRESHOLD is the whole run's, and
  // setting that also changes the trace-JIT boot). AOT sets threshold 1 = compile at the first touch,
  // which is what puts a synchronous region compile in front of every newly reached code path.
  const aotThr = process.env.NANOBOX_AOT_THRESHOLD != null ? process.env.NANOBOX_AOT_THRESHOLD : process.env.NANOBOX_THRESHOLD;
  if (on && aotThr != null) {
    if (ex.nanobox_set_jit_aot_threshold) ex.nanobox_set_jit_aot_threshold(Number(aotThr));
    else if (ex.nanobox_set_jit) ex.nanobox_set_jit(Number((opts.jit || "2:0").split(":")[0]), Number(aotThr));
  }
  for (const [env, fn] of [["NANOBOX_AOT_DETFORM", "nanobox_set_jit_aot_detform"], ["NANOBOX_AOT_SWEEP", "nanobox_set_jit_aot_sweep"],
                           ["NANOBOX_AOT_DEDUPE", "nanobox_set_jit_aot_dedupe"], ["NANOBOX_AOT_MINHOT", "nanobox_set_jit_aot_minhot"],
                           ["NANOBOX_AOT_AHEAD", "nanobox_set_jit_aot_ahead"], ["NANOBOX_AOT_TICK", "nanobox_set_jit_aot_tick"],
                           ["NANOBOX_AOT_NOSTACK", "nanobox_set_jit_aot_nostack"]])
    if (process.env[env] != null && ex[fn]) ex[fn](Number(process.env[env]));
  aotModeMs = performance.now() - t;
  aotModeAtMs = performance.now() - t0;
  console.error(`[harness] AOT MODE ON at ${aotModeAtMs.toFixed(0)} ms (switch itself ${aotModeMs.toFixed(1)} ms; translations released and recompiled from here)`);
}

// --jit-bundle-out: every module the engine installed this run whose content key(s) were noted
// (released ones included: the slot was recycled, the record was not), plus the link module.
function writeBundle(file) {
  let link = jitState.link, linkSlot = 0;
  if (link) {
    // the pinned first install is the link function only if the engine never noted a real key for it
    const k = link.rec.funcKeys[0];
    if (!k[0] && !k[1]) { link.rec.funcKeys[0] = NanoboxJitBundle.LINK_KEY.slice(); linkSlot = link.slot; }
    else if (NanoboxJitBundle.isLinkKey(k[0], k[1])) linkSlot = link.slot;
    else console.error(`[harness] JIT bundle: first installed module got a content key (${k}); no link function recorded`);
  }
  const recs = jitState.records.filter((r) => r.funcKeys.some(([lo, hi]) => lo || hi));
  if (linkSlot && !recs.includes(link.rec)) recs.unshift(link.rec); // link fn pinned from a preloaded bundle: carry it over
  const bytes = NanoboxJitBundle.encode(recs, engineTag, linkSlot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  console.error(`[harness] JIT bundle written: ${file} (${recs.length} modules, ${(bytes.length / 1e6).toFixed(2)} MB, engine ${engineTag}${linkSlot ? `, link fn @${linkSlot}` : ""})`);
  return recs.length;
}

// ---- checkpoints ---------------------------------------------------------------------------------
// The engine's whole state (CPU, devices, guest RAM, timers, 9p server, iCache) lives in the wasm
// linear memory; the JS side keeps only the wasifs fd table, the netstub queues and this file's
// console state. A checkpoint = header JSON + the raw memory. Restore = grow a fresh instance's
// memory to that size, copy the bytes in, put the JS state back and call _start as usual: in the
// wizer'd engine _start is wizer.resume -> main() -> init_vm -> bxmain, and with vm_init_done (in the
// restored memory) that goes straight to bx_begin_simulation -> cpu_loop, which resumes the guest
// from the restored CPU state.
//
// WHERE the memory is captured matters. The marker is seen inside fd_write, i.e. in the middle of a
// guest instruction (virtio-console notify -> device_recv -> fwrite): the C++ continuation (used-ring
// update, IRQ, icount/tick accounting) is on the wasm stack, which no restore can rebuild. So the
// marker only ARMS the checkpoint; the memory is captured at the next trace boundary, from the
// engine's dbg hook (nanobox_dbg_trace runs after every trace, post BX_SYNC_TIME, with the JIT
// off): at that point every device/timer/instruction side effect is committed and cpu_loop's own
// state between traces is nothing but "fetch the next trace" — exactly what a fresh cpu_loop does.
// The dbg mode is switched off again before the memory is written, so neither the recording run
// nor the restored image logs fingerprints.
const CKPT_MAGIC = "NBCKPT1\n", CKPT_VERSION = 1, CKPT_CHUNK = 32 << 20, CKPT_HDR_ALIGN = 4096;
const ckpt = { armed: false, label: null, finishAfter: null, written: null, restored: null };
function armCheckpoint(label) {
  const ex = inst.exports;
  if (ckpt.written || ckpt.armed) return;
  if (!ex.nanobox_dbg_hook_slot || !ex.nanobox_dbg_set) { console.error("[harness] checkpoint: engine has no dbg hook (nanobox_dbg_hook_slot); cannot record"); return; }
  ckpt.armed = true; ckpt.label = label;
  ex.nanobox_dbg_set(1, 1, 0, 0); // mode 1, every=1: the hook fires after the very next trace
}
const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
const unb64 = (str) => new Uint8Array(Buffer.from(str, "base64"));
const expectKey = () => (opts.expect != null ? "s:" + opts.expect : opts.expectRe ? "r:" + opts.expectRe.source : null);
function consoleSnapshot() {
  return { outBuf, stdinQueue: b64(stdinQueue), transcript: b64(Buffer.concat(transcript)), markerCount, expectSeen, expect: expectKey(),
    replies: opts.replies.map((r) => ({ re: r.re.source, done: r.done })), typed: typed.map((t) => t.done), virtualNs: virtualNs.toString(), dumps };
}
function consoleRestore(c) {
  outBuf = c.outBuf; stdinQueue = Buffer.from(unb64(c.stdinQueue)); transcript.length = 0; transcript.push(Buffer.from(unb64(c.transcript)));
  markerCount = c.markerCount; virtualNs = BigInt(c.virtualNs);
  // "already seen" only carries over for the SAME --expect / --reply; a restored run usually asks
  // for the next screen (a checkpoint taken at --expect + a new --expect for what follows)
  expectSeen = !!(c.expectSeen && c.expect != null && c.expect === expectKey());
  for (const r of opts.replies) { const rec = c.replies.find((x) => x.re === r.re.source); if (rec) r.done = rec.done; }
  c.typed.forEach((d, i) => { if (typed[i]) typed[i].done = d; });
  // the recording run's markers up to here are this guest's history: replay their DUMP lines (flagged)
  // so compare.mjs lines up with a straight run
  for (const d of c.dumps) { const rec = Object.assign({}, d, { restored: true }); dumps.push(rec); console.error(`[harness] DUMP ${JSON.stringify(rec)}`); }
}
// called from the dbg hook trampoline (installJitHost) once armed: memory is between traces now
function writeCheckpoint() {
  const ex = inst.exports;
  ckpt.armed = false;
  ex.nanobox_dbg_set(0, 0, 0, 0);
  const t = performance.now();
  const memory = ex.memory, memBytes = memory.buffer.byteLength;
  const header = { magic: "nanobox-checkpoint", version: CKPT_VERSION, engine: engineTag, label: ckpt.label, createdAt: new Date().toISOString(),
    icount: u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi()).toString(), ticks: u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi()).toString(),
    rip: "0x" + u64(ex.nanobox_rip_lo(), ex.nanobox_rip_hi()).toString(16),
    wallMs: +(performance.now() - t0).toFixed(1), // recording run: t0 -> here (what a restore saves, roughly)
    memBytes, gz: !!opts.checkpointGz, chunkBytes: CKPT_CHUNK, chunks: null,
    run: { cmd: opts.cmd, oci: opts.oci, spec: opts.spec, args },
    wasifs: bundleFs ? bundleFs.snapshot() : null,
    net: netStub ? (() => { const n = netStub.snapshot(); return { accepted: n.accepted, outOff: n.outOff, outQueue: n.outQueue.map(b64), inBuf: b64(n.inBuf), stats: n.stats }; })() : null,
    console: consoleSnapshot(),
    ram: ex.nanobox_mem_block_ptr && !opts.noHash ? hashGuestRam(null) : null };
  let chunks = null;
  if (header.gz) { // independent gzip members per chunk: simple to write, simple to inflate straight into memory
    chunks = [];
    for (let off = 0; off < memBytes; off += CKPT_CHUNK) chunks.push(zlib.gzipSync(new Uint8Array(memory.buffer, off, Math.min(CKPT_CHUNK, memBytes - off)), { level: 1 }));
    header.chunks = chunks.map((c) => c.length);
  }
  const hj = Buffer.from(JSON.stringify(header), "utf8");
  const hlen = CKPT_MAGIC.length + 4 + hj.length, pad = (CKPT_HDR_ALIGN - (hlen % CKPT_HDR_ALIGN)) % CKPT_HDR_ALIGN;
  fs.mkdirSync(path.dirname(path.resolve(opts.checkpointOut)), { recursive: true });
  const tmp = opts.checkpointOut + ".tmp";
  const fd = fs.openSync(tmp, "w");
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(hj.length, 0);
  fs.writeSync(fd, Buffer.concat([Buffer.from(CKPT_MAGIC, "latin1"), lenBuf, hj, Buffer.alloc(pad)]));
  let written = 0;
  if (chunks) for (const c of chunks) written += fs.writeSync(fd, c);
  else for (let off = 0; off < memBytes; off += 256 << 20) { const n = Math.min(256 << 20, memBytes - off); written += fs.writeSync(fd, new Uint8Array(memory.buffer, off, n)); }
  fs.closeSync(fd);
  fs.renameSync(tmp, opts.checkpointOut);
  ckpt.written = { file: opts.checkpointOut, ms: performance.now() - t };
  console.error(`[harness] CHECKPOINT ${opts.checkpointOut}: label=${header.label} icount=${header.icount} ticks=${header.ticks} rip=${header.rip} mem=${(memBytes / 1e6).toFixed(0)} MB${header.gz ? ` (gz ${(written / 1e6).toFixed(0)} MB)` : ""} ram-sha=${header.ram ? header.ram.sha256.slice(0, 12) : "-"} written in ${ckpt.written.ms.toFixed(0)} ms at t=${header.wallMs} ms`);
  if (ckpt.finishAfter != null) finish(ckpt.finishAfter);
}
// before wasi.start: memory + JS state from the file into the fresh instance
function restoreCheckpoint(file) {
  const t = performance.now();
  const ex = inst.exports;
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(CKPT_MAGIC.length + 4);
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString("latin1", 0, CKPT_MAGIC.length) !== CKPT_MAGIC) { console.error(`[harness] ${file}: not a checkpoint file`); process.exit(2); }
  const hjLen = head.readUInt32LE(CKPT_MAGIC.length);
  const hj = Buffer.alloc(hjLen); fs.readSync(fd, hj, 0, hjLen, head.length);
  const header = JSON.parse(hj.toString("utf8"));
  if (header.version !== CKPT_VERSION) { console.error(`[harness] ${file}: checkpoint version ${header.version}, this harness reads ${CKPT_VERSION}`); process.exit(2); }
  if (header.engine !== engineTag) { console.error(`[harness] ${file}: recorded with engine ${header.engine}, this is ${engineTag} — a checkpoint is only valid for the exact engine build`); process.exit(2); }
  if (header.run && (header.run.cmd !== opts.cmd || header.run.oci !== opts.oci)) console.error(`[harness] WARNING: checkpoint was recorded with --cmd ${JSON.stringify(header.run.cmd)} --oci ${header.run.oci}; this run has --cmd ${JSON.stringify(opts.cmd)} --oci ${opts.oci} (the guest keeps running what it was running; the rootfs tree must be the same image)`);
  const hlen = head.length + hjLen, dataOff = hlen + (CKPT_HDR_ALIGN - (hlen % CKPT_HDR_ALIGN)) % CKPT_HDR_ALIGN;
  const memory = ex.memory, have = memory.buffer.byteLength, want = header.memBytes;
  if (want < have) { console.error(`[harness] ${file}: checkpoint memory (${want}) smaller than the module's initial memory (${have})`); process.exit(2); }
  if (want > have) memory.grow((want - have) / 65536);
  const tRead = performance.now();
  if (header.gz) {
    let pos = dataOff, off = 0;
    for (const clen of header.chunks) {
      const c = Buffer.alloc(clen); fs.readSync(fd, c, 0, clen, pos); pos += clen;
      const raw = zlib.gunzipSync(c);
      new Uint8Array(memory.buffer, off, raw.length).set(raw); off += raw.length;
    }
    if (off !== want) { console.error(`[harness] ${file}: inflated ${off} bytes, header says ${want}`); process.exit(2); }
  } else {
    // straight into the wasm memory, no intermediate copy
    for (let off = 0; off < want;) {
      const n = fs.readSync(fd, new Uint8Array(memory.buffer, off, Math.min(256 << 20, want - off)), 0, Math.min(256 << 20, want - off), dataOff + off);
      if (n <= 0) { console.error(`[harness] ${file}: short read at ${off}/${want}`); process.exit(2); }
      off += n;
    }
  }
  fs.closeSync(fd);
  const readMs = performance.now() - tRead;
  // JS-side state (the tree was rebuilt from the same image, so every fd path resolves again)
  if (header.wasifs) { if (!bundleFs) { console.error("[harness] checkpoint has a bundle fd table but this run has no --oci"); process.exit(2); } bundleFs.restore(header.wasifs); }
  if (header.net) { if (!netStub) { console.error("[harness] checkpoint has netstub state but this run has no --net/--oci"); process.exit(2); } netStub.restore({ accepted: header.net.accepted, outOff: header.net.outOff, outQueue: header.net.outQueue.map(unb64), inBuf: unb64(header.net.inBuf), stats: header.net.stats }); }
  consoleRestore(header.console);
  // engine-side sanity: the counters must read back what the recorder saw; the guest RAM hash proves
  // the bytes landed (skipped with --no-hash, it costs ~1 s)
  const icount = u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi()).toString(), ticks = u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi()).toString();
  let verify = "unverified";
  if (icount !== header.icount || ticks !== header.ticks) { console.error(`[harness] RESTORE ${file}: counters differ after restore (icount ${icount} vs ${header.icount}, ticks ${ticks} vs ${header.ticks})`); process.exit(2); }
  let verifyMs = 0;
  if (header.ram && !opts.noHash) {
    const tv = performance.now(); const h = hashGuestRam(null); verifyMs = performance.now() - tv;
    if (h.sha256 !== header.ram.sha256) { console.error(`[harness] RESTORE ${file}: guest RAM sha ${h.sha256} != recorded ${header.ram.sha256}`); process.exit(2); }
    verify = `ram-sha ok (${h.sha256.slice(0, 12)}, ${verifyMs.toFixed(0)} ms)`;
  }
  const total = performance.now() - t, sinceStart = performance.now() - t0;
  ckpt.restored = { file, header, readMs, totalMs: total, savedMs: header.wallMs - sinceStart };
  console.error(`[harness] RESTORE ${file}: label=${header.label} icount=${header.icount} ticks=${header.ticks} rip=${header.rip} mem=${(want / 1e6).toFixed(0)} MB${header.gz ? " (gz)" : ""}: read ${readMs.toFixed(0)} ms, restore total ${total.toFixed(0)} ms, ${verify}; recorded at t=${header.wallMs} ms of its run, this run is at t=${sinceStart.toFixed(0)} ms -> ~${(header.wallMs - sinceStart).toFixed(0)} ms saved`);
}

// ---- run ----------------------------------------------------------------------------------------
if (opts.dumpDir) fs.mkdirSync(opts.dumpDir, { recursive: true });
let exitCode = null;
if (opts.timeout) setTimeout(() => { console.error("[harness] timeout"); finish(124); }, opts.timeout * 1000).unref();
let bundleFs = null, netStub = null;
if (opts.oci || opts.net) {
  // deterministic network peer (web/netstub.js): DHCP/ARP answered, DNS -> NXDOMAIN, TCP -> RST
  globalThis.self = globalThis;
  await import("../web/netstub.js");
  netStub = NanoboxNet.create({});
  netStub.attach(imp, { listenfd: 9, connfd: 10, memory: () => inst.exports.memory });
}
if (opts.oci) {
  // same code the browser worker runs (web/opt-worker.js): unpack the OCI layers into an in-memory
  // tree with symlinks and answer the WASI calls for one extra preopen ("bundle") in front of the shim
  globalThis.self = globalThis;
  await import("../web/wasifs.js"); await import("../web/oci.js");
  const tOci = performance.now();
  // --oci-cache: decompressed layer tars on disk, keyed by layer digest (atomic put: tmp + rename)
  const cache = opts.ociCache ? {
    get(key) { try { return fs.readFileSync(path.join(opts.ociCache, key.replace(":", "_") + ".tar")); } catch (e) { return null; } },
    put(key, bytes) { fs.mkdirSync(opts.ociCache, { recursive: true }); const f = path.join(opts.ociCache, key.replace(":", "_") + ".tar"); fs.writeFileSync(f + ".tmp." + process.pid, bytes); fs.renameSync(f + ".tmp." + process.pid, f); },
  } : null;
  const img = await NanoboxOci.load(opts.oci, { cache });
  const root = NanoboxFs.dir();
  NanoboxFs.add(root, "config/config.json", { data: new Uint8Array(fs.readFileSync(opts.spec)) });
  // --bundle-file NAME=HOSTFILE: extra files in the bundle share (visible in the container at /bundle/NAME, executable)
  for (const bf of opts.bundleFiles) { const eq = bf.indexOf("="); NanoboxFs.add(root, bf.slice(0, eq), { data: new Uint8Array(fs.readFileSync(bf.slice(eq + 1))), mode: 0o755 }); }
  NanoboxFs.add(root, "config/imageconfig.json", { data: img.configBytes });
  root.e.set("rootfs", img.rootfs);
  const bfd = fds.length; // preopen scans stop at the first BADF, so no gaps
  bundleFs = NanoboxFs.attach(wasi.wasiImport, { fd: bfd, name: "bundle", root, memory: () => inst.exports.memory,
    log: process.env.NANOBOX_FS_LOG ? (name, a, r, path) => console.error(`[fs] ${name}(${a.slice(0, 3).join(",")}) ${path} -> ${r}`) : null });
  const cacheNote = img.cache ? ` (cache ${opts.ociCache}: ${img.cache.hits}/${img.cache.hits + img.cache.misses} layers, ${(img.cache.bytes / 1e6).toFixed(0)} MB from cache${img.cache.misses ? `, ${img.cache.misses} fetched+stored` : ""}; fetch ${img.fetchMs.toFixed(0)} ms, gunzip ${img.unpackMs.toFixed(0)} ms, untar ${img.applyMs.toFixed(0)} ms)` : ` (fetch ${img.fetchMs.toFixed(0)} ms, gunzip ${img.unpackMs.toFixed(0)} ms, untar ${img.applyMs.toFixed(0)} ms)`;
  console.error(`[harness] OCI image ${opts.oci}: ${img.files} entries, ${(img.compressedBytes / 1e6).toFixed(1)} MB compressed, ${(performance.now() - tOci).toFixed(0)} ms${cacheNote}; bundle preopen at fd ${bfd}`);
}
const module = await WebAssembly.compile(wasmBytes);
inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imp });
if (opts.checkpoint) restoreCheckpoint(opts.checkpoint); // before anything writes engine state (installJitHost's nanobox_set_jit etc.)
if (opts.jitBundle.length) await preloadBundles(opts.jitBundle);
installJitHost(inst);
if (opts.dumpStart) takeDump("start"); // the wizer snapshot state, before the first runtime instruction
if (opts.pages) { if (!inst.exports.nanobox_pages_set) { console.error("[harness] engine has no page profiler"); process.exit(2); } inst.exports.nanobox_pages_set(1); }
if (opts.focus) { const c = opts.focus.indexOf(":"); inst.exports.nanobox_focus_set(Number(BigInt(opts.focus.slice(0, c)) >> 12n)); }
if (inst.exports.nanobox_icount_lo) {
  // state baked into the wizer snapshot, before a single runtime instruction
  const ex = inst.exports;
  console.error(`[harness] SNAPSHOT icount=${u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi())} ticks=${u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi())}` +
    (ex.nanobox_stat ? ` loops=${ex.nanobox_stat(0)} longjmps=${ex.nanobox_stat(1)} traces=${ex.nanobox_stat(2)}` : ""));
}
const tStart = performance.now();
try {
  if (opts.initOnly) { wasi.inst = inst; if (inst.exports._initialize) inst.exports._initialize(); inst.exports["wizer.initialize"](); takeDump("init"); finish(0); }
  exitCode = wasi.start(inst); // runs to proc_exit / return from _start
} catch (e) {
  if (e && e.constructor && e.constructor.name === "WASIProcExit") exitCode = e.code;
  else { console.error("[harness] engine trapped:", e && e.stack || e); exitCode = 125; }
}
finish(exitCode ?? 0);

function finish(code) {
  const wall = performance.now() - tStart;
  const ex = inst && inst.exports;
  const summary = { exitCode: code, wallMs: +wall.toFixed(1), dumps };
  if (bundleFs) summary.fs = bundleFs.stats;
  if (opts.smc && ex && ex.nanobox_smc_n) {
    const n = ex.nanobox_smc_n(); const lines = ["# ppage count firstTick lastTick masks"];
    for (let i = 0; i < n; i++) { const pp = ex.nanobox_smc_get(i, 0); if (pp < 0) continue; lines.push(`${pp} ${ex.nanobox_smc_get(i, 1)} ${ex.nanobox_smc_get(i, 2)} ${ex.nanobox_smc_get(i, 3)} ${ex.nanobox_smc_get(i, 4)}`); }
    fs.writeFileSync(opts.smc, lines.join("\n") + "\n");
    summary.smc = { total: ex.nanobox_smc_total(), pages: lines.length - 1, file: opts.smc };
  }
  for (const sp of opts.savePhys) {
    const bs = ex.nanobox_mem_block_size(); const blk = Math.floor(sp.addr / bs); const ptr = ex.nanobox_mem_block_ptr(blk);
    const page = ptr ? Buffer.from(new Uint8Array(ex.memory.buffer, ptr + (sp.addr % bs), 4096)) : Buffer.alloc(4096);
    fs.writeFileSync(sp.file, page); console.error(`[harness] saved phys page 0x${sp.addr.toString(16)} -> ${sp.file}${ptr ? "" : " (never touched: zeros)"}`);
  }
  if (opts.pages && ex && ex.nanobox_pages_n) {
    writePagesProfile(opts.pages, opts.focus || null);
    summary.pages = { used: ex.nanobox_pages_used(), dropped: ex.nanobox_pages_dropped(), file: opts.pages };
    if (opts.pagesMark) summary.pagesMarks = keyMarks;
  }
  if (opts.ioLog) { fs.writeFileSync(opts.ioLog, ioEvents.map((e) => JSON.stringify(e)).join("\n") + "\n"); summary.ioLog = { file: opts.ioLog, events: ioEvents.length }; }
  if (netStub) summary.net = netStub.stats;
  if (ckpt.written) summary.checkpoint = { file: ckpt.written.file, label: ckpt.label, writeMs: +ckpt.written.ms.toFixed(1) };
  else if (opts.checkpointOut) console.error(`[harness] checkpoint NOT written: ${ckpt.armed ? `armed at "${ckpt.label}" but the engine ran no further trace` : `marker "${opts.checkpointAt}" never seen`}`);
  if (ckpt.restored) summary.restored = { file: ckpt.restored.file, label: ckpt.restored.header.label, readMs: +ckpt.restored.readMs.toFixed(1), restoreMs: +ckpt.restored.totalMs.toFixed(1), savedMs: +ckpt.restored.savedMs.toFixed(1) };
  if (ex && ex.nanobox_icount_lo) {
    const ic = u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi());
    summary.icount = ic.toString(); summary.mips = +(Number(ic) / 1e6 / (wall / 1000)).toFixed(2);
    summary.ticks = u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi()).toString();
    // final counters, so a window can be isolated by subtracting the ones recorded at a marker/--expect
    if (ex.nanobox_stat) summary.statsEnd = { traces: ex.nanobox_stat(2), jitTraces: ex.nanobox_stat(3), jitCompiled: ex.nanobox_stat(4), loopbacks: ex.nanobox_stat(5), links: ex.nanobox_stat(6), slow: ex.nanobox_stat(7), linkFail: [8,9,10,11,12,13,14,15].map((i) => ex.nanobox_stat(i)), cache: ex.nanobox_jit_cache_stat ? [ex.nanobox_jit_cache_stat(0), ex.nanobox_jit_cache_stat(1), ex.nanobox_jit_cache_stat(2)] : null };
    // AOT-mode census (engines with the extended stats): in-region transitions, interpreted dispatch, region former counters
    if (ex.nanobox_stat && ex.nanobox_stat(16) >= 0) summary.aot = { intrans: ex.nanobox_stat(16), interpTraces: ex.nanobox_stat(17), interpIcount: ex.nanobox_stat(18), shadowMiss: ex.nanobox_stat(19), census: ex.nanobox_aot_stat ? Array.from({ length: 16 }, (_, i) => ex.nanobox_aot_stat(i)) : null };
    if (ex.nanobox_jit_region_stat && ex.nanobox_jit_region_stat(16) > 0) summary.regionStats = Array.from({ length: 48 }, (_, i) => ex.nanobox_jit_region_stat(i));
    if (ex.nanobox_jit_member_stat) summary.memberMap = { put: ex.nanobox_jit_member_stat(0), hit: ex.nanobox_jit_member_stat(1), miss: ex.nanobox_jit_member_stat(2), resets: ex.nanobox_jit_member_stat(3), used: ex.nanobox_jit_member_stat(4) };
  }
  if (jitState.table) {
    summary.jit = { installed: jitState.installed, batches: jitState.batches, released: jitState.released, live: jitState.fns.size, bytes: jitState.bytes, compileMs: +jitState.compileMs.toFixed(1), tableMs: +jitState.tableMs.toFixed(1) };
    if (jitState.link) summary.jit.linkSlot = jitState.link.slot, summary.jit.linkReuse = jitState.linkReuse;
    if (opts.jitBundle.length) Object.assign(summary.jit, { bundleHits: jitState.bundleHits, bundleMisses: jitState.bundleMisses, bundleInst: jitState.bundleInst, bundleModules: jitState.bundleModules, bundleFiles: jitState.bundleFiles, bundleLoadMs: +jitState.bundleLoadMs.toFixed(1), bundleInstMs: +jitState.bundleInstMs.toFixed(1) });
    if (opts.jitBundleOut) { try { summary.jit.bundleOut = writeBundle(opts.jitBundleOut); } catch (e) { console.error("[harness] JIT bundle write failed:", e.message); } }
  }
  if (ex && ex.nanobox_jit_nops && opts.jit) {
    // per-opcode template coverage: which opcodes still fall back to Bochs handlers (compile-time counts)
    const nops = ex.nanobox_jit_nops(); const rows = [];
    let inl = 0, fb = 0;
    for (let ia = 0; ia < nops; ia++) {
      const f = ex.nanobox_jit_opstat(ia, 0), i = ex.nanobox_jit_opstat(ia, 1);
      inl += i; fb += f;
      if (f) { const p = ex.nanobox_jit_opname(ia); const heap = new Uint8Array(ex.memory.buffer); let e = p; while (heap[e]) e++; rows.push([Buffer.from(heap.subarray(p, e)).toString(), f]); }
    }
    rows.sort((a, b) => b[1] - a[1]);
    console.error(`[harness] JIT template coverage (compile-time instructions): inline=${inl} fallback=${fb} (${(100 * inl / Math.max(1, inl + fb)).toFixed(1)}% inline)`);
    console.error("[harness] top fallback opcodes: " + rows.slice(0, 40).map(([n, c]) => `${n}:${c}`).join(" "));
    // dynamic counts (profiling level 3)
    const dyn = []; let dinl = 0, dfb = 0;
    const heap = new Uint8Array(ex.memory.buffer);
    const nameOf = (ia) => { const p = ex.nanobox_jit_opname(ia); let e = p; while (heap[e]) e++; return Buffer.from(heap.subarray(p, e)).toString(); };
    for (let ia = 0; ia < nops; ia++) {
      const f = ex.nanobox_jit_opstat(ia, 2), i = ex.nanobox_jit_opstat(ia, 3);
      dinl += i; dfb += f;
      if (f || i) dyn.push([nameOf(ia), i, f]);
    }
    if (dinl + dfb > 0) {
      dyn.sort((a, b) => (b[1] + b[2]) - (a[1] + a[2]));
      console.error(`[harness] dynamic (executed) instructions in JIT'd traces: inline=${dinl} fallback=${dfb} (${(100 * dinl / (dinl + dfb)).toFixed(1)}% inline)`);
      console.error("[harness] top executed opcodes (inline/fallback): " + dyn.slice(0, 50).map(([n, i, f]) => `${n.replace("BX_IA_", "")}:${i}/${f}`).join(" "));
      const dfbTop = dyn.filter((d) => d[2] > 0).sort((a, b) => b[2] - a[2]);
      console.error("[harness] top DYNAMIC fallbacks (handler steps): " + dfbTop.slice(0, 40).map(([n, i, f]) => `${n.replace("BX_IA_", "")}:${f}`).join(" "));
      // per-opcode COST: static template bytes per compiled instance x executions = executed template
      // bytes; ranks where the emitted code's cost actually is (bytes track wasm ops closely)
      const cost = [];
      for (let ia = 0; ia < nops; ia++) {
        const inst = ex.nanobox_jit_opstat(ia, 1), bytes = ex.nanobox_jit_opstat(ia, 4), execs = ex.nanobox_jit_opstat(ia, 3);
        if (inst && execs) cost.push([nameOf(ia).replace("BX_IA_", ""), inst, bytes / inst, execs, execs * bytes / inst]);
      }
      const total = cost.reduce((s, c) => s + c[4], 0);
      cost.sort((a, b) => b[4] - a[4]);
      console.error(`[harness] template COST (executed template bytes ${(total / 1e9).toFixed(2)} G): ` + cost.slice(0, 30).map(([n, inst, bpi, ex, tot]) => `${n}:${bpi.toFixed(0)}B/inst x${(ex / 1e6).toFixed(1)}M=${(100 * tot / total).toFixed(1)}%`).join(" "));
    }
  }
  if (aotResult) summary.aotSession = aotResult;
  if (opts.aotModeAt) summary.aotMode = { at: opts.aotModeAt, done: aotModeDone, atMs: +aotModeAtMs.toFixed(1), switchMs: +aotModeMs.toFixed(2) };
  if (opts.tplBytes && inst && inst.exports.nanobox_jit_opstat) {
    // where the emitted BYTES are, statically: total template bytes per opcode and bytes per compiled
    // instance. Needs no execution counts, so it works on an offline translation run too.
    const ex = inst.exports, rows = [];
    const hp = new Uint8Array(ex.memory ? ex.memory.buffer : mem().buffer);
    const nameOf = (ia) => { const p = ex.nanobox_jit_opname(ia); let e = p; while (hp[e]) e++; return Buffer.from(hp.subarray(p, e)).toString(); };
    for (let ia = 0; ia < 2000; ia++) {
      const n = ex.nanobox_jit_opstat(ia, 1), b = ex.nanobox_jit_opstat(ia, 4);
      if (n && b) rows.push([nameOf(ia).replace("BX_IA_", ""), n, b, b / n]);
    }
    const tot = rows.reduce((s, r) => s + r[2], 0);
    rows.sort((a, b) => b[2] - a[2]);
    const out = [`total emitted template bytes: ${(tot / 1e6).toFixed(1)} MB over ${rows.reduce((s, r) => s + r[1], 0)} compiled instances`]
      .concat(rows.slice(0, 40).map(([n, i, b, per]) => `${n}: ${(b / 1e6).toFixed(1)} MB = ${(100 * b / tot).toFixed(1)}% (${i} instances x ${per.toFixed(0)} B)`));
    fs.writeFileSync(opts.tplBytes, out.join("\n"));
    console.error(`[harness] template bytes written to ${opts.tplBytes}`);
  }
  if (opts.aotKeys && inst && inst.exports.nanobox_keylog_count) {
    const ex = inst.exports, n = ex.nanobox_keylog_count(), out = [];
    // 64-bit values: read them as two 32-bit halves. A double cannot hold a kernel address or a
    // content key (ulp is 2048 at 2^63), so nanobox_keylog_at() quantises both — use it only as a
    // fallback for engines built before nanobox_keylog_word existed.
    const w = ex.nanobox_keylog_word;
    const u64 = (i, f) => (BigInt(w(i, 2 * f + 1) >>> 0) << 32n) | BigInt(w(i, 2 * f) >>> 0);
    for (let i = 0; i < n; i++) {
      if (w) out.push(`0x${u64(i, 0).toString(16)} 0x${u64(i, 1).toString(16)} ${w(i, 4)}`);
      else out.push(`${ex.nanobox_keylog_at(i, 0)} ${ex.nanobox_keylog_at(i, 1)} ${ex.nanobox_keylog_at(i, 2)}`);
    }
    fs.writeFileSync(opts.aotKeys, out.join("\n"));
    console.error(`[harness] region keys: ${n} written to ${opts.aotKeys}`);
  }
  if (opts.transcript) fs.writeFileSync(opts.transcript, Buffer.concat(transcript));
  console.error("\n[harness] SUMMARY " + JSON.stringify(summary));
  process.exit(code === 0 ? 0 : (code || 0));
}

// --pages / --focus: dump the engine's per-page instruction profile (cumulative counters). Called at
// exit and, with --pages-mark, at every scripted keystroke so one keystroke can be isolated by diff.
function writePagesProfile(file, focus) {
  const ex = inst && inst.exports;
  if (!ex || !ex.nanobox_pages_n) return;
  const n = ex.nanobox_pages_n(); const lines = ["# lpage count ppage flags traces  (flags: 1 user, 2 kernel, 4 physical page changed)"];
  for (let i = 0; i < n; i++) { const lp = ex.nanobox_pages_get(i, 0); if (lp < 0) continue; lines.push(`${lp} ${ex.nanobox_pages_get(i, 1)} ${ex.nanobox_pages_get(i, 2)} ${ex.nanobox_pages_get(i, 3)} ${ex.nanobox_pages_get(i, 4)}`); }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  if (!focus) return;
  const c = focus.indexOf(":"); const base = BigInt(focus.slice(0, c)) & ~0xfffn; const rows = ["# addr instructions traces"];
  for (let o = 0; o < 4096; o++) { const t = ex.nanobox_focus_get(o, 1); if (t > 0) rows.push(`0x${(base + BigInt(o)).toString(16)} ${ex.nanobox_focus_get(o, 0)} ${t}`); }
  fs.writeFileSync(focus.slice(c + 1), rows.join("\n") + "\n");
}
