// Page-side half of the nanobox proxy extension (extension/README.md) + the egress routing policy
// shared by the VM pages and the runtime worker. Load /netpolicy.js first. Works in a window (talks
// to the extension's content script over window.postMessage) and in a dedicated worker (talks to
// its owning page, which must call NanoboxProxy.bridgeWorker(worker); the page tells the worker
// whether the extension is present through cfg — a worker cannot detect it by itself).
//
// The published surface is NanoboxProxyApi in src/page-globals.d.ts; the message types of the leg
// it speaks are in ../extension/src/protocol.d.ts, shared with the extension itself so the two
// halves cannot drift apart.
//
//   NanoboxProxy.detect(timeoutMs) -> Promise<bool>       hello/ping handshake (window only)
//   NanoboxProxy.detected                                 last detect() result (null before)
//   NanoboxProxy.features                                 what the installed extension advertises
//   NanoboxProxy.POLICY                                   the routing decision, in prose
//   NanoboxProxy.route(url, {extension}) -> "direct" | "extension" | "relay" | "blocked"
//   NanoboxProxy.fetch(spec) -> Promise<ProxyResponse>    resolves at the HEAD; body is a stream
//   NanoboxProxy.WebSocket                                a WebSocket tunnelled through the extension
//   NanoboxProxy.workerFetch(origFetch, input, init, cfg) -> Promise<Response>   the full override body
//   NanoboxProxy.bridgeWorker(worker)                     page side of a worker's extension route
(function (global: typeof globalThis) {
  // The replies AS THIS FILE HOLDS THEM: PageLegReply is the sender's contract, this is what is
  // left after parsing an untrusted window message, with the optional payloads turned into typed
  // absence (`null`) so no branch below has to re-ask whether a field is there.
  type ProxyReply =
    | Readonly<{ type: "nanobox-proxy-head"; id: string; status: number; statusText: string; headers: readonly HeaderPair[]; dropped: readonly string[] }>
    | Readonly<{ type: "nanobox-proxy-chunk"; id: string; body: ArrayBuffer }>
    | Readonly<{ type: "nanobox-proxy-done"; id: string }>
    | Readonly<{ type: "nanobox-proxy-result"; id: string; error: string }>
    | Readonly<{ type: "nanobox-proxy-ws-opened"; id: string; protocol: string; extensions: string }>
    | Readonly<{ type: "nanobox-proxy-ws-message"; id: string; text: string | null; body: ArrayBuffer | null }>
    | Readonly<{ type: "nanobox-proxy-ws-closed"; id: string; code: number; reason: string; wasClean: boolean }>;

  // What a bridged worker asks its owning page to perform, after parsing.
  type WorkerRequest =
    | Readonly<{ type: "nanobox-proxy-fetch"; id: string; spec: NanoboxFetchSpec }>
    | Readonly<{ type: "nanobox-proxy-abort"; id: string }>
    | Readonly<{ type: "nanobox-proxy-ws-open"; id: string; url: string; protocols: readonly string[] }>
    | Readonly<{ type: "nanobox-proxy-ws-send"; id: string; text: string | null; body: ArrayBuffer | null }>
    | Readonly<{ type: "nanobox-proxy-ws-close"; id: string; code: number | undefined; reason: string | undefined }>;

  // What requestSpec() hands on: every field settled, so proxyFetch and relayFetch can both take it.
  type SettledSpec = Readonly<{ url: string; method: string; headers: Headers; body: ArrayBuffer | undefined; signal: AbortSignal | undefined }>;

  // lib.dom.d.ts (TypeScript 6.0.3) has no `duplex` on RequestInit, although the Fetch standard
  // requires `duplex: "half"` for a streaming request body and Chrome rejects one without it.
  type DuplexRequestInit = RequestInit & { duplex?: "half" | undefined };

  // A dedicated worker's postMessage takes a transfer list where a Window's takes a target origin.
  // `global` is typed as a Window because lib.dom is the only lib @types/chrome compiles against
  // (see ../../tsconfig.json), so the worker shape is stated here and used only on that branch.
  interface WorkerScope { postMessage(message: unknown, transfer: readonly Transferable[]): void; }

  const PROTOCOL_VERSION = 2;
  const isWindow = typeof window !== "undefined" && typeof document !== "undefined";
  // Re-bound after the check on purpose: NanoboxNetPolicy is declared possibly-undefined, and
  // narrowing an outer `const` does NOT reach a hoisted function declaration (route() below), so
  // the proof has to be carried in a second binding that is already of the narrow type.
  const loadedPolicy = global.NanoboxNetPolicy;
  if (!loadedPolicy) throw new Error("proxyext.js: load /netpolicy.js first");
  const policy: NanoboxNetPolicyApi = loadedPolicy;
  // cloud metadata endpoints — reachable from the browser's network, never from a web page; the
  // extension refuses them too (extension/src/wire.ts BLOCKED_TARGET_HOSTS)
  const BLOCKED_TARGET_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "[fd00:ec2::254]", "100.100.100.200"]);
  const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

  const NanoboxProxy = {
    VERSION: PROTOCOL_VERSION,
    detected: null as boolean | null,
    features: [] as readonly string[],
    // Why "extension for EVERYTHING cross-origin" and not "extension only where CORS fails":
    //   * One code path is the one that gets exercised. A route that only carries the handful of
    //     vendor hosts in netpolicy.js is a route whose bugs show up in production, not in tests.
    //   * A direct cross-origin fetch hides response headers. CORS exposes only the safelisted ones
    //     plus whatever the vendor lists in Access-Control-Expose-Headers, so a host that "answers
    //     CORS" can still hide WWW-Authenticate / Retry-After / x-request-id from the guest. The
    //     extension hands back every header the browser saw.
    //   * No preflight. A direct PUT/DELETE or a custom auth header costs an OPTIONS round trip per
    //     origin; through the extension there is none.
    // The price, paid knowingly: one extra hop and base64 on the chrome.runtime leg (+33 % on that
    // leg only — the page leg transfers ArrayBuffers). Set {preferDirect:true} on route() to opt a
    // call out and take the browser's own fetch for a CORS-friendly host instead.
    POLICY: "extension (when installed) for every cross-origin http(s) request; otherwise the server relay for the netpolicy.js vendor hosts and a direct browser fetch for everything else",
    detect,
    route,
    fetch: proxyFetch,
    WebSocket: tunnelledWebSocketClass(),
    workerFetch,
    bridgeWorker,
  } satisfies NanoboxProxyApi;

  // Resolves true when the extension's content script answers a ping within timeoutMs. Workers
  // resolve false: they receive the answer through cfg.extension from the page instead.
  function detect(timeoutMs = 300): Promise<boolean> {
    if (!isWindow) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value: boolean, features: readonly string[]): void => { clearTimeout(timer); window.removeEventListener("message", onHello); NanoboxProxy.detected = value; NanoboxProxy.features = features; resolve(value); };
      const onHello = (event: MessageEvent<unknown>): void => {
        if (event.source !== window) return;
        const message = asRecord(event.data);
        if (message === null || message["type"] !== "nanobox-proxy-hello") return;
        if (Number(message["version"]) < PROTOCOL_VERSION) return;   // an older extension: ignore it rather than speak v1
        done(true, toStringArray(message["features"]));
      };
      const timer = setTimeout(() => done(false, []), timeoutMs);
      window.addEventListener("message", onHello);
      window.postMessage({ type: "nanobox-proxy-ping" } satisfies PageLegRequest, location.origin);
    });
  }

  // The policy in code; the prose is in NanoboxProxy.POLICY above. Same-origin and non-http(s) URLs
  // are the browser's business.
  function route(url: string | URL, options?: NanoboxRouteOptions): NanoboxRoute {
    let target: URL;
    try { target = new URL(url, global.location.href); } catch { return "direct"; }
    if (target.origin === global.location.origin || !/^https?:$/.test(target.protocol)) return "direct";
    if (BLOCKED_TARGET_HOSTS.has(target.hostname)) return "blocked";
    const extension = options !== undefined && "extension" in options ? Boolean(options.extension) : Boolean(NanoboxProxy.detected);
    const preferDirect = Boolean(options?.preferDirect) && !policy.isProxied(target.hostname);
    if (extension && !preferDirect) return "extension";
    if (policy.isProxied(target.hostname)) return "relay";
    return "direct";
  }

  // --- extension transport: window -> content script, or worker -> owning page (bridgeWorker)
  //
  // REQUESTS AND REPLIES MUST NOT SHARE A MESSAGE TYPE. window.postMessage delivers to every
  // listener on the window, the sender's own included, so both halves of the bridge see each other's
  // traffic: with one "nanobox-proxy-ws-open" for both directions the content script answered its
  // own reply as if it were a new request. Hence -ws-open/-ws-close upstream and -ws-opened/
  // -ws-closed/-ws-message downstream; anything a side does not recognise is dropped by its parser.
  const inflight = new Map<string, Readonly<{ onMessage: (reply: ProxyReply) => void }>>();
  let nextId = 0;
  const idPrefix = (isWindow ? "w" : "k") + Math.random().toString(36).slice(2, 8) + "-";
  const workerScope = global as unknown as WorkerScope;
  const post = isWindow
    ? (message: PageLegRequest, transfer?: readonly Transferable[]): void => window.postMessage(message, location.origin, transfer === undefined ? [] : [...transfer])
    : (message: PageLegRequest, transfer?: readonly Transferable[]): void => workerScope.postMessage(message, transfer === undefined ? [] : [...transfer]);
  global.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (isWindow && event.source !== window) return;
    const reply = parseReply(event.data);
    if (reply === null) return;
    const waiter = inflight.get(reply.id);
    if (waiter) waiter.onMessage(reply);
  });

  // Resolves as soon as status + headers arrive; `body` is a ReadableStream that keeps filling. That
  // is the whole point for an SSE response, which stays open for minutes after its head.
  function proxyFetch(spec: NanoboxFetchSpec): Promise<NanoboxProxyResponse> {
    const id = idPrefix + (++nextId);
    const headers: HeaderPair[] = [];
    new Headers(spec.headers ?? {}).forEach((value, name) => headers.push([name, value]));
    const body = toOwnBuffer(spec.body);
    const signal = spec.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortErrorFor(signal)); return; }
      // `sink` is the body stream's controller once the head arrived; `settled` says whether the
      // promise is already resolved, which decides where a later failure has to be reported.
      let sink: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | null = null;
      let settled = false;
      const fail = (reason: unknown): void => {
        inflight.delete(id);
        const error = reason instanceof Error ? reason : new TypeError("nanobox proxy: " + String(reason));
        if (!settled) { settled = true; reject(error); return; }
        if (!sink) return;
        try { sink.error(error); } catch { /* already closed */ }
        sink = null;
      };
      inflight.set(id, {
        onMessage: (reply) => {
          switch (reply.type) {
            case "nanobox-proxy-head": {
              if (settled) return;
              settled = true;
              const noBody = NULL_BODY_STATUS.has(reply.status);
              const stream = noBody ? null : new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (controller) => { sink = controller; } });
              resolve(proxyResponse({ url: spec.url, head: reply, stream }));
              return;
            }
            case "nanobox-proxy-chunk": if (sink) sink.enqueue(new Uint8Array(reply.body)); return;
            case "nanobox-proxy-done": {
              inflight.delete(id);
              if (!settled) { fail("protocol error: done without head"); return; }
              if (sink) { sink.close(); sink = null; }
              return;
            }
            case "nanobox-proxy-result": fail(reply.error || "failed"); return;
            // the socket vocabulary: a fetch id never carries one, so there is nothing to do
            case "nanobox-proxy-ws-opened": case "nanobox-proxy-ws-message": case "nanobox-proxy-ws-closed": return;
            default: assertNever(reply);
          }
        },
      });
      if (signal) signal.addEventListener("abort", () => { if (!inflight.has(id)) return; post({ type: "nanobox-proxy-abort", id }); fail(abortErrorFor(signal)); }, { once: true });
      post({ type: "nanobox-proxy-fetch", id, spec: { url: spec.url, method: spec.method ?? "GET", headers, ...(body === undefined ? {} : { body }) } }, body ? [body] : []);
    });
  }

  // A WebSocket to a cross-origin destination, opened by the extension's offscreen document and
  // piped over a chrome.runtime port. Install it (self.WebSocket = NanoboxProxy.WebSocket) only when
  // detect() returned true — it has no native fallback and it tunnels same-origin sockets too.
  // Honest limits: the handshake carries the EXTENSION's Origin (chrome-extension://<id>), never the
  // page's, and bufferedAmount is always 0 because the real socket is in another context.
  function ProxiedWebSocket(this: NanoboxWebSocket, url: string | URL, protocols?: string | readonly string[]): void {
    if (!new.target) throw new TypeError("NanoboxProxy.WebSocket is a constructor");
    const target = new EventTarget();
    const id = idPrefix + (++nextId);
    const state = { readyState: 0, protocol: "", extensions: "", binaryType: "arraybuffer" as BinaryType };
    const requested = protocols === undefined ? [] : Array.isArray(protocols) ? protocols.map(String) : [String(protocols)];

    inflight.set(id, {
      onMessage: (reply) => {
        switch (reply.type) {
          case "nanobox-proxy-ws-opened":
            state.readyState = 1; state.protocol = reply.protocol; state.extensions = reply.extensions;
            target.dispatchEvent(new Event("open"));
            return;
          case "nanobox-proxy-ws-message":
            target.dispatchEvent(messageEvent(reply.text !== null ? reply.text : state.binaryType === "blob" ? new Blob([reply.body ?? new ArrayBuffer(0)]) : reply.body));
            return;
          case "nanobox-proxy-ws-closed":
            inflight.delete(id); state.readyState = 3;
            target.dispatchEvent(closeEvent({ code: reply.code, reason: reply.reason, wasClean: reply.wasClean }));
            return;
          // the tunnel reports a failure as an error result; the spec says fire `error` then `close`
          case "nanobox-proxy-result":
            inflight.delete(id); state.readyState = 3;
            target.dispatchEvent(new Event("error"));
            target.dispatchEvent(closeEvent({ code: 1006, reason: reply.error, wasClean: false }));
            return;
          // the fetch vocabulary: a socket id never carries one
          case "nanobox-proxy-head": case "nanobox-proxy-chunk": case "nanobox-proxy-done": return;
          default: assertNever(reply);
        }
      },
    });
    post({ type: "nanobox-proxy-ws-open", id, url: String(url), protocols: requested });

    // Composition, not `extends EventTarget`: this has to be a HOISTED function declaration so that
    // the NanoboxProxy literal at the top of the file can name it (a `class` would be in its TDZ).
    // Consequence: `event.target` inside a listener is the internal EventTarget, not the socket.
    const instance = this;
    instance.addEventListener = target.addEventListener.bind(target);
    instance.removeEventListener = target.removeEventListener.bind(target);
    instance.dispatchEvent = target.dispatchEvent.bind(target);
    for (const name of ["open", "message", "close", "error"] as const) defineHandlerProperty({ owner: instance, target, name });
    Object.defineProperties(instance, {
      url: { value: String(url), enumerable: true },
      readyState: { get: () => state.readyState, enumerable: true },
      protocol: { get: () => state.protocol, enumerable: true },
      extensions: { get: () => state.extensions, enumerable: true },
      bufferedAmount: { get: () => 0, enumerable: true },
      binaryType: { get: () => state.binaryType, set: (value: unknown) => { state.binaryType = value === "blob" ? "blob" : "arraybuffer"; }, enumerable: true },
    });
    instance.send = (data) => {
      if (state.readyState === 0) throw new DOMException("still in CONNECTING state", "InvalidStateError");
      if (state.readyState !== 1) return;
      if (typeof data === "string") { post({ type: "nanobox-proxy-ws-send", id, text: data }); return; }
      const buffer = toOwnBuffer(data);
      post({ type: "nanobox-proxy-ws-send", id, ...(buffer === undefined ? {} : { body: buffer }) }, buffer ? [buffer] : []);
    };
    instance.close = (code, reason) => {
      if (state.readyState >= 2) return;
      state.readyState = 2;
      post({ type: "nanobox-proxy-ws-close", id, code: code === undefined ? 1000 : Number(code), reason: String(reason ?? "") });
    };
  }

  // The four readyState constants, on the constructor AND the prototype like the real WebSocket's.
  // Not part of NanoboxWebSocketConstructor: nothing in this codebase reads them, they exist so a
  // `self.WebSocket = NanoboxProxy.WebSocket` install does not break code that does.
  const READY_STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;
  Object.assign(ProxiedWebSocket, READY_STATES);
  Object.assign(ProxiedWebSocket.prototype, READY_STATES);

  // The one place ProxiedWebSocket is asserted to be a constructor. TypeScript types a `function`
  // with a `this` parameter by its CALL signature; the `new.target` check on the first line of its
  // body is what makes the construct signature true at runtime. A function, so the NanoboxProxy
  // literal above can call it before this line is reached.
  function tunnelledWebSocketClass(): NanoboxWebSocketConstructor {
    return ProxiedWebSocket as unknown as NanoboxWebSocketConstructor;
  }

  // Drop-in body for a `fetch` override (page or worker). cfg: { extension: bool (from detect() /
  // the page), onRoute?: ({route, method, url}) => void }. Returns a real Response on every route.
  async function workerFetch(origFetch: typeof fetch, input: RequestInfo | URL, init: RequestInit | undefined, cfg: NanoboxWorkerFetchConfig): Promise<Response> {
    const options: RequestInit = init ?? {};
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (options.method || (input instanceof Request ? input.method : "") || "GET").toUpperCase();
    const chosen = route(url, { extension: cfg.extension });
    if (cfg.onRoute) cfg.onRoute({ route: chosen, method, url });
    switch (chosen) {
      case "direct": return origFetch(input, options);
      case "blocked": return new Response("target blocked by the nanobox egress policy (web/proxyext.js)", { status: 403, statusText: "Forbidden" });
      case "extension": { const spec = await requestSpec(input, options, method); return (await proxyFetch(spec)).toResponse(); }
      case "relay": { const spec = await requestSpec(input, options, method); return relayFetch(origFetch, spec); }
      default: return assertNever(chosen);
    }
  }

  // Let the platform normalise every body/header shape (string, FormData, stream, Request, ...)
  async function requestSpec(input: RequestInfo | URL, options: RequestInit, method: string): Promise<SettledSpec> {
    const init: DuplexRequestInit = { ...options, ...(hasStreamingBody(options.body) ? { duplex: "half" } : {}) };
    const request = new Request(input, init);
    const body = ["GET", "HEAD"].includes(method) ? undefined : await request.arrayBuffer();
    return { url: request.url, method, headers: request.headers, body, signal: options.signal ?? undefined };
  }

  // Our server's POST /net/fetch gateway (serve.mjs netFetch): the target travels base64url-encoded
  // in x-nanobox-target, the body verbatim; the server enforces the same allow-list (netpolicy.js).
  function relayFetch(origFetch: typeof fetch, spec: SettledSpec): Promise<Response> {
    const headers: Record<string, string> = {};
    spec.headers.forEach((value, name) => (headers[name] = value));
    const target = JSON.stringify({ url: spec.url, method: spec.method, headers });
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(target))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return origFetch(new URL("/net/fetch", global.location.origin), {
      method: "POST", headers: { "x-nanobox-target": encoded },
      ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    });
  }

  // Page side of a worker's extension route: the worker posts nanobox-proxy-* messages to its owner,
  // this performs them through the extension and posts the replies back in the SAME vocabulary — so
  // response bodies reach the worker chunk by chunk, not buffered. Coexists with worker.onmessage
  // (addEventListener); messages of other types are left alone.
  function bridgeWorker(worker: Worker): Worker {
    if (!isWindow) throw new Error("bridgeWorker runs in the page that owns the worker");
    const controllers = new Map<string, AbortController>();
    const sockets = new Map<string, NanoboxWebSocket>();
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const request = parseWorkerRequest(event.data);
      if (request === null) return;
      switch (request.type) {
        case "nanobox-proxy-fetch": void bridgeFetch({ worker, controllers, id: request.id, spec: request.spec }); return;
        case "nanobox-proxy-abort": { const controller = controllers.get(request.id); if (controller) controller.abort(); return; }
        case "nanobox-proxy-ws-open": bridgeSocket({ worker, sockets, id: request.id, url: request.url, protocols: request.protocols }); return;
        case "nanobox-proxy-ws-send": { const socket = sockets.get(request.id); if (socket) socket.send(request.text !== null ? request.text : request.body ?? new ArrayBuffer(0)); return; }
        case "nanobox-proxy-ws-close": { const socket = sockets.get(request.id); if (socket) socket.close(request.code, request.reason); return; }
        default: assertNever(request);
      }
    });
    return worker;
  }

  async function bridgeFetch({ worker, controllers, id, spec }: Readonly<{ worker: Worker; controllers: Map<string, AbortController>; id: string; spec: NanoboxFetchSpec }>): Promise<void> {
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const result = await proxyFetch({ ...spec, signal: controller.signal });
      const headers: HeaderPair[] = [];
      result.headers.forEach((value, name) => headers.push([name, value]));
      toWorker(worker, { type: "nanobox-proxy-head", id, status: result.status, statusText: result.statusText, headers, dropped: result.dropped });
      if (result.body) await pumpToWorker({ worker, id, body: result.body });
      toWorker(worker, { type: "nanobox-proxy-done", id });
    } catch (error) {
      toWorker(worker, { type: "nanobox-proxy-result", id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      controllers.delete(id);
    }
  }

  async function pumpToWorker({ worker, id, body }: Readonly<{ worker: Worker; id: string; body: ReadableStream<Uint8Array<ArrayBuffer>> }>): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) return;
        const owned = read.value.slice().buffer;   // its own buffer, so it can be transferred
        toWorker(worker, { type: "nanobox-proxy-chunk", id, body: owned }, [owned]);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  function bridgeSocket({ worker, sockets, id, url, protocols }: Readonly<{ worker: Worker; sockets: Map<string, NanoboxWebSocket>; id: string; url: string; protocols: readonly string[] }>): void {
    const socket = new (tunnelledWebSocketClass())(url, protocols.length ? protocols : undefined);
    sockets.set(id, socket);
    socket.addEventListener("open", () => toWorker(worker, { type: "nanobox-proxy-ws-opened", id, protocol: socket.protocol, extensions: socket.extensions }));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") { toWorker(worker, { type: "nanobox-proxy-ws-message", id, text: event.data }); return; }
      const owned = new Uint8Array(event.data as ArrayBuffer).slice().buffer;   // binaryType is "arraybuffer", the tunnel's default
      toWorker(worker, { type: "nanobox-proxy-ws-message", id, body: owned }, [owned]);
    });
    socket.addEventListener("close", (event) => { sockets.delete(id); toWorker(worker, { type: "nanobox-proxy-ws-closed", id, code: event.code, reason: event.reason, wasClean: event.wasClean }); });
  }

  function toWorker(worker: Worker, message: PageLegReply, transfer?: readonly Transferable[]): void {
    if (transfer === undefined) { worker.postMessage(message); return; }
    worker.postMessage(message, [...transfer]);
  }

  // --- small shared pieces

  // `dropped` names the request headers the extension could NOT send: Origin, Host, Referer and
  // Cookie are forbidden request-header names, so Headers.append() silently ignores them even in an
  // extension context (https://fetch.spec.whatwg.org/#forbidden-request-header). Surfacing the list
  // is the difference between a diagnosable 401 and a mystery.
  function proxyResponse({ url, head, stream }: Readonly<{ url: string; head: Extract<ProxyReply, { type: "nanobox-proxy-head" }>; stream: ReadableStream<Uint8Array<ArrayBuffer>> | null }>): NanoboxProxyResponse {
    const headers = new Headers(head.headers.map(([name, value]): [string, string] => [name, value]));
    const status = head.status;
    let buffered: Promise<ArrayBuffer> | null = null;
    const arrayBuffer = (): Promise<ArrayBuffer> => {
      if (!buffered) buffered = stream ? new Response(stream).arrayBuffer() : Promise.resolve(new ArrayBuffer(0));
      return buffered;
    };
    return {
      status, statusText: head.statusText, headers, ok: status >= 200 && status < 300, url,
      dropped: head.dropped,
      body: stream,
      arrayBuffer,
      text: () => arrayBuffer().then((buffer) => new TextDecoder().decode(buffer)),
      json: () => arrayBuffer().then((buffer): unknown => JSON.parse(new TextDecoder().decode(buffer))),
      toResponse: () => new Response(stream, { status, statusText: head.statusText, headers }),
    };
  }

  // An `on<name>` accessor over the EventTarget, so `socket.onmessage = fn` works like the real one.
  function defineHandlerProperty({ owner, target, name }: Readonly<{ owner: NanoboxWebSocket; target: EventTarget; name: keyof NanoboxWebSocketEventMap }>): void {
    let current: EventListener | null = null;
    Object.defineProperty(owner, "on" + name, {
      enumerable: true,
      get: () => current,
      set: (handler: unknown) => {
        if (current) target.removeEventListener(name, current);
        current = typeof handler === "function" ? (handler as EventListener) : null;
        if (current) target.addEventListener(name, current);
      },
    });
  }

  // A MessageEvent where the realm has one, and an Event carrying `data` where it does not (the
  // unit test's stub context). Declared as Event because that is all dispatchEvent needs; the
  // handler types in page-globals.d.ts state the richer shape a real browser delivers.
  function messageEvent(data: string | Blob | ArrayBuffer | null): Event {
    if (typeof MessageEvent === "function") return new MessageEvent("message", { data });
    return Object.assign(new Event("message"), { data });
  }

  function closeEvent({ code, reason, wasClean }: Readonly<{ code: number; reason: string; wasClean: boolean }>): Event {
    if (typeof CloseEvent === "function") return new CloseEvent("close", { code, reason, wasClean });
    return Object.assign(new Event("close"), { code, reason, wasClean });
  }

  // A standalone ArrayBuffer for the structured-clone transfer list, or undefined for "no body".
  function toOwnBuffer(body: unknown): ArrayBuffer | undefined {
    if (body instanceof ArrayBuffer) return body;
    if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return undefined;
  }

  function hasStreamingBody(body: RequestInit["body"]): boolean {
    const record = asRecord(body);
    return record !== null && typeof record["getReader"] === "function";
  }

  function abortErrorFor(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("aborted", "AbortError");
  }

  // --- the parse boundary: the only three functions here that look at a raw message

  function parseReply(raw: unknown): ProxyReply | null {
    const message = asRecord(raw);
    if (message === null) return null;
    const id = String(message["id"]);
    // A branch over an untrusted window/worker message, not over a closed union: an unrecognised
    // type is dropped (the `null`), which is why this one has no assertNever arm.
    switch (message["type"]) {
      case "nanobox-proxy-head": return { type: "nanobox-proxy-head", id, status: Number(message["status"]), statusText: String(message["statusText"] || ""), headers: toHeaderPairs(message["headers"]), dropped: toStringArray(message["dropped"]) };
      case "nanobox-proxy-chunk": { const body = asArrayBuffer(message["body"]); return body === null ? null : { type: "nanobox-proxy-chunk", id, body }; }
      case "nanobox-proxy-done": return { type: "nanobox-proxy-done", id };
      case "nanobox-proxy-result": return { type: "nanobox-proxy-result", id, error: String(message["error"] || "failed") };
      case "nanobox-proxy-ws-opened": return { type: "nanobox-proxy-ws-opened", id, protocol: String(message["protocol"] || ""), extensions: String(message["extensions"] || "") };
      case "nanobox-proxy-ws-message": { const text = message["text"]; return { type: "nanobox-proxy-ws-message", id, text: typeof text === "string" ? text : null, body: asArrayBuffer(message["body"]) }; }
      case "nanobox-proxy-ws-closed": return { type: "nanobox-proxy-ws-closed", id, code: Number(message["code"]) || 1005, reason: String(message["reason"] || ""), wasClean: Boolean(message["wasClean"]) };
      default: return null;
    }
  }

  function parseWorkerRequest(raw: unknown): WorkerRequest | null {
    const message = asRecord(raw);
    if (message === null) return null;
    const id = String(message["id"]);
    switch (message["type"]) {
      case "nanobox-proxy-fetch": {
        const spec = asRecord(message["spec"]) ?? {};
        const body = asArrayBuffer(spec["body"]);
        return { type: "nanobox-proxy-fetch", id, spec: { url: String(spec["url"]), method: String(spec["method"] || "GET"), headers: toHeadersInit(spec["headers"]), ...(body === null ? {} : { body }) } };
      }
      case "nanobox-proxy-abort": return { type: "nanobox-proxy-abort", id };
      case "nanobox-proxy-ws-open": return { type: "nanobox-proxy-ws-open", id, url: String(message["url"]), protocols: toStringArray(message["protocols"]) };
      case "nanobox-proxy-ws-send": { const text = message["text"]; return { type: "nanobox-proxy-ws-send", id, text: typeof text === "string" ? text : null, body: asArrayBuffer(message["body"]) }; }
      case "nanobox-proxy-ws-close": {
        const code = message["code"];
        const reason = message["reason"];
        return { type: "nanobox-proxy-ws-close", id, code: code === undefined ? undefined : Number(code), reason: reason === undefined ? undefined : String(reason) };
      }
      default: return null;
    }
  }

  // The same narrowing step extension/src/wire.ts calls asRecord. Duplicated rather than shared:
  // proxyext.js is loaded by the page without wire.js, and a classic script cannot import.
  function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (typeof value !== "object" || value === null) return null;
    // the line above just proved it is a non-null object, which is all this return type claims
    return value as Readonly<Record<string, unknown>>;
  }

  function asArrayBuffer(value: unknown): ArrayBuffer | null {
    return value instanceof ArrayBuffer ? value : null;
  }

  function toHeaderPairs(value: unknown): readonly HeaderPair[] {
    if (!Array.isArray(value)) return [];
    const pairs: HeaderPair[] = [];
    for (const entry of value as readonly unknown[]) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [name, headerValue] = entry as readonly unknown[];
      pairs.push([String(name), String(headerValue)]);
    }
    return pairs;
  }

  // A worker may state headers as a pair list or as a plain object; `new Headers` takes either.
  function toHeadersInit(value: unknown): HeadersInit {
    if (Array.isArray(value)) return toHeaderPairs(value).map(([name, headerValue]): [string, string] => [name, headerValue]);
    const record = asRecord(value);
    if (record === null) return [];
    return Object.fromEntries(Object.entries(record).map(([name, headerValue]): [string, string] => [name, String(headerValue)]));
  }

  function toStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return (value as readonly unknown[]).map(String);
  }

  // Makes adding a message type or a route a COMPILE error at every switch that dispatches on one.
  function assertNever(value: never): never {
    throw new Error("nanobox proxy: unhandled case " + String(value));
  }

  global.NanoboxProxy = NanoboxProxy;
})(typeof self !== "undefined" ? self : globalThis);
