// Page-side half of the nanobox proxy extension (extension/README.md) + the egress routing policy
// shared by the VM pages and the runtime worker. Load /netpolicy.js first. Works in a window (talks
// to the extension's content script over window.postMessage) and in a dedicated worker (talks to
// its owning page, which must call NanoboxProxy.bridgeWorker(worker); the page tells the worker
// whether the extension is present through cfg — a worker cannot detect it by itself).
//
//   NanoboxProxy.detect(timeoutMs) -> Promise<bool>       hello/ping handshake (window only)
//   NanoboxProxy.detected                                 last detect() result (null before)
//   NanoboxProxy.route(url, {extension}) -> "direct" | "extension" | "relay" | "blocked"
//   NanoboxProxy.fetch(spec) -> Promise<{status, statusText, headers:Headers, ok, url, arrayBuffer(), text(), json()}>
//   NanoboxProxy.workerFetch(origFetch, input, init, cfg) -> Promise<Response>   the full override body
//   NanoboxProxy.bridgeWorker(worker)                     page side of a worker's extension route
(function (global) {
  const PROTOCOL_VERSION = 1;
  const isWindow = typeof window !== "undefined" && typeof document !== "undefined";
  const policy = global.NanoboxNetPolicy;
  if (!policy) throw new Error("proxyext.js: load /netpolicy.js first");
  // cloud metadata endpoints — reachable from the browser's network, never from a web page; the
  // extension refuses them too (extension/background.js BLOCKED_TARGET_HOSTS)
  const BLOCKED_TARGET_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "[fd00:ec2::254]", "100.100.100.200"]);
  const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

  const NanoboxProxy = {
    VERSION: PROTOCOL_VERSION,
    detected: null,
    detect,
    route,
    fetch: proxyFetch,
    workerFetch,
    bridgeWorker,
  };

  // Resolves true when the extension's content script answers a ping within timeoutMs. Workers
  // resolve false: they receive the answer through cfg.extension from the page instead.
  function detect(timeoutMs = 300) {
    if (!isWindow) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value) => { clearTimeout(timer); window.removeEventListener("message", onHello); NanoboxProxy.detected = value; resolve(value); };
      const onHello = (event) => { if (event.source === window && event.data && event.data.type === "nanobox-proxy-hello" && Number(event.data.version) >= PROTOCOL_VERSION) done(true); };
      const timer = setTimeout(() => done(false), timeoutMs);
      window.addEventListener("message", onHello);
      window.postMessage({ type: "nanobox-proxy-ping" }, location.origin);
    });
  }

  // The policy: same-origin and non-http(s) URLs are the browser's business; with the extension
  // every cross-origin request goes through it; without it only the vendors that do not answer
  // CORS go through our server's relay (netpolicy.js), everything else is a direct browser fetch.
  function route(url, options) {
    let target;
    try { target = new URL(url, global.location.href); } catch { return "direct"; }
    if (target.origin === global.location.origin || !/^https?:$/.test(target.protocol)) return "direct";
    if (BLOCKED_TARGET_HOSTS.has(target.hostname)) return "blocked";
    const extension = options && "extension" in options ? Boolean(options.extension) : Boolean(NanoboxProxy.detected);
    if (extension) return "extension";
    if (policy.isProxied(target.hostname)) return "relay";
    return "direct";
  }

  // --- extension transport: window -> content script, or worker -> owning page (bridgeWorker)
  const pendingResults = new Map();   // id -> {resolve, reject}
  let nextId = 0;
  const idPrefix = (isWindow ? "w" : "k") + Math.random().toString(36).slice(2, 8) + "-";
  const post = isWindow ? (message, transfer) => window.postMessage(message, location.origin, transfer) : (message, transfer) => global.postMessage(message, transfer);
  global.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "nanobox-proxy-result" || (isWindow && event.source !== window)) return;
    const waiter = pendingResults.get(data.id);
    if (!waiter) return;
    pendingResults.delete(data.id);
    if (data.error) { waiter.reject(new TypeError("nanobox proxy: " + data.error)); return; }
    waiter.resolve(data);
  });

  // spec: {url, method, headers: Headers|[[k,v]]|{k:v}, body?: ArrayBuffer|ArrayBufferView, signal?: AbortSignal}
  function proxyFetch(spec) {
    const id = idPrefix + (++nextId);
    const headers = [];
    new Headers(spec.headers || {}).forEach((value, name) => headers.push([name, value]));
    const body = spec.body instanceof ArrayBuffer ? spec.body : ArrayBuffer.isView(spec.body) ? spec.body.buffer.slice(spec.body.byteOffset, spec.body.byteOffset + spec.body.byteLength) : undefined;
    return new Promise((resolve, reject) => {
      if (spec.signal && spec.signal.aborted) { reject(spec.signal.reason || new DOMException("aborted", "AbortError")); return; }
      pendingResults.set(id, { resolve, reject });
      if (spec.signal) spec.signal.addEventListener("abort", () => { if (pendingResults.delete(id)) { post({ type: "nanobox-proxy-abort", id }); reject(spec.signal.reason || new DOMException("aborted", "AbortError")); } }, { once: true });
      post({ type: "nanobox-proxy-fetch", id, spec: { url: spec.url, method: spec.method || "GET", headers, body } }, body ? [body] : []);
    }).then((result) => {
      const responseHeaders = new Headers(result.headers);
      const buffer = result.body || new ArrayBuffer(0);
      return {
        status: result.status, statusText: result.statusText, headers: responseHeaders, ok: result.status >= 200 && result.status < 300, url: spec.url,
        arrayBuffer: () => Promise.resolve(buffer),
        text: () => Promise.resolve(new TextDecoder().decode(buffer)),
        json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(buffer))),
        toResponse: () => new Response(NULL_BODY_STATUS.has(result.status) ? null : buffer, { status: result.status, statusText: result.statusText, headers: responseHeaders }),
      };
    });
  }

  // Drop-in body for a `fetch` override (page or worker). cfg: { extension: bool (from detect() /
  // the page), onRoute?: ({route, method, url}) => void }. Returns a real Response on every route.
  async function workerFetch(origFetch, input, init, cfg) {
    const options = init || {};
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    const method = (options.method || (typeof input === "object" && !(input instanceof URL) && input.method) || "GET").toUpperCase();
    const chosen = route(url, { extension: cfg && cfg.extension });
    if (cfg && typeof cfg.onRoute === "function") cfg.onRoute({ route: chosen, method, url: String(url) });
    switch (chosen) {
      case "direct": return origFetch(input, options);
      case "blocked": return new Response("target blocked by the nanobox egress policy (web/proxyext.js)", { status: 403, statusText: "Forbidden" });
      case "extension": { const spec = await requestSpec(input, options, method); return (await proxyFetch(spec)).toResponse(); }
      case "relay": { const spec = await requestSpec(input, options, method); return relayFetch(origFetch, spec); }
      default: throw new Error("unreachable route " + chosen);
    }
  }

  // Let the platform normalise every body/header shape (string, FormData, stream, Request, ...)
  async function requestSpec(input, options, method) {
    const request = new Request(input, Object.assign({}, options, options.body && typeof options.body.getReader === "function" ? { duplex: "half" } : {}));
    const body = ["GET", "HEAD"].includes(method) ? undefined : await request.arrayBuffer();
    return { url: request.url, method, headers: request.headers, body, signal: options.signal };
  }

  // Our server's POST /net/fetch gateway (serve.mjs netFetch): the target travels base64url-encoded
  // in x-nanobox-target, the body verbatim; the server enforces the same allow-list (netpolicy.js).
  function relayFetch(origFetch, spec) {
    const headers = {};
    spec.headers.forEach((value, name) => (headers[name] = value));
    const target = JSON.stringify({ url: spec.url, method: spec.method, headers });
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(target))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return origFetch(new URL("/net/fetch", global.location.origin), { method: "POST", headers: { "x-nanobox-target": encoded }, body: spec.body, signal: spec.signal });
  }

  // Page side of a worker's extension route: the worker posts nanobox-proxy-fetch messages to its
  // owner, this forwards them to the extension and posts nanobox-proxy-result back. Coexists with
  // worker.onmessage (addEventListener); messages of other types are left alone.
  function bridgeWorker(worker) {
    if (!isWindow) throw new Error("bridgeWorker runs in the page that owns the worker");
    const controllers = new Map();   // worker request id -> AbortController
    worker.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "nanobox-proxy-abort") { const controller = controllers.get(data.id); if (controller) controller.abort(); return; }
      if (data.type !== "nanobox-proxy-fetch") return;
      const controller = new AbortController();
      controllers.set(data.id, controller);
      proxyFetch(Object.assign({}, data.spec, { signal: controller.signal })).then(
        async (result) => { const body = await result.arrayBuffer(); const headers = []; result.headers.forEach((value, name) => headers.push([name, value])); worker.postMessage({ type: "nanobox-proxy-result", id: data.id, status: result.status, statusText: result.statusText, headers, body }, [body]); },
        (error) => worker.postMessage({ type: "nanobox-proxy-result", id: data.id, error: String(error && error.message || error) }))
        .finally(() => controllers.delete(data.id));
    });
    return worker;
  }

  global.NanoboxProxy = NanoboxProxy;
})(typeof self !== "undefined" ? self : globalThis);
