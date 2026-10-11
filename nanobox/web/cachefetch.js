// Browser-side cache for the big downloads (engine .wasm.gzip, OCI layers, JIT bundles) so a page
// reload does not re-download ~170 MB. Cache API (CacheStorage), same origin, quota-based (much
// larger than the HTTP cache's per-entry limit).
//   NanoboxCache.fetchValidated(url) -> ArrayBuffer
//       stores the response under its URL; on later loads a HEAD request compares the server's
//       ETag with the cached one (serve.mjs: size-mtime) — same tag: serve from cache (no body
//       transfer), different/absent: refetch and replace. A rebuilt engine or a re-recorded bundle
//       is picked up automatically; a server without ETag disables the cache for that URL.
//   NanoboxCache.getBytes(key) / putBytes(key, bytes)
//       content-addressed entries (OCI layers by digest: never validated, immutable).
// Everything degrades to a plain fetch when caches are unavailable (http origin, private mode).
(function (global) {
  const NAME = "nanobox-v1";
  const open = () => (typeof caches !== "undefined" ? caches.open(NAME).catch(() => null) : Promise.resolve(null));
  const stats = { hits: 0, misses: 0, bytesFromCache: 0, bytesFetched: 0 };
  async function fetchValidated(url, opts) {
    const cache = await open();
    if (cache) {
      try {
        const have = await cache.match(url);
        if (have) {
          const head = await fetch(url, { method: "HEAD", credentials: "same-origin" }).catch(() => null);
          const tag = head && head.ok ? head.headers.get("etag") : null;
          if (tag && tag === have.headers.get("etag")) {
            const buf = await have.arrayBuffer();
            stats.hits++; stats.bytesFromCache += buf.byteLength;
            if (opts && opts.onHit) opts.onHit(buf.byteLength);
            return buf;
          }
          await cache.delete(url).catch(() => {});
        }
      } catch (e) { /* fall through to a plain fetch */ }
    }
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("fetch " + url + ": " + r.status);
    const buf = await r.arrayBuffer();
    stats.misses++; stats.bytesFetched += buf.byteLength;
    if (cache && r.headers.get("etag")) {
      const h = new Headers(); h.set("etag", r.headers.get("etag")); h.set("content-type", r.headers.get("content-type") || "application/octet-stream");
      cache.put(url, new Response(buf.slice(0), { headers: h })).catch(() => {});
    }
    return buf;
  }
  const keyUrl = (key) => new URL("/nanobox-cache/" + encodeURIComponent(key), (global.location && global.location.href) || "http://localhost/").href;
  async function getBytes(key) {
    const cache = await open(); if (!cache) return null;
    try { const r = await cache.match(keyUrl(key)); if (!r) return null; const b = new Uint8Array(await r.arrayBuffer()); stats.hits++; stats.bytesFromCache += b.length; return b; } catch (e) { return null; }
  }
  async function putBytes(key, bytes) {
    const cache = await open(); if (!cache) return;
    try { await cache.put(keyUrl(key), new Response(bytes.slice(0))); } catch (e) { /* quota etc. */ }
  }
  async function clear() { if (typeof caches !== "undefined") await caches.delete(NAME); }
  global.NanoboxCache = { fetchValidated, getBytes, putBytes, clear, stats };
})(typeof self !== "undefined" ? self : globalThis);
