// nanobox — the ServiceWorker that gives Claude Code's NATIVE build a module resolver.
//
// Since 2.1.288 the vendor's Bun standalone carries a code-split ES-module graph whose specifiers are
// the literal paths Bun would have read out of its own embedded filesystem — `import{F}from
// "/$bunfs/root/chunk-vs3dgs32.js"`, and 472 `import.meta.require("/$bunfs/root/…")` on top. A Worker
// has no import map, so those cannot resolve; and publishing each chunk as a blob: URL instead cannot
// work either, because a blob URL exists only after its content does and the graph HAS CYCLES once
// the import.meta.require edges are counted (3 SCCs of 54, 4 and 3 modules), so there is no order in
// which every module's dependencies are published before it. See web/native/src/bun-link.js.
//
// This serves /$bunfs/* from the origin instead. The specifiers stay literal, every module keeps ONE
// stable URL, and the cycles are resolved by the browser's own module loader, exactly as Bun's is.
// The bytes come from the runtime worker (web/native/src/worker.js), which holds the extracted tree
// and rewrites each module on the way out; this file only moves them.
//
//   page   -> sw:     {type:"bunfs-port", port}        (a MessagePort to the runtime worker)
//   sw     -> page:   {type:"bunfs-port-request"}      (the SW was restarted and lost the port)
//   sw     -> worker: {type:"bunfs-read", id, path}
//   worker -> sw:     {type:"bunfs-read", id, body} | {type:"bunfs-read", id, error}
//
// Scope is "/" — it has to be, "/$bunfs/" is at the root — so EVERY request on this origin reaches
// the fetch handler. Anything that is not a /$bunfs/ path is left alone (no respondWith at all), so
// the other sandbox pages behave exactly as if this worker were not installed.
const PREFIX = "/$bunfs/";
const pending = new Map();                 // request id -> resolve
let port = null;
let nextId = 1;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "bunfs-port") return;
  port = data.port || event.ports[0];
  port.onmessage = (message) => {
    const reply = message.data || {};
    const resolve = pending.get(reply.id);
    if (!resolve) return;
    pending.delete(reply.id);
    resolve(reply);
  };
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(PREFIX)) return;
  event.respondWith(serve(decodeURIComponent(url.pathname)));
});

async function serve(path) {
  if (!port) await requestPort();
  if (!port) return new Response(`// nanobox: no runtime worker is serving ${path}\n`, { status: 503, headers: { "Content-Type": "text/javascript" } });
  const id = nextId++;
  const reply = await new Promise((resolve) => { pending.set(id, resolve); port.postMessage({ type: "bunfs-read", id, path }); });
  if (reply.error) return new Response(`// nanobox: ${path}: ${reply.error}\n`, { status: 404, headers: { "Content-Type": "text/javascript" } });
  // every module the CLI imports is JavaScript; an embedded asset is read through the fs shim, not
  // fetched, so one content type covers the whole prefix
  return new Response(reply.body, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } });
}

// A ServiceWorker is killed when it goes idle and comes back without the port. Ask whoever is still
// around for a new one rather than failing the import that woke us up.
async function requestPort() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  if (!clients.length) return;
  for (const client of clients) client.postMessage({ type: "bunfs-port-request" });
  await new Promise((resolve) => { const started = Date.now(); const tick = () => (port || Date.now() - started > 2000 ? resolve() : setTimeout(tick, 10)); tick(); });
}
