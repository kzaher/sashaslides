// nanobox proxy — content script (MIT License, see README.md)
//
// Bridge between the page (window.postMessage, structured clone, ArrayBuffers travel verbatim) and
// the extension (one chrome.runtime.Port, JSON only, bodies base64). It is a pure relay: it owns no
// request state beyond "which ids is the page still waiting for", so that the response body can be
// forwarded chunk by chunk as it arrives instead of being buffered until the stream ends.
//
// The two vocabularies are PageLegRequest / PageLegReply upstream and PortLegUpstream /
// NumberedDownstream downstream — all four in src/protocol.d.ts, with the page's half of each pair
// implemented by web/src/proxyext.ts.
// The upstream and downstream names differ ON PURPOSE: window.postMessage reaches every listener on
// the window, this one included, so a shared "nanobox-proxy-ws-open" made this script answer its own
// reply as a second open request. Requests are -ws-open/-ws-send/-ws-close, replies -ws-opened/
// -ws-message/-ws-closed, and neither side has a case for the other's vocabulary.
// Only messages posted by this very window (event.source === window) are honoured, and the
// manifest's content_scripts.matches decides which page origins get the bridge at all.
//
// RESUMPTION. If Chrome terminates the service worker mid-stream the port dies. Everything is still
// alive in the offscreen document, so this script reconnects with the SAME session id and the
// highest sequence number it has delivered; the offscreen document replays the gap. Nothing above
// this layer notices.
"use strict";

