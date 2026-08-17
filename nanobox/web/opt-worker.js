// Worker for both engines. Same runtime glue as nanobox's public/c2w/wasi-worker.js (container2wasm's
// worker-util.js + xterm-pty's TtyClient); on top of it:
//   * the JIT host (jit-host.js) is attached when the engine exports the nanobox hooks — the
//     optimized engine — and does nothing for the original one;
//   * a heartbeat with engine counters is posted to the page from inside the WASI calls (the VM
//     loop never yields, so a timer would never fire here);
//   * cfg.direct: the container image is unpacked HERE (oci.js) and served to the guest through
//     Bochs' built-in virtio-9p device as a WASI preopen (wasifs.js) instead of container2wasm's
//     network path (guest TCP -> stack worker -> imagemounter 9p server over SharedArrayBuffers).
//     Needs the optimized engine (its wasi-vfs tolerates the socket-fd prestats, its guest init
//     understands --external-bundle=9p=virtio:NAME);
//   * cfg.jitBundles: pre-computed JIT translations (.nbjb, see jit-bundle.js) are fetched and
//     compiled while the engine downloads (NanoboxJit.preload) and the VM only starts once they are
//     ready; the engine's lookup hook is then answered from them (instantiate only, no compile).
importScripts(new URL("/c2w/vendor/workerTools.js", location.href).href);
importScripts(new URL("/c2w/dist/worker-util.js", location.href).href);   // stock RunContainer (original engine)
importScripts(new URL("./dist/nb-worker-util.js", location.href).href);   // NbRun: fork with bundle/extraFds/hook options
importScripts(new URL("./cachefetch.js", location.href).href);
importScripts(new URL("./jit-bundle.js", location.href).href);
importScripts(new URL("./jit-host.js", location.href).href);
importScripts(new URL("./native/hostchan.js", location.href).href);   // /dev/hvc1 <-> JS byte stream (system-node design)
importScripts(new URL("./native/hcring.js", location.href).href);
importScripts(new URL("./wasifs.js", location.href).href);
importScripts(new URL("./oci.js", location.href).href);

const wq = new URLSearchParams(self.location.search);
const MODE = wq.get("mode") || "full";   // debug: plain (stock behaviour) | noinst (no instantiate hook)
let info = null, args = null, cfg = null;
let engineInst = null;
let engineMemory = () => engineInst.exports.memory;
let lastBeat = 0;
const io = { pollN: 0, pollMs: 0, clockN: 0, clockMs: 0, sendN: 0, sendMs: 0, recvN: 0, recvMs: 0, readN: 0, readMs: 0, writeN: 0, writeMs: 0 };
const t0 = performance.now();
let bundleFs = null;     // NanoboxFs.attach() result in direct mode (its .stats go into the heartbeat)
let jitPreload = null;   // NanoboxJit.preload() promise when cfg.jitBundles is set (awaited before the engine starts)
const ev = (event, extra) => postMessage(Object.assign({ type: "nanobox-event", event, t: performance.now() - t0 }, extra || {}));

// [linear page, instructions, physical page, flags(1 user, 2 kernel, 4 physical page changed)]
function pagesProfile() {
  const ex = engineInst && engineInst.exports;
  if (!ex || !ex.nanobox_pages_n) return null;
  const rows = [];
  for (let i = 0, n = ex.nanobox_pages_n(); i < n; i++) {
    const lp = ex.nanobox_pages_get(i, 0);
    if (lp < 0) continue;
    rows.push([lp, ex.nanobox_pages_get(i, 1), ex.nanobox_pages_get(i, 2), ex.nanobox_pages_get(i, 3)]);
  }
  return rows;
}

function beat(force) {
  const now = performance.now();
  if (!force && now - lastBeat < 1000) return;
  lastBeat = now;
  const msg = { type: "nanobox-stats", t: now - t0, io: Object.assign({}, io) };
  if (engineInst) {
    try { Object.assign(msg, NanoboxJit.stats(engineInst)); } catch (e) {}
  }
  if (bundleFs) msg.fs = Object.assign({}, bundleFs.stats);
  postMessage(msg);
}

