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
  // the bundle share gets the persist subtree, writable, journaled back to the persist worker
  const attach0 = F.attach;
  F.attach = (imp, cfg) => {
    if (persistReady && cfg.root) cfg.root.e.set("persist", persistDir);
    const wcfg = Object.assign({
      writable: (path) => path[0] === "persist",
      onChange: (chg) => {
        if (!persistPort) return;
        try {
          const entries = I.journal.entries(cfg.root, chg);
          if (!entries.length) return;
          const tar = I.tar.pack(entries);
          persistPort.postMessage({ type: "journal", tar: tar.buffer, op: chg.op, path: chg.path.slice(1).join("/") }, [tar.buffer]);
        } catch (e) { ev("journal-error", { message: String(e && e.message || e) }); }
      },
    }, cfg);
    return attach0(imp, wcfg);
  };
  // just before the VM starts: hand the page everything this worker fetched
  const start0 = self.NbRun.startContainer;
  self.NbRun.startContainer = function () {
    try {
      const resources = (performance.getEntriesByType ? performance.getEntriesByType("resource") : []).map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }));
      postMessage({ type: "nanobox-perf", requests: nbNet.requests, resources, cache: self.NanoboxCache ? self.NanoboxCache.stats : null });
    } catch (e) {}
    return start0.apply(this, arguments);
  };
}
