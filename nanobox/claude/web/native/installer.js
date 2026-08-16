// nanobox/claude — the FIRST-RUN INSTALLER: fetches the CLIs (claude | codex | agy) from the vendors'
// own servers, verifies them, and lays them out the way `npm install -g` would inside the rootfs the
// VM boots (web/sandbox.html). Nothing CLI-specific ships in our image (node-base = Linux + node 22).
//
//   claude  registry.npmjs.org  @anthropic-ai/claude-code@2.1.112 (the last release whose `bin` is
//           cli.js run by node; later versions download the Bun binary) [+ @img/sharp-linux-x64 /
//           @img/sharp-libvips-linux-x64 with opts.sharp]           -> direct fetch (registry answers CORS)
//   codex   @openai/codex@0.147.0 (bin/codex.js) + its linux-x64 platform package
//           @openai/codex@0.147.0-linux-x64 installed as the alias @openai/codex-linux-x64 under
//           @openai/codex/node_modules (exactly what npm does with "npm:" aliases)   -> direct fetch
//   agy     manifest https://antigravity-cli-auto-updater-…/manifests/linux_amd64.json -> {url, sha512}
//           -> cli_linux_x64.tar.gz (one file: `antigravity`) -> /usr/local/bin/agy 755
//           Neither host answers CORS: both requests go through the server's POST /net/fetch relay
//           (web/netpolicy.js allow-list, same request encoding as vm.html / the runtime worker).
//
// A "package" here is { key, name, version, tar, meta }: `tar` is the vendor's tarball gunzipped and
// otherwise UNTOUCHED (integrity: sha512 from the registry's dist.integrity / the agy manifest,
// checked before anything is unpacked); `meta` says where its content goes. Extraction is header
// parsing only (NanoboxOci.applyLayer: ustar / pax / GNU long names) and file contents stay views
// into the tar buffer, so applying ~500 MB of packages costs milliseconds and no copies.
//   NanoboxInstaller.applyPackage(rootfsTree, pkg)   grafts the package into a NanoboxFs tree:
//     usr/local/lib/node_modules/<name>/…  (+ node_modules/<alias> nesting), usr/local/bin/<bin>
//     symlinks (../lib/node_modules/<name>/<bin target>, target chmod +x), or plain files (agy).
// Persistence: each package's tar goes into the Cache API (NanoboxCache "nanobox-v1", key
// installed:v1:<name>@<version>) — the second visit re-applies from there, no network at all
// (the agy manifest is cached too, so its version sticks until `reset`).
//
//   NanoboxInstaller.install(["claude","codex"], { onProgress, relay, cache, sharp, noCache })
//     -> Promise<[{ cli, key, name, version, tar: Uint8Array, meta, files, unpackedBytes,
//                   download: { url, bytes, fromCache, ms, integrity } }, …]>
//   NanoboxInstaller.applyPackage(root, pkg) -> { files }
//   NanoboxInstaller.command(cli, pkgs)      -> the argv the guest runs for that CLI (+ env)
//
// Loads as: a classic worker script (`new Worker("/native/installer.js")` — messages below), an
// importScripts() library, or in node (globalThis.NanoboxInstaller; needs wasifs.js + oci.js first).
// Worker protocol: page -> {type:"install", clis, opts}; worker -> {type:"progress", …} … then
// {type:"installed", packages:[… tar transferred …], stats} or {type:"error", message}.
(function (global) {
  const F = () => global.NanoboxFs, Oci = () => global.NanoboxOci, Cache = () => global.NanoboxCache;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const REGISTRY = "https://registry.npmjs.org/";
  const AGY_MANIFEST = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json";
  const NM = "usr/local/lib/node_modules/";
  const KEYV = "installed:v1:";

  // what each CLI is made of. `into` = where the package directory lands (default NM + name);
  // `prune` = paths (relative to the package dir) not worth keeping in memory: other platforms'
  // vendored binaries (npm keeps them; they can never run in an x86-64 Linux guest)
  const CATALOG = {
    claude: {
      packages: [{ name: "@anthropic-ai/claude-code", version: "2.1.112", prune: /^vendor\/[^/]+\/(?!x64-linux\/|x64\/)[^/]+\// }],
      optional: { sharp: [
        { name: "@img/sharp-linux-x64", version: "0.34.2", into: NM + "@anthropic-ai/claude-code/node_modules/@img/sharp-linux-x64" },
        { name: "@img/sharp-libvips-linux-x64", version: "1.1.0", into: NM + "@anthropic-ai/claude-code/node_modules/@img/sharp-libvips-linux-x64" },
      ] },
    },
    codex: {
      packages: [
        { name: "@openai/codex", version: "0.147.0" },
        { name: "@openai/codex", version: "0.147.0-linux-x64", alias: "@openai/codex-linux-x64", into: NM + "@openai/codex/node_modules/@openai/codex-linux-x64" },
      ],
    },
    agy: { tarball: { name: "agy", manifest: AGY_MANIFEST, place: [{ from: "antigravity", to: "usr/local/bin/agy", mode: 0o755 }] } },
  };
  const CLIS = Object.keys(CATALOG);

  // ---- helpers -----------------------------------------------------------------------------------
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  async function sha512(bytes) { return new Uint8Array(await crypto.subtle.digest("SHA-512", bytes)); }
  async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }
  // the relay request encoding shared with vm.html's fetch override / the runtime worker
  function relayFetch(url) {
    const spec = { url, method: "GET", headers: {} };
    const encoded = btoa(String.fromCharCode(...enc.encode(JSON.stringify(spec)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const base = (global.location && global.location.origin && /^https?:/.test(global.location.origin)) ? global.location.origin : "http://localhost:8093";
    return fetch(new URL("/net/fetch", base), { method: "POST", headers: { "x-nanobox-target": encoded } });
  }
  // fetch a body, counting bytes; `via` = "direct" | "relay"
  async function getBytes(url, ctx, via, accept) {
    const t = performance.now();
    const doFetch = via === "relay" ? ctx.relay : ctx.fetch;
    const r = await doFetch(url, accept ? { headers: { accept } } : undefined);
    if (!r.ok) throw new Error(`${via} fetch ${url}: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const rec = { url, via, host: new URL(url).hostname, bytes: buf.length, ms: Math.round(performance.now() - t) };
    ctx.downloads.push(rec);
    ctx.progress({ stage: "fetched", url, via, bytes: buf.length, ms: rec.ms });
    return buf;
  }
  const keyOf = (name, version) => KEYV + name + "@" + version;

  // ---- one npm package -------------------------------------------------------------------------
  async function npmPackage(spec, cli, ctx) {
    const key = keyOf(spec.name, spec.version);
    const meta = { kind: "npm", name: spec.name, version: spec.version, alias: spec.alias || null, into: spec.into || NM + spec.name, prune: spec.prune ? spec.prune.source : null, bins: !spec.into || spec.into === NM + spec.name ? "auto" : "none" };
    const pkg = { cli, key, name: spec.name, version: spec.version, meta, tar: null, download: null };
    const t0 = performance.now();
    if (!ctx.noCache) {
      const cached = await ctx.cache.get(key).catch(() => null);
      if (cached) { pkg.tar = cached; pkg.download = { url: null, bytes: 0, fromCache: true, ms: Math.round(performance.now() - t0) }; ctx.progress({ stage: "cached", key, bytes: cached.length }); return finish(pkg, ctx); }
    }
    // resolve: the version document (a few KB) carries dist.tarball + dist.integrity
    const metaUrl = REGISTRY + spec.name + "/" + spec.version;
    ctx.progress({ stage: "resolve", key, url: metaUrl });
    const doc = JSON.parse(dec.decode(await getBytes(metaUrl, ctx, "direct")));
    if (!doc.dist || !doc.dist.tarball) throw new Error("registry: no dist.tarball for " + key);
    const tgz = await getBytes(doc.dist.tarball, ctx, "direct");
    // integrity: dist.integrity is an SRI string ("sha512-<base64>"), sometimes several
    const sri = String(doc.dist.integrity || "").split(/\s+/).find((s) => s.startsWith("sha512-"));
    if (sri) { const got = b64(await sha512(tgz)); if (got !== sri.slice(7)) throw new Error(`integrity mismatch for ${key}: registry ${sri.slice(7, 23)}… vs downloaded ${got.slice(0, 16)}…`); }
    else if (doc.dist.shasum) { const got = hex(new Uint8Array(await crypto.subtle.digest("SHA-1", tgz))); if (got !== doc.dist.shasum) throw new Error(`shasum mismatch for ${key}`); }
    ctx.progress({ stage: "verified", key, integrity: sri ? "sha512" : doc.dist.shasum ? "sha1" : "none" });
    const tu = performance.now();
    pkg.tar = await gunzip(tgz);
    pkg.download = { url: doc.dist.tarball, bytes: tgz.length, fromCache: false, ms: Math.round(performance.now() - t0), gunzipMs: Math.round(performance.now() - tu), integrity: sri || ("sha1-" + doc.dist.shasum) };
    if (!ctx.noCache) ctx.cache.put(key, pkg.tar).catch(() => {});
    return finish(pkg, ctx);
  }

  // ---- a plain tarball (agy) ---------------------------------------------------------------------
  async function tarballPackage(spec, cli, ctx) {
    const t0 = performance.now();
    const manKey = KEYV + spec.name + "-manifest";
    let manifest = null;
    if (!ctx.noCache) { const c = await ctx.cache.get(manKey).catch(() => null); if (c) manifest = JSON.parse(dec.decode(c)); }
    if (!manifest) {
      ctx.progress({ stage: "resolve", key: KEYV + spec.name, url: spec.manifest, via: "relay" });
      manifest = JSON.parse(dec.decode(await getBytes(spec.manifest, ctx, "relay")));
      if (!manifest.url || !manifest.sha512) throw new Error("agy manifest: no url/sha512");
    }
    const key = keyOf(spec.name, manifest.version || "unknown");
    const meta = { kind: "tarball", name: spec.name, version: manifest.version, place: spec.place, url: manifest.url };
    const pkg = { cli, key, name: spec.name, version: manifest.version, meta, tar: null, download: null };
    if (!ctx.noCache) {
      const cached = await ctx.cache.get(key).catch(() => null);
      if (cached) { pkg.tar = cached; pkg.download = { url: null, bytes: 0, fromCache: true, ms: Math.round(performance.now() - t0) }; ctx.progress({ stage: "cached", key, bytes: cached.length }); return finish(pkg, ctx); }
    }
    const tgz = await getBytes(manifest.url, ctx, "relay");
    const got = hex(await sha512(tgz));
    if (got !== manifest.sha512.toLowerCase()) throw new Error(`sha512 mismatch for ${key}: manifest ${manifest.sha512.slice(0, 16)}… vs downloaded ${got.slice(0, 16)}…`);
    ctx.progress({ stage: "verified", key, integrity: "sha512" });
    const tu = performance.now();
    pkg.tar = await gunzip(tgz);
    pkg.download = { url: manifest.url, bytes: tgz.length, fromCache: false, ms: Math.round(performance.now() - t0), gunzipMs: Math.round(performance.now() - tu), integrity: "sha512-hex" };
    if (!ctx.noCache) { ctx.cache.put(key, pkg.tar).catch(() => {}); ctx.cache.put(manKey, enc.encode(JSON.stringify(manifest))).catch(() => {}); }
    return finish(pkg, ctx);
  }

  // dry-run apply into a scratch tree: file count + unpacked size (also validates the tar early)
  function finish(pkg, ctx) {
    const root = F().dir();
    const r = applyPackage(root, pkg);
    pkg.files = r.files; pkg.unpackedBytes = r.bytes;
    ctx.progress({ stage: "package", key: pkg.key, files: r.files, unpackedBytes: r.bytes, fromCache: !!(pkg.download && pkg.download.fromCache) });
    return pkg;
  }

  // ---- laying a package out in a NanoboxFs tree ------------------------------------------------
  function walk(node, fn, path) {
    if (node.t !== "d") { fn(path, node); return; }
    for (const [k, v] of node.e) walk(v, fn, path ? path + "/" + k : k);
  }
  function applyPackage(root, pkg) {
    const Fs = F(), meta = pkg.meta;
    const tmp = Fs.dir();
    Oci().applyLayer(tmp, pkg.tar);
    let files = 0, bytes = 0;
    if (meta.kind === "npm") {
      // npm strips the first path component (usually "package/") whatever it is called
      let top = tmp.e.get("package"); if (!top) { const dirs = [...tmp.e.values()].filter((n) => n.t === "d"); if (dirs.length === 1) top = dirs[0]; }
      if (!top) throw new Error("npm tarball without a top-level directory: " + pkg.key);
      if (meta.prune) { const re = new RegExp(meta.prune); const gone = []; walk(top, (p) => { if (re.test(p)) gone.push(p); }, ""); for (const p of gone) Fs.remove(top, p); }
      // graft the package directory at `into` (replacing whatever was there)
      const parts = meta.into.split("/").filter(Boolean); const parent = Fs.add(root, parts.slice(0, -1).join("/"), { dir: true });
      parent.e.set(parts[parts.length - 1], top);
      // bin links like npm -g: usr/local/bin/<bin> -> ../lib/node_modules/<name>/<target>, target 755
      if (meta.bins === "auto") {
        const pj = Fs.lookup(top, "package.json");
        if (pj && pj.t === "f") {
          const json = JSON.parse(dec.decode(pj.data));
          let bins = json.bin; if (typeof bins === "string") bins = { [json.name.split("/").pop()]: bins };
          for (const [bin, target] of Object.entries(bins || {})) {
            const rel = String(target).replace(/^\.?\//, "");
            const t = Fs.lookup(top, rel); if (t && t.t === "f") t.mode = ((t.mode != null ? t.mode : 0o644) | 0o111) & 0o7777;
            Fs.add(root, "usr/local/bin/" + bin, { symlink: "../lib/node_modules/" + meta.name + "/" + rel });
            files++;
          }
        }
      }
      walk(top, (p, n) => { if (n.t === "f") { files++; bytes += n.data.byteLength; } else files++; }, "");
    } else if (meta.kind === "tarball") {
      for (const pl of meta.place) {
        const n = Fs.lookup(tmp, pl.from);
        if (!n) throw new Error(`tarball ${pkg.key}: no entry ${pl.from}`);
        if (n.t === "f") { Fs.add(root, pl.to, { data: n.data, mode: pl.mode != null ? pl.mode : (n.mode != null ? n.mode : 0o644) }); files++; bytes += n.data.byteLength; }
        else { const parts = pl.to.split("/").filter(Boolean); const parent = Fs.add(root, parts.slice(0, -1).join("/"), { dir: true }); parent.e.set(parts[parts.length - 1], n); walk(n, (p, m) => { files++; if (m.t === "f") bytes += m.data.byteLength; }, ""); }
      }
    } else throw new Error("unknown package kind " + meta.kind);
    return { files, bytes };
  }

  // ---- what the guest runs -----------------------------------------------------------------------
  // claude: /usr/local/bin/claude -> cli.js, `#!/usr/bin/env node` -> the system-node shim (/bundle/nb/node)
  //         -> the JS runs on the browser's V8 (docs/system-node.md);
  // codex:  the native binary of the platform package directly (what bin/codex.js would spawn — with the
  //         env it would set — minus a node process to spawn it from; the guest is x86-64 Linux);
  // agy:    the native binary.
  function command(cli) {
    if (cli === "claude") return { argv: ["/usr/local/bin/claude"], env: {} };
    if (cli === "codex") return { argv: ["/" + NM + "@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"], env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: "/" + NM + "@openai/codex" } };
    if (cli === "agy") return { argv: ["/usr/local/bin/agy"], env: {} };
    throw new Error("unknown cli " + cli);
  }

  // ---- install -------------------------------------------------------------------------------------
  async function install(clis, opts) {
    opts = opts || {};
    const ctx = {
      fetch: opts.fetch || ((u, i) => fetch(u, i)),
      relay: opts.relay || relayFetch,
      cache: opts.cache || { get: (k) => Cache().getBytes(k), put: (k, b) => Cache().putBytes(k, b) },
      noCache: !!opts.noCache,
      progress: opts.onProgress || (() => {}),
      downloads: [],
    };
    const jobs = [];
    for (const cli of clis) {
      const c = CATALOG[cli]; if (!c) throw new Error("unknown cli " + cli + " (have " + CLIS.join(", ") + ")");
      for (const p of c.packages || []) jobs.push(npmPackage(p, cli, ctx));
      if (c.optional) for (const [flag, list] of Object.entries(c.optional)) if (opts[flag]) for (const p of list) jobs.push(npmPackage(p, cli, ctx));
      if (c.tarball) jobs.push(tarballPackage(c.tarball, cli, ctx));
    }
    const t0 = performance.now();
    const packages = await Promise.all(jobs);
    const stats = { ms: Math.round(performance.now() - t0), downloads: ctx.downloads, direct: ctx.downloads.filter((d) => d.via === "direct").reduce((s, d) => s + d.bytes, 0), relayed: ctx.downloads.filter((d) => d.via === "relay").reduce((s, d) => s + d.bytes, 0), fromCache: packages.filter((p) => p.download && p.download.fromCache).length, packages: packages.length };
    return { packages, stats };
  }

  global.NanoboxInstaller = { install, applyPackage, command, CATALOG, CLIS, KEYV };

  // ---- as a dedicated worker -------------------------------------------------------------------
  if (typeof importScripts === "function" && typeof self !== "undefined" && self.constructor && self.constructor.name === "DedicatedWorkerGlobalScope" && !global.NanoboxFs) {
    importScripts(new URL("/wasifs.js", location.href).href, new URL("/oci.js", location.href).href, new URL("/cachefetch.js", location.href).href);
    self.onmessage = async (m) => {
      const d = m.data; if (!d || d.type !== "install") return;
      const T0 = performance.now();
      try {
        const { packages, stats } = await install(d.clis, Object.assign({}, d.opts || {}, { onProgress: (p) => self.postMessage(Object.assign({ type: "progress", t: Math.round(performance.now() - T0) }, p)) }));
        const out = packages.map((p) => ({ cli: p.cli, key: p.key, name: p.name, version: p.version, meta: p.meta, files: p.files, unpackedBytes: p.unpackedBytes, download: p.download, tar: p.tar }));
        // the tars are transferred (moved) to the page; it hands them on to the VM worker (and a copy of the claude one to the runtime worker)
        const buffers = out.map((p) => p.tar.buffer);
        self.postMessage({ type: "installed", packages: out, stats, ms: Math.round(performance.now() - T0), resources: performance.getEntriesByType ? performance.getEntriesByType("resource").map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })) : [] }, buffers);
      } catch (e) { self.postMessage({ type: "error", message: String(e && e.stack || e) }); }
    };
  }
})(typeof self !== "undefined" ? self : globalThis);