// Hook the runtime's WebAssembly.instantiate: attach the JIT host and the heartbeat.
const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
if (MODE === "full") WebAssembly.instantiate = function (src, imports) {
  const wasi = imports && imports.wasi_snapshot_preview1;
  if (wasi) {
    // container2wasm reserves fds 4/5 for its socket hack and answers fd_prestat_get for them with a
    // non-directory prestat (tag 1). wasi-vfs 0.3 (the original build) skipped those; stock wasi-vfs
    // 0.6.3 insists on a directory name and panics (the optimized build carries a patched wasi-vfs
    // that skips them, but ending the scan there is what wasi-libc does with the same answer and
    // costs nothing). In direct mode the scan must continue past 4/5 to reach the bundle preopen.
    if (!(cfg && cfg.direct)) {
      const pg = wasi.fd_prestat_get;
      wasi.fd_prestat_get = function (fd, ptr) { if (fd === 4 || fd === 5) return 8 /* BADF */; return pg.apply(this, arguments); };
    }
  }
  if (wasi && !(cfg && cfg.noBeat)) {
    // heartbeat + a per-syscall activity profile (how much wall time the VM spends waiting)
    const wrap = (name, key) => {
      const f = wasi[name]; if (!f) return;
      wasi[name] = function () { const t = performance.now(); const r = f.apply(this, arguments); const dt = performance.now() - t; io[key + "N"]++; io[key + "Ms"] += dt; if (key === "poll") beat(false); return r; };
    };
    wrap("poll_oneoff", "poll"); wrap("clock_time_get", "clock"); wrap("sock_send", "send"); wrap("sock_recv", "recv"); wrap("fd_read", "read"); wrap("fd_write", "write");
    if (cfg && cfg.trace) {
      // console/tty tracing: what the guest writes to the terminal, what it reads, and what it waits for
      const mem = () => new DataView(engineMemory().buffer);
      const fw = wasi.fd_write;
      wasi.fd_write = function (fd, iovs, iovsLen, nw) {
        if (fd === 1 || fd === 2) { const v = mem(); const u8 = new Uint8Array(v.buffer); let out = ""; for (let i = 0; i < iovsLen; i++) { const b = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true); out += String.fromCharCode.apply(null, u8.subarray(b, b + Math.min(l, 200))); } ev("tty-write", { data: JSON.stringify(out.slice(0, 200)) }); }
        return fw.apply(this, arguments);
      };
      const fr = wasi.fd_read;
      wasi.fd_read = function (fd, iovs, iovsLen, nr) {
        const r = fr.apply(this, arguments);
        if (fd === 0) { const v = mem(); const n = v.getUint32(nr, true); const b = v.getUint32(iovs, true); const u8 = new Uint8Array(v.buffer); ev("tty-read", { n, data: JSON.stringify(String.fromCharCode.apply(null, u8.subarray(b, b + Math.min(n, 64)))) }); }
        return r;
      };
      const pl = wasi.poll_oneoff; let lastPollLog = 0, pollKinds = {};
      wasi.poll_oneoff = function (inPtr, outPtr, n, nevPtr) {
        const v = mem(); let kinds = [];
        for (let i = 0; i < n; i++) { const base = inPtr + i * 48; const tag = v.getUint8(base + 8); if (tag === 0) kinds.push("clock:" + Number(v.getBigUint64(base + 24, true)) / 1e6 + "ms"); else kinds.push((tag === 1 ? "rd" : "wr") + ":fd" + v.getUint32(base + 16, true)); }
        const k = kinds.join(","); pollKinds[k] = (pollKinds[k] || 0) + 1;
        const r = pl.apply(this, arguments);
        const now = performance.now();
        if (now - lastPollLog > 5000) { lastPollLog = now; ev("poll-kinds", { kinds: JSON.stringify(pollKinds) }); pollKinds = {}; }
        return r;
      };
    }
  }
  const tc0 = performance.now();
  return origInstantiate(src, imports).then(async (r) => {
    try {
      const inst = r.instance || r;
      engineMemory = () => inst.exports.memory;
      ev("instantiated", { compileMs: Math.round(performance.now() - tc0) });
      if (inst.exports && inst.exports.nanobox_hook_slot) {
        engineInst = inst;
        // the bundles must be compiled before the first lookup (usually long done: they load in
        // parallel with the engine fetch; in non-direct mode this is the only wait point)
        if (jitPreload) { try { await jitPreload; } catch (e) { ev("error", { message: "jit bundles: " + (e && e.message || e) }); } }
        // Loading a cache is always on; RECORDING one is opt-in (?record=1) until the record ->
        // upload -> replay cycle is verified end to end, because a recording run deliberately
        // compiles at a low threshold and that costs boot time (harness: 8.4 -> 12.9 s at 200).
        const recording = !!cfg.jitRecord;
        const jitCfg = Object.assign({}, cfg.jit, { record: recording });
        if (recording && cfg.jitRecordThreshold) jitCfg.threshold = cfg.jitRecordThreshold;
        const ok = cfg && cfg.jit ? NanoboxJit.install(inst, jitCfg) : false;
        // host channel: guest -> host bytes go out on cfg.hostChan.port (to the runtime worker),
        // host -> guest bytes come in through the shared ring (drained by the engine's rx timer hook)
        if (cfg && cfg.hostChan && inst.exports.nanobox_hc_hook_slot) {
          const hc = NanoboxHostChan.attach(inst, inst.exports.__indirect_function_table, NanoboxJit.trampoline);
          const ring = NanoboxHcRing.reader(cfg.hostChan.sab);
          // guest -> host: into the inSab ring when given (the runtime worker reads it synchronously,
          // Atomics.wait-ing for the reply of a sync fs call), else over the port
          if (cfg.hostChan.inSab) { const inW = NanoboxHcRing.writer(cfg.hostChan.inSab); hc.onData = (b) => inW.write(b); }
          else hc.onData = (b) => cfg.hostChan.port.postMessage({ type: "hc", data: b }, [b.buffer]);
          // replace the queue-based read with the ring
          const ex = inst.exports; const mem = () => new Uint8Array(ex.memory.buffer);
          ex.__indirect_function_table.set(ex.nanobox_hc_hook_slot(1), NanoboxJit.trampoline([0x7f, 0x7f], [0x7f], (ptr, max) => { const b = ring.read(max); if (!b) return 0; mem().set(b, ptr); return b.length; }));
          ev("hostchan", { on: true });
        }
        ev("engine", { optimized: true, jit: ok ? cfg.jit : null, bundles: jitPreload ? NanoboxJit.state.bundleModules : undefined });
      } else {
        ev("engine", { optimized: false });
      }
    } catch (e) {
      ev("error", { message: "jit host: " + (e && e.message || e) });
    }
    return r;
  });
};

