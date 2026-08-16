// nanobox/claude — the VM worker of web/sandbox.html: opt-worker.js (unchanged, imported as-is) plus
// what the sandbox needs around it, hooked through the globals opt-worker.js looks up at call time
// (classic scripts share one global scope, so its `ev`, `NanoboxOci`, `NanoboxFs`, `NbRun`, `fetch`
// are all reachable here without editing it):
//   * cfg.persistPort (MessagePort from the persist worker, web/native/installer.js): the packages
//     ({key,name,version,meta,tar} — the vendors' tarballs, gunzipped) and the journals of earlier
//     sessions arrive here and are laid out in a second bundle subtree, bundle/persist/{usr/local,
//     root,home,var} (NanoboxInstaller.applyPackage / NanoboxOci.applyLayer), BEFORE the container
//     starts; the runtime spec bind-mounts /mnt/wasi0/bundle/persist/<p> onto /<p>, so the guest sees
//     node, npm and the CLIs under /usr/local and its home under /root — as part of the image. The
//     engine download, the image layers and the installer run in parallel; the VM starts when all are in.
//     (The 9p share is mounted cache=loose by the guest init; the engine's 9p qids for this tree are
//     the nodes' stable inode numbers, so the client's cache stays coherent across tmp+rename writes.)
//   * the persist subtree is WRITABLE (wasifs.js `writable`): every completed guest write under it
//     (file close/fsync, mkdir, unlink, rename, symlink) becomes a tar record with OCI whiteouts and
//     is posted back to the persist worker over the same port, which journals it to OPFS — so
//     ~/.claude, ~/.codex, `npm i -g …` survive page reloads and are shared by every page on the origin.
//   * byte accounting: every fetch this worker makes (engine, image layers, JIT bundles, spec, the
//     shim) is counted per URL and posted to the page as {type:"nanobox-perf"} just before the VM
//     starts (the VM loop never yields afterwards, so it cannot be asked later).
importScripts(new URL("/opt-worker.js", location.href).href);
importScripts(new URL("/native/installer.js", location.href).href);   // NanoboxInstaller (wasifs/oci already loaded above)

// ---- byte accounting -----------------------------------------------------------------------------
const nbNet = { requests: [] };
{
  const f0 = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = ((init && init.method) || (typeof input === "object" && !(input instanceof URL) && input.method) || "GET").toUpperCase();
    const t = performance.now();
    const r = await f0(input, init);
    const rec = { url, method, status: r.status, bytes: 0, ms: 0 };
    nbNet.requests.push(rec);
    if (method === "HEAD" || !r.body) { rec.ms = Math.round(performance.now() - t); return r; }
    const len = Number(r.headers.get("content-length")) || 0;
    if (len && r.status !== 206) { rec.bytes = len; rec.ms = Math.round(performance.now() - t); return r; }
    const counted = r.body.pipeThrough(new TransformStream({ transform(c, ctl) { rec.bytes += c.byteLength; ctl.enqueue(c); }, flush() { rec.ms = Math.round(performance.now() - t); } }));
    return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}

