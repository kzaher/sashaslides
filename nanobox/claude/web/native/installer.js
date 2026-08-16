// nanobox/claude — the FIRST-RUN INSTALLER + the PERSISTENT TREE of the sandbox (web/sandbox.html).
//
// The image the VM boots (linux-base) is busybox + glibc + libstdc++ and nothing else. Everything the
// CLIs need is fetched from the vendors' own servers at first run, verified, and laid out the way
// `npm install -g` would inside ONE host-side writable tree that persists in the browser (OPFS;
// Cache API fallback), is shared by every page on this origin, and is mounted into the container over
// /usr/local, /root, /home, /var (bind mounts in the runtime spec, tools/genspec-vm.mjs --persist):
//
//   node    node-linux-x64@22.23.2 (registry.npmjs.org, 51.6 MB gz: bin/node + include + share) -> /usr/local
//           + npm@10.9.8 (the npm that ships with that node) -> /usr/local/lib/node_modules/npm, bin/npm, bin/npx
//   claude  @anthropic-ai/claude-code@2.1.112 (the last release whose `bin` is cli.js run by node; later
//           versions download the Bun binary) [+ @img/sharp-linux-x64 / @img/sharp-libvips-linux-x64 with
//           opts.sharp]                                                    -> direct fetch (registry answers CORS)
//   codex   @openai/codex@0.147.0 (bin/codex.js) + its linux-x64 platform package @openai/codex@0.147.0-linux-x64
//           installed as the alias @openai/codex-linux-x64 under @openai/codex/node_modules (what npm does
//           with "npm:" aliases)                                            -> direct fetch
//   agy     manifest https://antigravity-cli-auto-updater-…/manifests/linux_amd64.json -> {url, sha512}
//           -> cli_linux_x64.tar.gz (one file: `antigravity`) -> /usr/local/bin/agy 755. Neither host answers
//           CORS: both go through the server's POST /net/fetch relay (web/netpolicy.js allow-list, the same
//           request encoding as vm.html / the runtime worker).
//
// A "package" is { key, name, version, tar, meta }: `tar` = the vendor's tarball gunzipped and otherwise
// UNTOUCHED (integrity: sha512 from the registry's dist.integrity / the agy manifest, checked before
// anything is unpacked), `meta` = where its content goes. Extraction is header parsing only
// (NanoboxOci.applyLayer: ustar / pax / GNU long names); file contents stay views into the tar buffer.
//   NanoboxInstaller.applyPackage(tree, pkg)   grafts a package into a NanoboxFs tree ({files, bytes})
//   NanoboxInstaller.install(clis, opts)       resolve + fetch + verify the packages of `clis` (+ node)
//   NanoboxInstaller.command(cli)              what the guest runs for a CLI (argv + env)
//   NanoboxInstaller.tar.pack(entries)         a tar writer (journals)
//   NanoboxInstaller.journal.*                 guest writes -> tar records with OCI whiteouts, compaction
//   NanoboxInstaller.store.open()              the persistent store: OPFS dir "nanobox-persist" (or Cache API)
//       packages/<key>.tar + .json (immutable), journal/<t>-<n>.tar (guest writes, applied in name order)
//
// As a dedicated worker (`new Worker("/native/installer.js")` — the sandbox's PERSIST WORKER):
//   page -> {type:"open", clis, opts:{noCache, sharp, reset}, vmPort, runtimePort?}
//   worker -> page: {type:"progress",…} … {type:"ready", summary} | {type:"error", message}
//   worker -> vmPort: {type:"persist", packages:[…tars transferred…], journals:[…]}  (runtimePort: copies of
//             claude's packages + the journals)
//   vmPort -> worker: {type:"journal", tar}  guest writes from the VM worker, batched into journal/*.tar
// Also loadable with importScripts() (needs wasifs.js + oci.js + cachefetch.js first) and in node.
(function (global) {
  const F = () => global.NanoboxFs, Oci = () => global.NanoboxOci;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const REGISTRY = "https://registry.npmjs.org/";
  const AGY_MANIFEST = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json";
  const NM = "usr/local/lib/node_modules/";
  const KEYV = "pkg-";   // store file names: packages/<KEYV><name with / as ~>@<version>.tar
  const PERSIST_ROOTS = ["usr/local", "root", "home", "var"];   // must match tools/genspec-vm.mjs --persist

  // what each CLI is made of. `into` = where the package directory's CONTENT is merged (default NM+name);
  // `bins` "auto" = usr/local/bin/<bin> -> ../lib/node_modules/<name>/<target> from package.json (like npm -g);
  // `prune` = paths (relative to the package dir) not worth keeping in memory (other platforms' binaries)
  const CATALOG = {
    node: {
      packages: [
        { name: "node-linux-x64", version: "22.23.2", into: "usr/local", bins: "none", prune: /^(package\.json|README\.md|CHANGELOG\.md|LICENSE)$/ },
        { name: "npm", version: "10.9.8" },   // the npm that node 22.23.2 ships (node-linux-x64 carries none)
      ],
    },
    claude: {
      packages: [{ name: "@anthropic-ai/claude-code", version: "2.1.112", prune: /^vendor\/[^/]+\/(?!x64-linux\/|x64\/)[^/]+\// }],
      optional: { sharp: [
        { name: "@img/sharp-linux-x64", version: "0.34.2", into: NM + "@anthropic-ai/claude-code/node_modules/@img/sharp-linux-x64", bins: "none" },
        { name: "@img/sharp-libvips-linux-x64", version: "1.1.0", into: NM + "@anthropic-ai/claude-code/node_modules/@img/sharp-libvips-linux-x64", bins: "none" },
      ] },
    },
    codex: {
      packages: [
        { name: "@openai/codex", version: "0.147.0" },
        { name: "@openai/codex", version: "0.147.0-linux-x64", alias: "@openai/codex-linux-x64", into: NM + "@openai/codex/node_modules/@openai/codex-linux-x64", bins: "none" },
      ],
    },
    agy: { tarball: { name: "agy", manifest: AGY_MANIFEST, place: [{ from: "antigravity", to: "usr/local/bin/agy", mode: 0o755 }] } },
  };
  const CLIS = Object.keys(CATALOG).filter((c) => c !== "node");

  // ---- helpers -----------------------------------------------------------------------------------
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  async function sha512(bytes) { return new Uint8Array(await crypto.subtle.digest("SHA-512", bytes)); }
  async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }
  const keyOf = (name, version) => KEYV + name.replace(/\//g, "~") + "@" + version;
  // the relay request encoding shared with vm.html's fetch override / the runtime worker
  function relayFetch(url) {
    const spec = { url, method: "GET", headers: {} };
    const encoded = btoa(String.fromCharCode(...enc.encode(JSON.stringify(spec)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const base = (global.location && global.location.origin && /^https?:/.test(global.location.origin)) ? global.location.origin : "http://localhost:8093";
    return fetch(new URL("/net/fetch", base), { method: "POST", headers: { "x-nanobox-target": encoded } });
  }
  async function getBytes(url, ctx, via) {
    const t = performance.now();
    const r = await (via === "relay" ? ctx.relay : ctx.fetch)(url);
    if (!r.ok) throw new Error(`${via} fetch ${url}: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const rec = { url, via, host: new URL(url).hostname, bytes: buf.length, ms: Math.round(performance.now() - t) };
    ctx.downloads.push(rec);
    ctx.progress({ stage: "fetched", url, via, bytes: buf.length, ms: rec.ms });
    return buf;
  }

  // ---- one npm package -------------------------------------------------------------------------
  function npmMeta(spec) {
    return { kind: "npm", name: spec.name, version: spec.version, alias: spec.alias || null, into: spec.into || NM + spec.name, prune: spec.prune ? spec.prune.source : null, bins: spec.bins || "auto" };
  }
  async function npmPackage(spec, cli, ctx) {
    const key = keyOf(spec.name, spec.version), meta = npmMeta(spec);
    const pkg = { cli, key, name: spec.name, version: spec.version, meta, tar: null, download: null };
    const t0 = performance.now();
    const have = await ctx.have(key);
    if (have) { pkg.tar = have; pkg.download = { url: null, bytes: 0, fromCache: true, ms: Math.round(performance.now() - t0) }; ctx.progress({ stage: "cached", key, bytes: have.length }); return finish(pkg, ctx); }
    const metaUrl = REGISTRY + spec.name + "/" + spec.version;   // the version document: dist.tarball + dist.integrity
    ctx.progress({ stage: "resolve", key, url: metaUrl });
    const doc = JSON.parse(dec.decode(await getBytes(metaUrl, ctx, "direct")));
    if (!doc.dist || !doc.dist.tarball) throw new Error("registry: no dist.tarball for " + key);
    const tgz = await getBytes(doc.dist.tarball, ctx, "direct");
    const sri = String(doc.dist.integrity || "").split(/\s+/).find((s) => s.startsWith("sha512-"));
    if (sri) { const got = b64(await sha512(tgz)); if (got !== sri.slice(7)) throw new Error(`integrity mismatch for ${key}: registry ${sri.slice(7, 23)}… vs downloaded ${got.slice(0, 16)}…`); }
    else if (doc.dist.shasum) { const got = hex(new Uint8Array(await crypto.subtle.digest("SHA-1", tgz))); if (got !== doc.dist.shasum) throw new Error(`shasum mismatch for ${key}`); }
    ctx.progress({ stage: "verified", key, integrity: sri ? "sha512" : doc.dist.shasum ? "sha1" : "none" });
    const tu = performance.now();
    pkg.tar = await gunzip(tgz);
    pkg.download = { url: doc.dist.tarball, bytes: tgz.length, fromCache: false, ms: Math.round(performance.now() - t0), gunzipMs: Math.round(performance.now() - tu), integrity: sri || ("sha1-" + doc.dist.shasum) };
    await ctx.keep(key, pkg);
    return finish(pkg, ctx);
  }

  // ---- a plain tarball (agy) ---------------------------------------------------------------------
  async function tarballPackage(spec, cli, ctx) {
    const t0 = performance.now();
    const manKey = KEYV + spec.name + "-manifest";
    let manifest = null;
    const cm = await ctx.have(manKey); if (cm) manifest = JSON.parse(dec.decode(cm));
    if (!manifest) {
      ctx.progress({ stage: "resolve", key: KEYV + spec.name, url: spec.manifest, via: "relay" });
      manifest = JSON.parse(dec.decode(await getBytes(spec.manifest, ctx, "relay")));
      if (!manifest.url || !manifest.sha512) throw new Error("agy manifest: no url/sha512");
    }
    const key = keyOf(spec.name, manifest.version || "unknown");
    const meta = { kind: "tarball", name: spec.name, version: manifest.version, place: spec.place, url: manifest.url };
    const pkg = { cli, key, name: spec.name, version: manifest.version, meta, tar: null, download: null };
    const have = await ctx.have(key);
    if (have) { pkg.tar = have; pkg.download = { url: null, bytes: 0, fromCache: true, ms: Math.round(performance.now() - t0) }; ctx.progress({ stage: "cached", key, bytes: have.length }); return finish(pkg, ctx); }
    const tgz = await getBytes(manifest.url, ctx, "relay");
    const got = hex(await sha512(tgz));
    if (got !== manifest.sha512.toLowerCase()) throw new Error(`sha512 mismatch for ${key}: manifest ${manifest.sha512.slice(0, 16)}… vs downloaded ${got.slice(0, 16)}…`);
    ctx.progress({ stage: "verified", key, integrity: "sha512" });
    const tu = performance.now();
    pkg.tar = await gunzip(tgz);
    pkg.download = { url: manifest.url, bytes: tgz.length, fromCache: false, ms: Math.round(performance.now() - t0), gunzipMs: Math.round(performance.now() - tu), integrity: "sha512-hex" };
    await ctx.keep(key, pkg);
    await ctx.keep(manKey, { tar: enc.encode(JSON.stringify(manifest)), meta: { kind: "manifest" } });
    return finish(pkg, ctx);
  }
  // dry-run apply into a scratch tree: file count + unpacked size (validates the tar early)
  function finish(pkg, ctx) {
    const r = applyPackage(F().dir(), pkg);
    pkg.files = r.files; pkg.unpackedBytes = r.bytes;
    ctx.progress({ stage: "package", key: pkg.key, files: r.files, unpackedBytes: r.bytes, fromCache: !!(pkg.download && pkg.download.fromCache) });
    return pkg;
  }

  // ---- laying a package out in a NanoboxFs tree ------------------------------------------------
  function walk(node, fn, path) { if (node.t !== "d") { fn(path, node); return; } for (const [k, v] of node.e) walk(v, fn, path ? path + "/" + k : k); }
  // merge src's entries into the directory at `into` (creating it); src entries override, dirs merge
  function mergeInto(root, into, src) {
    const Fs = F(); const dst = Fs.add(root, into, { dir: true });
    const rec = (d, s) => { for (const [k, v] of s.e) { const cur = d.e.get(k); if (v.t === "d" && cur && cur.t === "d") rec(cur, v); else d.e.set(k, v); } };
    rec(dst, src);
    return dst;
  }
  function applyPackage(root, pkg) {
    const Fs = F(), meta = pkg.meta;
    const tmp = Fs.dir();
    Oci().applyLayer(tmp, pkg.tar);
    let files = 0, bytes = 0;
    if (meta.kind === "npm") {
      let top = tmp.e.get("package"); if (!top) { const dirs = [...tmp.e.values()].filter((n) => n.t === "d"); if (dirs.length === 1) top = dirs[0]; }   // npm strips the first component whatever it is
      if (!top) throw new Error("npm tarball without a top-level directory: " + pkg.key);
      let bins = {};
      const pj = Fs.lookup(top, "package.json");
      if (pj && pj.t === "f" && meta.bins === "auto") { const json = JSON.parse(dec.decode(pj.data)); bins = json.bin || {}; if (typeof bins === "string") bins = { [json.name.split("/").pop()]: bins }; }
      if (meta.prune) { const re = new RegExp(meta.prune); const gone = []; walk(top, (p) => { if (re.test(p)) gone.push(p); }, ""); for (const p of gone) Fs.remove(top, p); }
      walk(top, (p, n) => { files++; if (n.t === "f") bytes += n.data.byteLength; }, "");
      mergeInto(root, meta.into, top);
      // bin links like npm -g: usr/local/bin/<bin> -> ../lib/node_modules/<name>/<target>, target 755
      for (const [bin, target] of Object.entries(bins)) {
        const rel = String(target).replace(/^\.?\//, "");
        const t = Fs.lookup(top, rel); if (t && t.t === "f") t.mode = ((t.mode != null ? t.mode : 0o644) | 0o111) & 0o7777;
        Fs.add(root, "usr/local/bin/" + bin, { symlink: "../lib/node_modules/" + meta.name + "/" + rel }); files++;
      }
    } else if (meta.kind === "tarball") {
      for (const pl of meta.place) {
        const n = Fs.lookup(tmp, pl.from);
        if (!n) throw new Error(`tarball ${pkg.key}: no entry ${pl.from}`);
        if (n.t === "f") { Fs.add(root, pl.to, { data: n.data, mode: pl.mode != null ? pl.mode : (n.mode != null ? n.mode : 0o644) }); files++; bytes += n.data.byteLength; }
        else { mergeInto(root, pl.to, n); walk(n, (p, m) => { files++; if (m.t === "f") bytes += m.data.byteLength; }, ""); }
      }
    } else throw new Error("unknown package kind " + meta.kind);
    return { files, bytes };
  }

  // ---- what the guest runs -----------------------------------------------------------------------
  // claude: /usr/local/bin/claude -> cli.js, `#!/usr/bin/env node` -> with PATH=/bundle/nb:... (config-vm.json)
  //         the system-node shim -> the JS runs on the browser's V8 (docs/system-node.md);
  // codex:  the platform package's native binary directly (what bin/codex.js would spawn, with the env it
  //         would set — minus a node process to spawn it from; the guest is x86-64 Linux); PATH is the
  //         plain one (config-persist.json) so a child `node` is the real /usr/local/bin/node;
  // agy:    the native binary, same.
  function command(cli) {
    if (cli === "claude") return { argv: ["/usr/local/bin/claude"], env: {}, spec: "config-vm.json", shim: true };
    if (cli === "codex") return { argv: ["/" + NM + "@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"], env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: "/" + NM + "@openai/codex" }, spec: "config-persist.json", shim: false };
    if (cli === "agy") return { argv: ["/usr/local/bin/agy"], env: {}, spec: "config-persist.json", shim: false };
    throw new Error("unknown cli " + cli);
  }
  // the package specs a set of CLIs needs (node first)
  function packagesFor(clis, opts) {
    const out = [];
    for (const cli of ["node", ...clis.filter((c) => c !== "node")]) {
      const c = CATALOG[cli]; if (!c) throw new Error("unknown cli " + cli + " (have " + CLIS.join(", ") + ")");
      for (const p of c.packages || []) out.push({ cli, npm: p });
      if (c.optional) for (const [flag, list] of Object.entries(c.optional)) if (opts && opts[flag]) for (const p of list) out.push({ cli, npm: p });
      if (c.tarball) out.push({ cli, tarball: c.tarball });
    }
    return out;
  }

  // ---- install -------------------------------------------------------------------------------------
  // opts.have(key) -> Uint8Array|null (already stored), opts.keep(key, pkg) (store it); default: none (memory only)
  async function install(clis, opts) {
    opts = opts || {};
    const ctx = {
      fetch: opts.fetch || ((u, i) => fetch(u, i)),
      relay: opts.relay || relayFetch,
      have: opts.noCache ? async () => null : (opts.have || (async () => null)),
      keep: opts.keep || (async () => {}),
      progress: opts.onProgress || (() => {}),
      downloads: [],
    };
    const t0 = performance.now();
    const packages = await Promise.all(packagesFor(clis, opts).map((j) => (j.npm ? npmPackage(j.npm, j.cli, ctx) : tarballPackage(j.tarball, j.cli, ctx))));
    const stats = { ms: Math.round(performance.now() - t0), downloads: ctx.downloads, direct: ctx.downloads.filter((d) => d.via === "direct").reduce((s, d) => s + d.bytes, 0), relayed: ctx.downloads.filter((d) => d.via === "relay").reduce((s, d) => s + d.bytes, 0), fromCache: packages.filter((p) => p.download && p.download.fromCache).length, packages: packages.length };
    return { packages, stats };
  }

  // ---- tar writer (journals) -----------------------------------------------------------------------
  // entries: [{ path, type: "f"|"d"|"l", data?, target?, mode? }]; long names via GNU 'L'/'K' records
  // (what NanoboxOci.applyLayer reads back). Timestamps 0, uid/gid 0.
  function tarPack(entries) {
    const blocks = [];
    const header = (name, size, type, link, mode) => {
      const h = new Uint8Array(512);
      const put = (off, len, s) => { const b = enc.encode(s); h.set(b.subarray(0, len), off); };
      const oct = (off, len, n) => put(off, len, n.toString(8).padStart(len - 1, "0") + "\0");
      put(0, 100, name); oct(100, 8, mode); oct(108, 8, 0); oct(116, 8, 0); oct(124, 12, size); oct(136, 12, 0);
      h.set(enc.encode("        "), 148); h[156] = type.charCodeAt(0); put(157, 100, link); put(257, 6, "ustar\0"); put(263, 2, "00");
      let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
      put(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
      return h;
    };
    const pushData = (u8) => { blocks.push(u8); const pad = (512 - (u8.byteLength % 512)) % 512; if (pad) blocks.push(new Uint8Array(pad)); };
    for (const e of entries) {
      let name = e.path, link = e.target || "";
      if (enc.encode(name).length > 100) { const b = enc.encode(name + "\0"); blocks.push(header("././@LongLink", b.length, "L", "", 0o644)); pushData(b); name = name.slice(0, 100); }
      if (enc.encode(link).length > 100) { const b = enc.encode(link + "\0"); blocks.push(header("././@LongLink", b.length, "K", "", 0o644)); pushData(b); link = link.slice(0, 100); }
      if (e.type === "d") blocks.push(header(name.replace(/\/?$/, "/"), 0, "5", "", e.mode != null ? e.mode : 0o755));
      else if (e.type === "l") blocks.push(header(name, 0, "2", link, 0o777));
      else { const d = e.data || new Uint8Array(0); blocks.push(header(name, d.byteLength, "0", "", e.mode != null ? e.mode : 0o644)); pushData(d); }
    }
    blocks.push(new Uint8Array(1024));
    const n = blocks.reduce((s, b) => s + b.byteLength, 0), out = new Uint8Array(n); let k = 0;
    for (const b of blocks) { out.set(b, k); k += b.byteLength; }
    return out;
  }
  // a subtree as tar entries (paths relative to `prefix`)
  function entriesOf(node, prefix, out) {
    out = out || [];
    if (node.t === "d") { out.push({ path: prefix, type: "d", mode: node.mode }); for (const [k, v] of node.e) entriesOf(v, prefix + "/" + k, out); }
    else if (node.t === "l") out.push({ path: prefix, type: "l", target: node.target });
    else out.push({ path: prefix, type: "f", data: (typeof node.data === "function" ? node.data() : node.data).slice(), mode: node.mode });   // copy: the tree keeps changing
    return out;
  }
  const whiteout = (path) => { const i = path.lastIndexOf("/"); return { path: (i >= 0 ? path.slice(0, i + 1) : "") + ".wh." + path.slice(i + 1), type: "f", data: new Uint8Array(0) }; };
  // one wasifs onChange event -> tar entries relative to the persist root (path[0] === "persist" is dropped)
  function journalEntries(root, ev) {
    const rel = (p) => p.slice(1).join("/");
    const cur = (p) => F().lookup(root, p.join("/"));
    switch (ev.op) {
      case "write": case "mkdir": case "symlink": case "link": { const n = cur(ev.path); return n ? entriesOf(n, rel(ev.path)) : [whiteout(rel(ev.path))]; }
      case "remove": return [whiteout(rel(ev.path))];
      case "rename": { const n = cur(ev.to); return [whiteout(rel(ev.path))].concat(n ? entriesOf(n, rel(ev.to)) : []); }
      default: return [];
    }
  }
  // journals concatenated in order ARE a valid combined layer (later records win); compaction keeps only
  // the last record per path (parsing headers only, no data copies until the final pack)
  function journalCompact(tars) {
    const root = F().dir(); const touched = new Set();
    for (const t of tars) { Oci().applyLayer(root, t); collectPaths(t, touched); }
    const entries = [];
    for (const p of touched) { const n = F().lookup(root, p); if (n) { if (n.t === "d") entries.push({ path: p, type: "d", mode: n.mode }); else entries.push(...entriesOf(n, p)); } else entries.push(whiteout(p)); }
    return tarPack(entries);
  }
  function collectPaths(tar, set) {
    // reuse applyLayer's parsing by applying into a scratch dir and walking it, plus whiteout names
    const scratch = F().dir(); Oci().applyLayer(scratch, tar);
    walk(scratch, (p) => set.add(p), ""); (function dirs(d, pre) { for (const [k, v] of d.e) if (v.t === "d") { set.add(pre + k); dirs(v, pre + k + "/"); } })(scratch, "");
    // whiteouts were consumed by applyLayer (they remove); recover them by scanning headers
    let off = 0; const b = tar; const str = (o, l) => { let e = o; while (e < o + l && b[e] !== 0) e++; return dec.decode(b.subarray(o, e)); };
    let longName = null;
    while (off + 512 <= b.length) { if (b[off] === 0) { off += 512; continue; } const size = parseInt(str(off + 124, 12).trim(), 8) || 0; const type = String.fromCharCode(b[off + 156] || 48); let name = str(off, 100); const data = off + 512; off = data + ((size + 511) & ~511); if (type === "L") { longName = str(data, size); continue; } if (longName) { name = longName; longName = null; } name = name.replace(/^\.?\/+/, "").replace(/\/+$/, ""); const i = name.lastIndexOf("/"); const base = name.slice(i + 1); if (base.startsWith(".wh.") && base !== ".wh..wh..opq") set.add((i >= 0 ? name.slice(0, i + 1) : "") + base.slice(4)); }
  }

  // ---- the persistent store ------------------------------------------------------------------------
  // OPFS directory "nanobox-persist" (files: packages/<key>.tar, packages/<key>.json, journal/<name>.tar);
  // Cache API "nanobox-persist" as the fallback (keys /nanobox-persist/<path>). Same-origin, shared by all pages.
  async function openStore(opts) {
    opts = opts || {};
    if (!opts.noOpfs && global.navigator && navigator.storage && navigator.storage.getDirectory) {
      try {
        const rootDir = await navigator.storage.getDirectory();
        const dir = await rootDir.getDirectoryHandle("nanobox-persist", { create: true });
        const sub = async (name, create) => { try { return await dir.getDirectoryHandle(name, { create }); } catch { return null; } };
        const store = {
          kind: "opfs",
          async list(prefix) { const d = await sub(prefix, true); const out = []; if (!d) return out; for await (const [name, h] of d.entries()) if (h.kind === "file") out.push(prefix + "/" + name); return out.sort(); },
          async read(path) { const [p, name] = path.split("/"); const d = await sub(p, false); if (!d) return null; try { const fh = await d.getFileHandle(name); return new Uint8Array(await (await fh.getFile()).arrayBuffer()); } catch { return null; } },
          async write(path, bytes) { const [p, name] = path.split("/"); const d = await sub(p, true); const fh = await d.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close(); },
          async remove(path) { const [p, name] = path.split("/"); const d = await sub(p, false); if (d) try { await d.removeEntry(name); } catch {} },
          async wipe() { for (const p of ["packages", "journal"]) { try { await dir.removeEntry(p, { recursive: true }); } catch {} } },
          async usage() { try { const e = await navigator.storage.estimate(); return { usage: e.usage, quota: e.quota }; } catch { return null; } },
        };
        await store.list("packages"); // probe
        return store;
      } catch (e) { /* fall through */ }
    }
    if (typeof caches === "undefined") throw new Error("no persistent storage available (OPFS and Cache API both unavailable)");
    const cache = await caches.open("nanobox-persist");
    const base = (global.location && global.location.origin && /^https?:/.test(global.location.origin)) ? global.location.origin : "http://localhost/";
    const keyUrl = (path) => new URL("/nanobox-persist/" + path.split("/").map(encodeURIComponent).join("/"), base).href;
    return {
      kind: "cache",
      async list(prefix) { const ks = await cache.keys(); const pre = keyUrl(prefix) + "/"; return ks.map((r) => r.url).filter((u) => u.startsWith(pre)).map((u) => prefix + "/" + decodeURIComponent(u.slice(pre.length))).sort(); },
      async read(path) { const r = await cache.match(keyUrl(path)); return r ? new Uint8Array(await r.arrayBuffer()) : null; },
      async write(path, bytes) { await cache.put(keyUrl(path), new Response(bytes.slice(0))); },
      async remove(path) { await cache.delete(keyUrl(path)); },
      async wipe() { for (const r of await cache.keys()) await cache.delete(r); },
      async usage() { try { const e = await navigator.storage.estimate(); return { usage: e.usage, quota: e.quota }; } catch { return null; } },
    };
  }

  global.NanoboxInstaller = { install, applyPackage, command, packagesFor, CATALOG, CLIS, KEYV, PERSIST_ROOTS, tar: { pack: tarPack, entriesOf }, journal: { entries: journalEntries, compact: journalCompact }, store: { open: openStore } };

  // ---- as the sandbox's persist worker -----------------------------------------------------------
  if (typeof importScripts === "function" && typeof self !== "undefined" && self.constructor && self.constructor.name === "DedicatedWorkerGlobalScope" && !global.NanoboxFs) {
    importScripts(new URL("/wasifs.js", location.href).href, new URL("/oci.js", location.href).href);
    const T0 = performance.now();
    const post = (m, tr) => self.postMessage(m, tr || []);
    const progress = (p) => post(Object.assign({ type: "progress", t: Math.round(performance.now() - T0) }, p));
    let store = null, journalQueue = [], journalTimer = null, journalSeq = 0, journalBytes = 0, journalWrites = 0;
    async function flushJournal() {
      journalTimer = null;
      if (!journalQueue.length || !store) return;
      const tars = journalQueue; journalQueue = [];
      const merged = tars.length === 1 ? tars[0] : journalCompact(tars);
      const name = "journal/" + String(Date.now()).padStart(14, "0") + "-" + (journalSeq++).toString(36) + "-" + Math.random().toString(36).slice(2, 6) + ".tar";
      try { await store.write(name, merged); journalBytes += merged.byteLength; journalWrites++; progress({ stage: "journal", name, bytes: merged.byteLength, records: tars.length }); }
      catch (e) { progress({ stage: "journal-error", message: String(e && e.message || e) }); }
    }
    async function open(d) {
      const clis = d.clis || [], opts = d.opts || {};
      store = await openStore({ noOpfs: !!opts.noOpfs });
      if (opts.reset) { await store.wipe(); progress({ stage: "reset" }); }
      progress({ stage: "store", kind: store.kind });
      // journals from the VM worker (guest writes) -> batched into journal/*.tar
      if (d.vmPort) d.vmPort.onmessage = (e) => { const x = e.data || {}; if (x.type === "journal" && x.tar) { journalQueue.push(new Uint8Array(x.tar)); if (!journalTimer) journalTimer = setTimeout(flushJournal, 1500); } else if (x.type === "flush") flushJournal(); };
      // what is stored
      const stored = new Set(await store.list("packages"));
      const have = async (key) => (opts.noCache ? null : stored.has("packages/" + key + ".tar") ? await store.read("packages/" + key + ".tar") : null);
      const keep = async (key, pkg) => { if (opts.noCache) return; try { await store.write("packages/" + key + ".tar", pkg.tar); await store.write("packages/" + key + ".json", enc.encode(JSON.stringify(pkg.meta))); } catch (e) { progress({ stage: "store-error", key, message: String(e && e.message || e) }); } };
      const { packages, stats } = await install(clis, Object.assign({}, opts, { have, keep, onProgress: progress }));
      // journals (guest writes of earlier sessions), oldest first; compact when many
      const jnames = await store.list("journal");
      const journals = []; for (const n of jnames) { const t = await store.read(n); if (t) journals.push(t); }
      const jbytes = journals.reduce((s, t) => s + t.byteLength, 0);
      const out = packages.map((p) => ({ cli: p.cli, key: p.key, name: p.name, version: p.version, meta: p.meta, files: p.files, unpackedBytes: p.unpackedBytes, download: p.download, tar: p.tar }));
      if (d.runtimePort) {   // the runtime worker (claude on the browser V8) gets copies of claude's packages + the journals
        const mine = out.filter((p) => p.cli === "claude").map((p) => Object.assign({}, p, { tar: p.tar.slice() }));
        const js = journals.map((t) => t.slice());
        d.runtimePort.postMessage({ type: "persist", packages: mine, journals: js }, mine.map((p) => p.tar.buffer).concat(js.map((t) => t.buffer)));
      }
      if (d.vmPort) d.vmPort.postMessage({ type: "persist", packages: out, journals }, out.map((p) => p.tar.buffer).concat(journals.map((t) => t.buffer)));
      const usage = await store.usage();
      post({ type: "ready", ms: Math.round(performance.now() - T0), store: store.kind, usage, stats, packages: packages.map((p) => ({ cli: p.cli, key: p.key, name: p.name, version: p.version, files: p.files, unpackedBytes: p.unpackedBytes, tarBytes: p.tar.byteLength, download: p.download })), journals: { count: journals.length, bytes: jbytes }, resources: performance.getEntriesByType ? performance.getEntriesByType("resource").map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })) : [] });
      if (jnames.length > 6) { // compact in the background: one merged file replaces the many
        try { const merged = journalCompact(journals); await store.write("journal/" + String(Date.now()).padStart(14, "0") + "-compact.tar", merged); for (const n of jnames) await store.remove(n); progress({ stage: "compacted", from: jnames.length, bytes: merged.byteLength }); } catch (e) { progress({ stage: "compact-error", message: String(e && e.message || e) }); }
      }
    }
    self.onmessage = (m) => {
      const d = m.data; if (!d) return;
      if (d.type === "open") open(d).catch((e) => post({ type: "error", message: String(e && e.stack || e) }));
      else if (d.type === "flush") flushJournal();
      else if (d.type === "stats") post({ type: "stats", journalBytes, journalWrites, queued: journalQueue.length });
    };
  }
})(typeof self !== "undefined" ? self : globalThis);