// ---- direct bundle mode --------------------------------------------------------------------------
// Everything the guest init needs under one preopened directory ("bundle"):
//   bundle/config/config.json       OCI runtime spec (what imagemounter would generate; served from
//                                   web/images/<image>/config.json, generated by genspec)
//   bundle/config/imageconfig.json  the image config blob
//   bundle/rootfs/...               the unpacked layers
let enginePromise = null, bundlePromise = null;
function fetchEngine(url) {
  const t = performance.now();
  return NanoboxCache.fetchValidated(url, { onHit: (n) => ev("engine-cached", { bytes: n }) }).then((gz) => {
    ev("engine-fetched", { bytes: gz.byteLength, ms: Math.round(performance.now() - t) });
    return new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  });
}
// OCI layers: content-addressed (digest) -> cached decompressed tar, never validated
const layerCache = { get: (digest) => NanoboxCache.getBytes("layer:" + digest), put: (digest, bytes) => NanoboxCache.putBytes("layer:" + digest, bytes) };
// engine identity for the bundle check (same rule as harness/run.mjs: length + sha256 of head/tail MiB)
async function engineTagOf(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", NanoboxJitBundle.engineTagInput(bytes));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return NanoboxJitBundle.engineTagFormat(bytes.byteLength, hex);
}
function startPreload() {
  // direct mode: the tag comes from the engine bytes we download ourselves; otherwise the page may
  // pass cfg.engineTag (serve.mjs publishes it in /engine/opt/jit/index.json), else the bundle is trusted
  const tag = enginePromise ? enginePromise.then(engineTagOf) : Promise.resolve(cfg.engineTag || null);
  jitPreload = Promise.resolve(tag)
    // Bundles are keyed by engine build. The harness-recorded ones (kernel.nbjb, <image>.nbjb) are
    // made with the FULL engine, so a page loading the slim build matches none of them and used to
    // boot with a cold JIT. auto-<tag>.nbjb is this browser's own cache for the build it loaded.
    .then(async (t) => {
      autoTag = t;
      const urls = (cfg.jitBundles || []).slice();
      if (t && cfg.jitAutoDir) {
        const url = cfg.jitAutoDir + "auto-" + t + ".nbjb";
        const head = await fetch(url, { method: "HEAD", credentials: "same-origin" }).catch(() => null);
        if (head && head.ok) { urls.push(url); autoCached = true; }
      }
      return NanoboxJit.preload(urls, t);
    })
    .then((r) => { ev("jit-bundles", Object.assign({ autoCached, tag: autoTag }, r)); return r; })
    .catch((e) => { ev("error", { message: "jit bundles: " + (e && e.message || e) }); return null; });
}
let autoTag = null, autoCached = false, autoUploaded = false;

