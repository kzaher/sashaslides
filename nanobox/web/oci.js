// nanobox — build an in-memory rootfs (a NanoboxFs tree) from an OCI image layout served
// over HTTP (index.json + blobs/sha256/*), the same layout nanobox's imagemounter consumes.
//
//   const img = await NanoboxOci.load("http://host/c2w/images/codex/", { onProgress });
//   img.rootfs (NanoboxFs dir), img.configBytes (the image config blob), img.config (parsed)
//
// Layers are fetched, gunzipped with DecompressionStream and untarred; whiteouts are applied in
// order. File contents are views into the decompressed layer buffers (no copies). Works in a
// classic worker and in node (>= 18: fetch + DecompressionStream are globals).
//
// Optional layer cache (the node harness uses it, the browser does not): `opts.cache` is
// { get(key) -> Uint8Array | null (or a promise of one), put(key, bytes) } keyed by the layer's
// digest ("sha256:…") and holding the *decompressed* tar. A hit skips fetch + gunzip (the two
// costs; untarring is header parsing only, contents stay views into the tar). Misses are stored
// after gunzipping. Neither is awaited on failure: a broken cache degrades to the fetch path.
(function (global) {
  const F = global.NanoboxFs;
  const dec = new TextDecoder();

  async function fetchBytes(url, onProgress) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function fetchJson(url) { const b = await fetchBytes(url); return JSON.parse(dec.decode(b)); }
  async function gunzip(bytes) {
    const ds = new DecompressionStream("gzip");
    const resp = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await resp.arrayBuffer());
  }

  // --- tar -----------------------------------------------------------------------------------------
  function str(b, off, len) { let e = off; const end = off + len; while (e < end && b[e] !== 0) e++; return dec.decode(b.subarray(off, e)); }
  function oct(b, off, len) { const s = str(b, off, len).trim(); if (!s) return 0; if (b[off] & 0x80) { let v = 0; for (let i = 1; i < len; i++) v = v * 256 + b[off + i]; return v; } return parseInt(s, 8) || 0; }
  function parsePax(b, off, size) {
    const out = {}; const s = dec.decode(b.subarray(off, off + size));
    let p = 0;
    while (p < s.length) { const sp = s.indexOf(" ", p); if (sp < 0) break; const len = parseInt(s.slice(p, sp), 10); const rec = s.slice(sp + 1, p + len - 1); const eq = rec.indexOf("="); if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1); p += len; }
    return out;
  }
  // apply one (uncompressed) tar layer to the tree
  function applyLayer(root, tar) {
    let off = 0, longName = null, longLink = null, pax = null;
    let n = 0;
    while (off + 512 <= tar.length) {
      const b = tar;
      if (b[off] === 0) { off += 512; continue; } // end blocks
      const size = oct(b, off + 124, 12);
      const mode = oct(b, off + 100, 8) & 0o7777;
      const type = String.fromCharCode(b[off + 156] || 48);
      let name = str(b, off, 100), link = str(b, off + 157, 100);
      const prefix = str(b, off + 345, 155);
      if (prefix && str(b, off + 257, 6).startsWith("ustar")) name = prefix + "/" + name;
      const dataOff = off + 512, dataEnd = dataOff + size;
      const next = dataOff + ((size + 511) & ~511);
      if (type === "L") { longName = str(b, dataOff, size); off = next; continue; }
      if (type === "K") { longLink = str(b, dataOff, size); off = next; continue; }
      if (type === "x") { pax = parsePax(b, dataOff, size); off = next; continue; }
      if (type === "g") { off = next; continue; }
      if (longName != null) { name = longName; longName = null; }
      if (longLink != null) { link = longLink; longLink = null; }
      if (pax) { if (pax.path) name = pax.path; if (pax.linkpath) link = pax.linkpath; pax = null; }
      name = name.replace(/^\.?\/+/, "").replace(/\/+$/, "");
      off = next;
      if (!name) continue;
      const slash = name.lastIndexOf("/");
      const dirName = slash >= 0 ? name.slice(0, slash) : "", base = slash >= 0 ? name.slice(slash + 1) : name;
      // OCI whiteouts
      if (base === ".wh..wh..opq") { const d = F.lookup(root, dirName); if (d && d.t === "d") d.e.clear(); continue; }
      if (base.startsWith(".wh.")) { F.remove(root, (dirName ? dirName + "/" : "") + base.slice(4)); continue; }
      n++;
      switch (type) {
        case "0": case "\0": case "7": F.add(root, name, { data: b.subarray(dataOff, dataEnd), mode }); break;
        case "1": { const t = F.lookup(root, link.replace(/^\.?\/+/, "")); if (t && t.t === "f") F.add(root, name, { data: t.data, ino: t.ino, mode: t.mode }); break; }
        case "2": F.add(root, name, { symlink: link }); break;
        case "5": { const d = F.add(root, name, { dir: true }); d.mode = mode; break; }
        default: break; // devices, fifos: the runtime provides /dev
      }
    }
    return n;
  }

  async function load(baseUrl, opts) {
    opts = opts || {};
    const log = opts.onProgress || (() => {});
    const t0 = performance.now();
    const index = await fetchJson(baseUrl + "index.json");
    const mdesc = index.manifests.find((m) => !m.platform || (m.platform.architecture === "amd64")) || index.manifests[0];
    const manifest = await fetchJson(baseUrl + "blobs/" + mdesc.digest.replace(":", "/"));
    const configBytes = await fetchBytes(baseUrl + "blobs/" + manifest.config.digest.replace(":", "/"));
    const config = JSON.parse(dec.decode(configBytes));
    const rootfs = F.dir();
    const cache = opts.cache || null;
    let files = 0, bytes = 0, cacheHits = 0, cacheMisses = 0, cacheBytes = 0, fetchMs = 0, unpackMs = 0, applyMs = 0;
    // cache lookups first (all in parallel), then fetch only the missing layers concurrently; apply in order
    const cached = await Promise.all(manifest.layers.map(async (l) => {
      if (!cache) return null;
      try { return (await cache.get(l.digest)) || null; } catch (e) { return null; }
    }));
    const fetched = manifest.layers.map((l, i) => (cached[i] ? null : fetchBytes(baseUrl + "blobs/" + l.digest.replace(":", "/"))));
    for (let i = 0; i < manifest.layers.length; i++) {
      const l = manifest.layers[i];
      let data;
      if (cached[i]) {
        data = cached[i]; cacheHits++; cacheBytes += data.length;
        log({ stage: "cached", layer: i, size: data.length, t: performance.now() - t0 });
      } else {
        const tf = performance.now();
        data = await fetched[i];
        bytes += data.length; fetchMs += performance.now() - tf;
        log({ stage: "fetched", layer: i, size: data.length, t: performance.now() - t0 });
        const tu = performance.now();
        if (/gzip/.test(l.mediaType)) data = await gunzip(data);
        unpackMs += performance.now() - tu;
        log({ stage: "unpacked", layer: i, size: data.length, t: performance.now() - t0 });
        if (cache) { cacheMisses++; try { await cache.put(l.digest, data); } catch (e) { log({ stage: "cache-put-failed", layer: i, error: String(e) }); } }
      }
      const ta = performance.now();
      files += applyLayer(rootfs, data);
      applyMs += performance.now() - ta;
      log({ stage: "applied", layer: i, files, t: performance.now() - t0 });
    }
    return { rootfs, config, configBytes, manifest, files, compressedBytes: bytes, ms: performance.now() - t0,
      cache: cache ? { hits: cacheHits, misses: cacheMisses, bytes: cacheBytes } : null, fetchMs, unpackMs, applyMs };
  }

  global.NanoboxOci = { load, applyLayer, gunzip };
})(typeof self !== "undefined" ? self : globalThis);
