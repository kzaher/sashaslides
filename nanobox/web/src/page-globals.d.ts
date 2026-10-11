// nanobox — the globals the page-side scripts publish and consume (MIT License, see
// extension/README.md). Ambient because web/netpolicy.js and web/proxyext.js are classic scripts
// the VM pages load with <script src>: there is no module graph, the contract IS the global.

// web/netpolicy.js — the egress allow-list, also enforced server-side by serve.mjs. Possibly
// undefined on purpose: proxyext.ts throws a diagnosable error when it was not loaded first.
interface NanoboxNetPolicyApi {
  readonly PROXY_HOSTS: readonly string[];
  isProxied(urlOrHost: string): boolean;
}
declare var NanoboxNetPolicy: NanoboxNetPolicyApi | undefined;

// Where a cross-origin request goes. A closed set, so every decision site dispatches on it with an
// exhaustive switch and adding a route is a compile error rather than a silent `default`.
type NanoboxRoute = "direct" | "extension" | "relay" | "blocked";

type NanoboxRouteOptions = Readonly<{
  // "is the extension present" — the page learns it from detect(), a worker is told by its page
  extension?: boolean | undefined;
  // opt this call out of the extension for a host netpolicy.js says answers CORS
  preferDirect?: boolean | undefined;
}>;

type NanoboxFetchSpec = Readonly<{
  url: string;
  method?: string | undefined;
  headers?: HeadersInit | undefined;
  body?: ArrayBuffer | ArrayBufferView | undefined;
  signal?: AbortSignal | undefined;
}>;

// A `fetch` Response in all but name: resolved at the HEAD, with `body` still filling. That is the
// whole point for an SSE response, which stays open for minutes after its head.
interface NanoboxProxyResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly url: string;
  // the request headers the extension could NOT send (Origin, Host, Referer, Cookie are forbidden
  // request-header names, so Headers.append() ignores them even in an extension context)
  readonly dropped: readonly string[];
  readonly body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  toResponse(): Response;
}

interface NanoboxWebSocketEventMap {
  open: Event;
  message: MessageEvent;
  close: CloseEvent;
  error: Event;
}

// The slice of the WebSocket interface a tunnel can honestly implement. bufferedAmount is always 0
// because the real socket lives in the extension's offscreen document, and the handshake carries
// the EXTENSION's Origin (chrome-extension://<id>), never the page's.
interface NanoboxWebSocket extends EventTarget {
  readonly url: string;
  readonly readyState: number;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener<TName extends keyof NanoboxWebSocketEventMap>(type: TName, listener: (event: NanoboxWebSocketEventMap[TName]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

interface NanoboxWebSocketConstructor {
  new (url: string | URL, protocols?: string | readonly string[]): NanoboxWebSocket;
}

type NanoboxWorkerFetchConfig = Readonly<{
  extension?: boolean | undefined;
  onRoute?: ((chosen: Readonly<{ route: NanoboxRoute; method: string; url: string }>) => void) | undefined;
}>;

interface NanoboxProxyApi {
  readonly VERSION: number;
  // last detect() result; null before the first one. Mutable: a page may set it from out of band.
  detected: boolean | null;
  features: readonly string[];
  readonly POLICY: string;
  detect(timeoutMs?: number): Promise<boolean>;
  route(url: string | URL, options?: NanoboxRouteOptions): NanoboxRoute;
  fetch(spec: NanoboxFetchSpec): Promise<NanoboxProxyResponse>;
  readonly WebSocket: NanoboxWebSocketConstructor;
  workerFetch(origFetch: typeof fetch, input: RequestInfo | URL, init: RequestInit | undefined, cfg: NanoboxWorkerFetchConfig): Promise<Response>;
  bridgeWorker(worker: Worker): Worker;
}

declare var NanoboxProxy: NanoboxProxyApi;