// No cache for this engine build yet: record what we compile and upload it, so the next run starts
// warm. Recording runs deliberately compile at a LOW threshold — measured in the harness, doing that
// at runtime costs 2.4x the boot time (8.4 -> 20.6 s at threshold 2), which is precisely why the cost
// is paid once here and then served from the cache.
async function uploadAutoBundle() {
  if (autoUploaded || autoCached || !autoTag || !cfg.jitAutoDir) return;
  autoUploaded = true;
  try {
    const bytes = NanoboxJit.exportBundle(autoTag);
    const r = await fetch((cfg.jitUploadUrl || "/jit/upload") + "?name=" + encodeURIComponent("auto-" + autoTag + ".nbjb"),
      { method: "POST", body: bytes, credentials: "same-origin" });
    ev("jit-cache-recorded", { tag: autoTag, bytes: bytes.byteLength, ok: r.ok });
  } catch (e) { ev("error", { message: "jit cache upload: " + (e && e.message || e) }); }
}
async function buildBundle() {
  const t = performance.now();
  const [img, spec] = await Promise.all([
    NanoboxOci.load(cfg.imageAddr, { onProgress: (p) => ev("image", p), cache: cfg.noCache ? null : layerCache }),
    fetch(cfg.specUrl, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error("spec " + r.status); return r.arrayBuffer(); }),
  ]);
  const root = NanoboxFs.dir();
  NanoboxFs.add(root, "config/config.json", { data: new Uint8Array(spec) });
  NanoboxFs.add(root, "config/imageconfig.json", { data: img.configBytes });
  // extra files in the bundle share (visible at /bundle/<name> in the container), e.g. the system-node
  // shim: cfg.bundleFiles = [{ name: "nb/node", url: "/native/nbnode", mode: 0o755 }]
  for (const bf of cfg.bundleFiles || []) {
    const bytes = await NanoboxCache.fetchValidated(new URL(bf.url, location.href).href);
    NanoboxFs.add(root, bf.name, { data: new Uint8Array(bytes), mode: bf.mode || 0o755 });
  }
  root.e.set("rootfs", img.rootfs);
  ev("bundle-ready", { files: img.files, compressedBytes: img.compressedBytes, ms: Math.round(performance.now() - t), cache: img.cache || null });
  return root;
}
async function startDirect(ttyClient) {
  const [wasm, bundle] = await Promise.all([enginePromise, bundlePromise, jitPreload]);
  ev("start-direct");
  NbRun.startContainer(info, args, ttyClient, {
    wasm,
    bundle: "9p=virtio:bundle",
    extraFds: [{ nanoboxBundle: true }],   // fd 6: claimed by NanoboxFs below; the placeholder keeps the shim from reusing the slot
    beforeInstantiate(wasi) {
      bundleFs = NanoboxFs.attach(wasi.wasiImport, { fd: 6, name: "bundle", root: bundle, memory: () => wasi.inst.exports.memory });
    },
  });
}

onmessage = (msg) => {
  const req = msg.data;
  if (typeof req === "object" && req.type === "init") {
    info = req.info; args = req.args; cfg = req.cfg || {};
    if (MODE !== "plain") ev("init");
    if (cfg.direct) {
      enginePromise = fetchEngine(info.vmImage);
      bundlePromise = buildBundle();
      bundlePromise.catch((e) => ev("error", { message: "bundle: " + (e && e.message || e) }));
    }
    if (cfg.jitBundles && cfg.jitBundles.length && cfg.jit) startPreload();
    return;
  }
  // the engine's per-page instruction profile (what the harness gets with --pages), on demand: the
  // only way to see what the guest actually executes in the browser, where the workload has real
  // network and the harness's does not (docs/codex-typing.md)
  if (typeof req === "object" && req.type === "pages") { postMessage({ type: "nanobox-pages", rows: pagesProfile() }); return; }
  // Export everything the JIT compiled in THIS run as a bundle. The sandbox runs the slim engine,
  // which cannot boot in the harness (no embedded boot.iso), so harness-recorded bundles carry the
  // full engine's tag and are rejected here -- the browser has to record its own, and what it records
  // is exactly the startup path a user hits.
  if (typeof req === "object" && req.type === "jitexport") {
    (async () => {
      try {
        const tag = enginePromise ? await enginePromise.then(engineTagOf) : (cfg.engineTag || "");
        const bytes = NanoboxJit.exportBundle(tag);
        postMessage({ type: "nanobox-jitexport", tag, bytes }, [bytes.buffer]);
      } catch (e) { postMessage({ type: "nanobox-jitexport", error: String(e && e.message || e) }); }
    })();
    return;
  }
  if (MODE !== "plain") ev("start");
  const tty = new TtyClient(req);
  if (cfg && cfg.direct) startDirect(tty).catch((e) => ev("error", { message: "direct start: " + (e && e.message || e) }));
  else RunContainer.startContainer(info, args, tty);
};