// ---- the persistent subtree ----------------------------------------------------------------------
const F = self.NanoboxFs, I = self.NanoboxInstaller;
let nbPersist = null;      // Promise<{packages, journals}> once init carried cfg.persistPort
let persistPort = null;
const persistDir = F.dir(); // becomes bundle/persist
let persistReady = false;
{
  const inner = self.onmessage;
  self.onmessage = (m) => {
    const d = m.data;
    if (d && typeof d === "object" && d.type === "init" && d.cfg && d.cfg.fslog) self.nbFsLog = true;
    if (d && typeof d === "object" && d.type === "init" && d.cfg && d.cfg.persistPort) {
      persistPort = d.cfg.persistPort;
      nbPersist = new Promise((res, rej) => { persistPort.onmessage = (e) => { const x = e.data || {}; if (x.type === "persist") res({ packages: x.packages || [], journals: x.journals || [] }); else if (x.type === "error") rej(new Error(x.message)); }; });
      nbPersist.catch(() => {});
    }
    return inner(m);
  };
  const oci = self.NanoboxOci;
  self.NanoboxOci = Object.assign({}, oci, {
    async load(addr, opts) {
      const img = await oci.load(addr, opts);
      ev("image-loaded", { files: img.files, compressedBytes: img.compressedBytes, ms: Math.round(img.ms), cache: img.cache || null });
      if (nbPersist) {
        const tw = performance.now();
        const { packages, journals } = await nbPersist;   // the installer may still be downloading: wait here (the engine fetch goes on in parallel)
        const waitMs = Math.round(performance.now() - tw);
        const ta = performance.now(); let files = 0;
        for (const p of packages) files += I.applyPackage(persistDir, p).files;
        for (const t of journals) files += oci.applyLayer(persistDir, t);
        // the mount points always exist; /var seeded from the image (var/tmp), the rest start empty
        for (const p of I.PERSIST_ROOTS) F.add(persistDir, p, { dir: true });
        const imgVar = F.lookup(img.rootfs, "var"), pVar = F.lookup(persistDir, "var");
        if (imgVar && pVar && !pVar.e.size) for (const [k, v] of imgVar.e) pVar.e.set(k, v);
        persistReady = true;
        ev("persist-applied", { packages: packages.length, journals: journals.length, files, waitMs, applyMs: Math.round(performance.now() - ta), keys: packages.map((p) => p.key) });
      }
      return img;
    },
  });
  // journal one wasifs change (from either share) back to the persist worker
  const journal = (root, strip) => (chg) => {
    if (!persistPort) return;
    try {
      const entries = I.journal.entries(root, chg, strip);
      if (!entries.length) return;
      const tar = I.tar.pack(entries);
      persistPort.postMessage({ type: "journal", tar: tar.buffer, op: chg.op, path: chg.path.slice(strip).join("/") }, [tar.buffer]);
    } catch (e) { ev("journal-error", { message: String(e && e.message || e) }); }
  };
  // the bundle share gets the persist subtree (writable — its /usr/local is what gets bind-mounted),
  // journaled back to the persist worker
  const attach0 = F.attach;
  F.attach = (imp, cfg) => {
    if (persistReady && cfg.root) cfg.root.e.set("persist", persistDir);
    const wcfg = Object.assign({
      writable: (path) => path[0] === "persist",
      onChange: journal(cfg.root, 1),
      // ?fslog=1: every mutating / opening 9p op on the persist subtree as an event (debugging)
      log: self.nbFsLog ? (name, args, r, path) => { if (/^(fd_read|fd_pread|fd_seek|fd_tell|fd_filestat_get|fd_fdstat_get|path_filestat_get|fd_readdir|path_readlink|fd_prestat)/.test(name)) return; if (path && !/^persist/.test(path) && name.startsWith("path_")) return; ev("fs", { share: cfg.name, op: name, path, r, a: name.startsWith("fd_") ? args[0] : undefined, x: name === "fd_filestat_set_size" ? String(args[1]) : name === "fd_pwrite" ? "off " + String(args[3]) : name === "fd_write" ? "n=" + args[2] : undefined }); } : undefined,
    }, cfg);
    ev("persist-attach", { persist: persistReady, share: cfg.name, fd: cfg.fd });
    return attach0(imp, wcfg);
  };
  // just before the VM starts: hand the page everything this worker fetched
  // (NbRun is an esbuild namespace object with getter-only exports: replace the object, not the property)
  const start0 = self.NbRun.startContainer;
  self.NbRun = Object.assign({}, self.NbRun, { startContainer: function () {
    try {
      const resources = (performance.getEntriesByType ? performance.getEntriesByType("resource") : []).map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }));
      postMessage({ type: "nanobox-perf", requests: nbNet.requests, resources, cache: self.NanoboxCache ? self.NanoboxCache.stats : null });
    } catch (e) {}
    return start0.apply(this, arguments);
  } });
  // content journaling: the guest's 9p client writes back after close, so wasifs reports a written
  // path once it has been quiet for a while — pumped from the engine's poll_oneoff (the VM loop
  // never yields; opt-worker.js already wraps WebAssembly.instantiate — this wraps its wrapper)
  const inst0 = WebAssembly.instantiate;
  WebAssembly.instantiate = function (src, imports) {
    const wasi = imports && imports.wasi_snapshot_preview1;
    if (wasi && wasi.poll_oneoff) {
      const poll = wasi.poll_oneoff; let last = 0;
      wasi.poll_oneoff = function () { const now = performance.now(); if (now - last > 100) { last = now; try { if (bundleFs && bundleFs.dirty) bundleFs.flushDirty(400); } catch (e) {} } return poll.apply(this, arguments); };
    }
    return inst0.call(WebAssembly, src, imports);
  };
}
