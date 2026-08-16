// nanobox/claude — the VM worker of web/sandbox.html: opt-worker.js (unchanged, imported as-is) plus
// what the first-run sandbox needs around it, hooked through the globals opt-worker.js looks up at
// call time (classic scripts share one global scope, so its `cfg`, `ev`, `NanoboxOci`, `NbRun`,
// `fetch` are all reachable here without editing it):
//   * cfg.packagesPort (MessagePort): the installer's packages ({key,name,version,meta,tar} — the
//     vendors' tarballs, gunzipped) arrive here and are grafted onto the image rootfs
//     (NanoboxInstaller.applyPackage) right after the OCI layers, BEFORE the container starts, so
//     the guest sees /usr/local/lib/node_modules/… and /usr/local/bin/{claude,codex,agy} as part
//     of the image. The engine download, the image layers and the installer all run in parallel;
//     the VM starts when all three are in.
//   * byte accounting: every fetch this worker makes (engine, image layers, JIT bundles, spec, the
//     shim) is counted per URL and posted to the page as {type:"nanobox-perf"} just before the VM
//     starts (the VM loop never yields afterwards, so it cannot be asked later).
importScripts(new URL("/opt-worker.js", location.href).href);
importScripts(new URL("/native/installer.js", location.href).href);   // NanoboxInstaller.applyPackage (wasifs/oci already loaded above)

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

// ---- installed packages -> the rootfs, before the container starts ---------------------------------
let nbPackages = null;   // Promise<packages[]> once init carried cfg.packagesPort
{
  const inner = self.onmessage;
  self.onmessage = (m) => {
    const d = m.data;
    if (d && typeof d === "object" && d.type === "init" && d.cfg && d.cfg.packagesPort) {
      const port = d.cfg.packagesPort;
      nbPackages = new Promise((res, rej) => { port.onmessage = (e) => { const x = e.data || {}; if (x.type === "packages") res(x.packages || []); else if (x.type === "error") rej(new Error(x.message)); }; });
      nbPackages.catch(() => {});
    }
    return inner(m);
  };
  const oci = self.NanoboxOci;
  self.NanoboxOci = Object.assign({}, oci, {
    async load(addr, opts) {
      const img = await oci.load(addr, opts);
      ev("image-loaded", { files: img.files, compressedBytes: img.compressedBytes, ms: Math.round(img.ms), cache: img.cache || null });
      if (nbPackages) {
        const tw = performance.now();
        const pkgs = await nbPackages;   // the installer may still be downloading: wait here (the engine fetch goes on in parallel)
        const waitMs = Math.round(performance.now() - tw);
        const ta = performance.now(); let files = 0;
        for (const p of pkgs) { const r = self.NanoboxInstaller.applyPackage(img.rootfs, p); files += r.files; }
        img.files += files;
        ev("packages-applied", { n: pkgs.length, files, waitMs, applyMs: Math.round(performance.now() - ta), keys: pkgs.map((p) => p.key) });
      }
      return img;
    },
  });
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