(function () {
  // The page-leg requests AS THIS SCRIPT HOLDS THEM, which is not quite PageLegRequest: a body
  // arrives as an ArrayBuffer (or, historically, any view over one) and leaves as the Uint8Array
  // the base64 framing needs, and `headers` arrives as either a pair list or a plain object. The
  // parse boundary below is where that leniency lives, so nothing downstream has to repeat it.
  type ParsedPageRequest =
    | Readonly<{ type: "nanobox-proxy-ping" }>
    | Readonly<{ type: "nanobox-proxy-fetch"; id: string; url: string; method: string; headers: readonly HeaderPair[]; body: Uint8Array | null }>
    | Readonly<{ type: "nanobox-proxy-abort"; id: string }>
    | Readonly<{ type: "nanobox-proxy-ws-open"; id: string; url: string; protocols: readonly string[] }>
    | Readonly<{ type: "nanobox-proxy-ws-send"; id: string; text: string | null; bytes: Uint8Array | null }>
    | Readonly<{ type: "nanobox-proxy-ws-close"; id: string; code: number; reason: string }>;

  // What arrives on the port. `fatal` is the broker reporting its own failure and carries no seq,
  // so it cannot go through the sequence bookkeeping the numbered messages do.
  type BrokerMessage =
    | Readonly<{ kind: "fatal"; message: string }>
    | Readonly<{ kind: "downstream"; message: NumberedDownstream }>;

  const wire = NanoboxProxyWire;
  // Acknowledge in batches — one ack per chunk would double the port traffic for nothing. BOTH
  // triggers are needed: the offscreen document stops reading a body once HIGH_WATER_BYTES (8 MiB)
  // are unacked, so a message-count-only trigger DEADLOCKS on big chunks — two 4 MiB chunks fill that
  // window long before eight messages have arrived.
  const ACK_EVERY = 8;
  const ACK_BYTES = 1024 * 1024;
  const RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY_MS = 100;

  const sessionId = newSessionId();
  // ids the page is still expecting answers for (fetches and sockets); drives the keepalive
  const live = new Set<string>();
  let port: chrome.runtime.Port | null = null;
  let deliveredSeq = 0;
  let unacknowledged = 0;
  let unacknowledgedBytes = 0;
  let reconnectsLeft = RECONNECT_ATTEMPTS;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window) return;
    const request = parsePageRequest(event.data);
    if (request === null) return;
    switch (request.type) {
      case "nanobox-proxy-ping": announce(); return;
      case "nanobox-proxy-fetch": startFetch(request); return;
      case "nanobox-proxy-abort": send(request.id, { type: "abort", id: request.id }, { closes: true }); return;
      case "nanobox-proxy-ws-open": openSocket(request); return;
      case "nanobox-proxy-ws-send": sendSocket(request); return;
      case "nanobox-proxy-ws-close": send(request.id, { type: "ws-close", id: request.id, code: request.code, reason: request.reason }); return;
      default: wire.assertNever(request);
    }
  });
  announce();

  function announce(): void {
    toPage({ type: "nanobox-proxy-hello", version: wire.PROTOCOL_VERSION, features: ["stream", "websocket", "resume"] });
  }

  function startFetch(request: Extract<ParsedPageRequest, { type: "nanobox-proxy-fetch" }>): void {
    const id = request.id;
    live.add(id);
    if (!send(id, { type: "fetch-begin", id, url: request.url, method: request.method, headers: request.headers })) return;
    if (request.body) for (const b64 of wire.base64Chunks(request.body)) send(id, { type: "fetch-body", id, b64 });
    send(id, { type: "fetch-end", id });
  }

  function openSocket(request: Extract<ParsedPageRequest, { type: "nanobox-proxy-ws-open" }>): void {
    live.add(request.id);
    send(request.id, { type: "ws-open", id: request.id, url: request.url, protocols: request.protocols });
  }

  function sendSocket(request: Extract<ParsedPageRequest, { type: "nanobox-proxy-ws-send" }>): void {
    if (request.text !== null) { send(request.id, { type: "ws-send", id: request.id, text: request.text }); return; }
    send(request.id, { type: "ws-send", id: request.id, b64: request.bytes ? wire.bytesToBase64(request.bytes) : "" });
  }

  // Pushes one upstream message, reporting failure to the page as an error for `id`. `closes` marks a
  // message after which the page expects nothing more, so the id leaves the live set.
  function send(id: string, message: PortLegUpstream, options?: Readonly<{ closes: boolean }>): boolean {
    if (options?.closes) live.delete(id);
    let bridge: chrome.runtime.Port;
    try { bridge = ensurePort(); } catch (error) { finish(id, "extension unavailable: " + describe(error)); return false; }
    try { bridge.postMessage(message); } catch (error) { finish(id, "extension port closed: " + describe(error)); return false; }
    scheduleKeepalive();
    return true;
  }

  function ensurePort(): chrome.runtime.Port {
    if (port) return port;
    const opened = chrome.runtime.connect({ name: wire.PAGE_PORT_PREFIX + sessionId });
    opened.onMessage.addListener(onPortMessage);
    opened.onDisconnect.addListener(onPortLost);
    port = opened;
    // first message on every connect AND reconnect: "I have everything up to deliveredSeq"
    opened.postMessage({ type: "hello", ack: deliveredSeq } satisfies PortLegUpstream);
    return opened;
  }

  function onPortMessage(raw: unknown): void {
    const parsed = parseFromBroker(raw);
    if (parsed === null) return;
    switch (parsed.kind) {
      case "fatal": failEverything(parsed.message); return;
      case "downstream": deliver(parsed.message); return;
      default: wire.assertNever(parsed);
    }
  }

  function deliver(message: NumberedDownstream): void {
    // a replayed message the page already has (reconnect overlap): dropping it is the point of `seq`
    if (message.seq <= deliveredSeq) return;
    deliveredSeq = message.seq;
    reconnectsLeft = RECONNECT_ATTEMPTS;
    unacknowledged++;
    unacknowledgedBytes += payloadBytesOf(message);
    if (unacknowledged >= ACK_EVERY || unacknowledgedBytes >= ACK_BYTES) acknowledge();
    const id = message.id;
    switch (message.type) {
      case "head": toPage({ type: "nanobox-proxy-head", id, status: message.status, statusText: message.statusText, headers: message.headers, dropped: message.dropped }); return;
      case "chunk": { const bytes = wire.base64ToBytes(message.b64); toPage({ type: "nanobox-proxy-chunk", id, body: bytes.buffer }, [bytes.buffer]); return; }
      case "end": live.delete(id); acknowledge(); toPage({ type: "nanobox-proxy-done", id }); scheduleKeepalive(); return;
      case "error": finish(id, message.message); return;
      case "ws-opened": toPage({ type: "nanobox-proxy-ws-opened", id, protocol: message.protocol, extensions: message.extensions }); return;
      case "ws-text": toPage({ type: "nanobox-proxy-ws-message", id, text: message.text }); return;
      case "ws-binary": { const bytes = wire.base64ToBytes(message.b64); toPage({ type: "nanobox-proxy-ws-message", id, body: bytes.buffer }, [bytes.buffer]); return; }
      case "ws-closed": live.delete(id); acknowledge(); toPage({ type: "nanobox-proxy-ws-closed", id, code: message.code, reason: message.reason, wasClean: message.wasClean }); scheduleKeepalive(); return;
      default: wire.assertNever(message);
    }
  }

  // The port is gone. With nothing in flight that is just the idle service worker being collected;
  // with work outstanding it is a mid-stream termination, and the offscreen document still holds the
  // fetches and sockets — so reconnect and let it replay from deliveredSeq.
  function onPortLost(): void {
    const reason = chrome.runtime.lastError?.message ?? "no reason given";
    port = null;
    if (live.size === 0) { scheduleKeepalive(); return; }
    if (reconnectsLeft-- <= 0) { failEverything("extension disconnected and could not be reached again (" + reason + ")"); return; }
    setTimeout(() => { if (live.size === 0) return; try { ensurePort(); } catch (error) { failEverything("extension unavailable: " + describe(error)); } }, RECONNECT_DELAY_MS);
  }

  function acknowledge(): void {
    if (unacknowledged === 0 || !port) return;
    unacknowledged = 0;
    unacknowledgedBytes = 0;
    try { port.postMessage({ type: "ack", seq: deliveredSeq } satisfies PortLegUpstream); } catch { /* the reconnect will re-ack */ }
  }

  function finish(id: string, error: string): void {
    live.delete(id);
    acknowledge();
    toPage({ type: "nanobox-proxy-result", id, error });
    scheduleKeepalive();
  }

  function failEverything(error: string): void {
    for (const id of [...live]) finish(id, error);
  }

  function toPage(message: PageLegReply, transfer?: readonly ArrayBuffer[]): void {
    window.postMessage(message, location.origin, transfer === undefined ? [] : [...transfer]);
  }

  // While anything is in flight, poke the service worker so its 30 s idle timer never expires
  // mid-stream ("Receiving an event or calling an extension API resets this timer"). An open but idle
  // port is NOT a keep-alive: "Opening a port no longer resets the timers" (Chrome 114).
  function scheduleKeepalive(): void {
    if (live.size === 0) { if (keepaliveTimer !== null) clearInterval(keepaliveTimer); keepaliveTimer = null; return; }
    if (keepaliveTimer !== null) return;
    keepaliveTimer = setInterval(() => {
      if (live.size === 0) { scheduleKeepalive(); return; }
      if (!port) return;
      try { port.postMessage({ type: "keepalive" } satisfies PortLegUpstream); } catch { /* onPortLost will reconnect */ }
    }, wire.KEEPALIVE_MS);
  }

  // What this message cost the offscreen document's backpressure window: the DECODED payload size,
  // which is what it charged when it queued the message. Exhaustive, so a new numbered message type
  // cannot quietly travel as free.
  function payloadBytesOf(message: NumberedDownstream): number {
    switch (message.type) {
      case "chunk": case "ws-binary": return Math.floor((message.b64.length * 3) / 4);
      case "ws-text": return message.text.length;
      case "head": case "end": case "error": case "ws-opened": case "ws-closed": return 0;
      default: return wire.assertNever(message);
    }
  }

  // --- the parse boundary: the only two functions here that look at a raw message

  function parsePageRequest(raw: unknown): ParsedPageRequest | null {
    const message = wire.asWireMessage(raw);
    if (message === null) return null;
    const id = String(message["id"]);
    // A page can post any string type; this is a guard over untrusted input, not a branch on a
    // closed union, which is why it ends in `null` instead of an assertNever.
    switch (message.type) {
      case "nanobox-proxy-ping": return { type: "nanobox-proxy-ping" };
      case "nanobox-proxy-fetch": {
        const spec: WireRecord = wire.asRecord(message["spec"]) ?? {};
        return {
          type: "nanobox-proxy-fetch", id,
          url: String(spec["url"]),
          method: String(spec["method"] || "GET").toUpperCase(),
          headers: toHeaderList(spec["headers"]),
          body: asBytes(spec["body"]),
        };
      }
      case "nanobox-proxy-abort": return { type: "nanobox-proxy-abort", id };
      case "nanobox-proxy-ws-open": return { type: "nanobox-proxy-ws-open", id, url: String(message["url"]), protocols: wire.toStringArray(message["protocols"]) };
      case "nanobox-proxy-ws-send": {
        const text = message["text"];
        return { type: "nanobox-proxy-ws-send", id, text: typeof text === "string" ? text : null, bytes: asBytes(message["body"]) };
      }
      case "nanobox-proxy-ws-close": return { type: "nanobox-proxy-ws-close", id, code: Number(message["code"]) || 1000, reason: String(message["reason"] || "") };
      default: return null;
    }
  }

  function parseFromBroker(raw: unknown): BrokerMessage | null {
    const message = wire.asWireMessage(raw);
    if (message === null) return null;
    if (message["fatal"]) return { kind: "fatal", message: String(message["message"] || "extension error") };
    const seq = Number(message["seq"]) || 0;
    const id = String(message["id"]);
    switch (message.type) {
      case "head": return { kind: "downstream", message: { seq, type: "head", id, status: Number(message["status"]), statusText: String(message["statusText"] || ""), headers: wire.toHeaderPairs(message["headers"]), dropped: wire.toStringArray(message["dropped"]) } };
      case "chunk": return { kind: "downstream", message: { seq, type: "chunk", id, b64: String(message["b64"]) } };
      case "end": return { kind: "downstream", message: { seq, type: "end", id } };
      case "error": return { kind: "downstream", message: { seq, type: "error", id, message: String(message["message"]) } };
      case "ws-opened": return { kind: "downstream", message: { seq, type: "ws-opened", id, protocol: String(message["protocol"] || ""), extensions: String(message["extensions"] || "") } };
      case "ws-text": return { kind: "downstream", message: { seq, type: "ws-text", id, text: String(message["text"]) } };
      case "ws-binary": return { kind: "downstream", message: { seq, type: "ws-binary", id, b64: String(message["b64"]) } };
      case "ws-closed": return { kind: "downstream", message: { seq, type: "ws-closed", id, code: Number(message["code"]) || 1005, reason: String(message["reason"] || ""), wasClean: Boolean(message["wasClean"]) } };
      default: return null;
    }
  }

  // The page may state request headers as a pair list or as a plain object; both reach the port as
  // a pair list.
  function toHeaderList(value: unknown): readonly HeaderPair[] {
    if (Array.isArray(value)) return wire.toHeaderPairs(value);
    const record = wire.asRecord(value);
    if (record === null) return [];
    return Object.entries(record).map(([name, headerValue]): HeaderPair => [name, String(headerValue)]);
  }

  function asBytes(body: unknown): Uint8Array | null {
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function newSessionId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
})();
