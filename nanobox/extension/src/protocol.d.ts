// nanobox proxy — the message types of BOTH legs of the bridge (MIT License, see
// extension/README.md).
//
// Shared by the extension sources (extension/src/*.ts) and the page-side client
// (web/src/proxyext.ts) so the two halves of the protocol cannot drift apart. Ambient on purpose:
// every file in this bridge ships as a CLASSIC script — manifest.json lists wire.js + content.js,
// background.js importScripts()es wire.js, offscreen.html has two <script src>, and the page loads
// proxyext.js with a <script> and reads the `NanoboxProxy` global — so there is no module graph to
// import types through. A .d.ts with no top-level import/export is a global script, which is what
// makes one definition reachable from every context without changing the shipped artifact.
//
// These are the SENDER's contract: the shape a conforming sender must put on the wire. A receiver
// does not get to assume it — a message port hands over `unknown` — so each receiver parses into
// its own in-hand shape (content.ts's ParsedPageRequest, proxyext.ts's ProxyReply), which differs
// where the wire and the code want different things: a body travels as a transferable ArrayBuffer
// and is used as a Uint8Array. Those parsers are the only code allowed to look at a raw value, and
// they keep the historical coercions (String(id), Number(code) || 1000) so a lenient sender still
// works while everything downstream of them is typed.

type HeaderPair = readonly [name: string, value: string];

// Any non-null object that came off a wire. Every field reads as `unknown`, which is what forces
// the parse step. Produced only by NanoboxProxyWire.asRecord / .asWireMessage.
type WireRecord = Readonly<Record<string, unknown>>;
// A WireRecord that also carries a string `type` — i.e. something that can be dispatched on.
type WireMessage = WireRecord & Readonly<{ type: string }>;

// --- page leg: window.postMessage between the page and the content script's isolated world, and
// worker.postMessage between a worker and the page that bridged it. Structured clone, so an
// ArrayBuffer travels verbatim and only the port leg below pays base64.
//
// The upstream and downstream vocabularies are DISJOINT on purpose: window.postMessage reaches
// every listener on the window, the sender's own included, so a shared "nanobox-proxy-ws-open"
// made the content script answer its own reply as a second open request.

type PageLegRequest =
  | Readonly<{ type: "nanobox-proxy-ping" }>
  | Readonly<{ type: "nanobox-proxy-fetch"; id: string; spec: PageFetchSpec }>
  | Readonly<{ type: "nanobox-proxy-abort"; id: string }>
  | Readonly<{ type: "nanobox-proxy-ws-open"; id: string; url: string; protocols: readonly string[] }>
  // exactly one of text / body is present; `text` wins when both are
  | Readonly<{ type: "nanobox-proxy-ws-send"; id: string; text?: string | undefined; body?: ArrayBuffer | undefined }>
  | Readonly<{ type: "nanobox-proxy-ws-close"; id: string; code: number; reason: string }>;

type PageFetchSpec = Readonly<{
  url: string;
  method: string;
  headers: readonly HeaderPair[];
  body?: ArrayBuffer | undefined;
}>;

type PageLegReply =
  | Readonly<{ type: "nanobox-proxy-hello"; version: number; features: readonly string[] }>
  | Readonly<{ type: "nanobox-proxy-head"; id: string; status: number; statusText: string; headers: readonly HeaderPair[]; dropped: readonly string[] }>
  | Readonly<{ type: "nanobox-proxy-chunk"; id: string; body: ArrayBuffer }>
  | Readonly<{ type: "nanobox-proxy-done"; id: string }>
  | Readonly<{ type: "nanobox-proxy-result"; id: string; error: string }>
  | Readonly<{ type: "nanobox-proxy-ws-opened"; id: string; protocol: string; extensions: string }>
  | Readonly<{ type: "nanobox-proxy-ws-message"; id: string; text?: string | undefined; body?: ArrayBuffer | undefined }>
  | Readonly<{ type: "nanobox-proxy-ws-closed"; id: string; code: number; reason: string; wasClean: boolean }>;

// --- port leg: chrome.runtime.Port, content script <-> service worker <-> offscreen document.
// JSON-ONLY — an ArrayBuffer arrives as `{}` — so every body byte travels base64 in `b64`.

type PortLegUpstream =
  // the content script's first message on every connect AND reconnect: "I have everything up to ack"
  | Readonly<{ type: "hello"; ack: number }>
  | Readonly<{ type: "ack"; seq: number }>
  // its only job is being received: that is what resets the service worker's 30 s idle timer
  | Readonly<{ type: "keepalive" }>
  | Readonly<{ type: "fetch-begin"; id: string; url: string; method: string; headers: readonly HeaderPair[] }>
  | Readonly<{ type: "fetch-body"; id: string; b64: string }>
  | Readonly<{ type: "fetch-end"; id: string }>
  | Readonly<{ type: "abort"; id: string }>
  | Readonly<{ type: "ws-open"; id: string; url: string; protocols: readonly string[] }>
  | Readonly<{ type: "ws-send"; id: string; text?: string | undefined; b64?: string | undefined }>
  | Readonly<{ type: "ws-close"; id: string; code: number; reason: string }>
  // minted by background.js, not by the page: the PAGE is gone, so drop the session now instead of
  // holding its sockets for the service-worker-was-terminated grace period
  | Readonly<{ type: "session-gone" }>;

type PortLegDownstream =
  | Readonly<{ type: "head"; id: string; status: number; statusText: string; headers: readonly HeaderPair[]; dropped: readonly string[] }>
  | Readonly<{ type: "chunk"; id: string; b64: string }>
  | Readonly<{ type: "end"; id: string }>
  | Readonly<{ type: "error"; id: string; message: string }>
  | Readonly<{ type: "ws-opened"; id: string; protocol: string; extensions: string }>
  | Readonly<{ type: "ws-text"; id: string; text: string }>
  | Readonly<{ type: "ws-binary"; id: string; b64: string }>
  | Readonly<{ type: "ws-closed"; id: string; code: number; reason: string; wasClean: boolean }>;

// Every downstream message is numbered so a reconnecting content script can be replayed exactly
// the gap it is missing, and so a replayed message it already has can be dropped on arrival.
type NumberedDownstream = PortLegDownstream & Readonly<{ seq: number }>;

// offscreen -> background handshake. Never numbered and never relayed to the page: it only tells
// background.js that the offscreen document's onConnect listener is live, so the broker does not
// have to guess how long the document took to load.
type OffscreenReady = Readonly<{ type: "offscreen-ready" }>;

// background -> content. The one failure the broker reports itself; `fatal` is what makes the
// content script fail every live request instead of waiting for a seq that will never come.
type BrokerFailure = Readonly<{ type: "error"; fatal: true; message: string }>;
