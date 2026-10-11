// nanobox proxy — the wire format and the egress policy shared by content.js, background.js and
// offscreen.js (MIT License, see README.md).
//
// Loaded as a classic script into all three contexts (the content script lists it before content.js,
// the service worker importScripts()es it, offscreen.html has a <script src>), so it may not use
// ESM syntax and may not assume `window`, `document` or `chrome` exist.
//
// THE PORT LEG IS JSON-ONLY. chrome.runtime messaging serialises with JSON, so an ArrayBuffer
// arrives as `{}` (verified on Chrome 131) and a single message is capped at ~64 MB. Every body
// therefore travels base64-encoded in CHUNK_BYTES-sized pieces. The page leg (window.postMessage)
// uses structured clone and carries ArrayBuffers verbatim, so only this one hop pays the 33 %.
"use strict";

(function (global: typeof globalThis) {
  const NanoboxProxyWire = {
    // Bumped when the page<->extension protocol changes incompatibly. 2 added: streamed response
    // bodies (head/chunk/done instead of one buffered result), WebSocket tunnelling, and resumption
    // of a session whose service worker was terminated mid-stream.
    PROTOCOL_VERSION: 2,
    // chrome.runtime.connect names. The session id in the suffix is what lets a reconnecting content
    // script re-attach to the offscreen document's still-live fetches and sockets.
    PAGE_PORT_PREFIX: "nanobox-proxy:",
    OFFSCREEN_PORT_PREFIX: "nanobox-offscreen:",
    // One base64 message is 4/3 of this. 4 MiB keeps every port message far below the ~64 MB cap.
    CHUNK_BYTES: 4 * 1024 * 1024,
    // The content script pokes the service worker this often while anything is in flight. Chrome's
    // documented idle timeout is 30 s and receiving a message resets it (see README "lifetime").
    KEEPALIVE_MS: 20000,
    // How long the offscreen document keeps a detached session's fetches and sockets alive waiting
    // for the content script to re-attach after the service worker was terminated.
    SESSION_GRACE_MS: 60000,
    // Backpressure: the offscreen document stops reading a response body once this many unacked
    // bytes are queued for the page, so a 250 MB download cannot be buffered in the extension.
    HIGH_WATER_BYTES: 8 * 1024 * 1024,
    // Which page origins may use the bridge at all. The manifest's content_scripts.matches is the
    // first gate; background.js checks the port sender against this as the second.
    ALLOWED_PAGE_ORIGINS: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
    // Cloud metadata endpoints: reachable from the browser's network but never from a web page. The
    // one class of target this extension refuses to become a bridge to (mirrored in
    // web/src/proxyext.ts BLOCKED_TARGET_HOSTS so the page does not even ask).
    BLOCKED_TARGET_HOSTS: new Set(["169.254.169.254", "metadata.google.internal", "[fd00:ec2::254]", "100.100.100.200"]),
    // Hop-by-hop / transport headers that must not be replayed to the page: the browser already
    // decoded the body (content-encoding) and its length changed accordingly (content-length).
    STRIPPED_RESPONSE_HEADERS: new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]),
    isAllowedPageOrigin,
    pageOriginOf,
    httpRefusal,
    webSocketRefusal,
    responseHeadersFor,
    base64Chunks,
    bytesToBase64,
    base64ToBytes,
    asRecord,
    asWireMessage,
    toHeaderPairs,
    toStringArray,
    assertNever,
    // The declaration in wire-globals.d.ts is what content.ts / background.ts / offscreen.ts are
    // checked against; this makes a member that drifts from it a compile error HERE.
  } satisfies NanoboxProxyWireApi;

  function isAllowedPageOrigin(origin: string | null): boolean {
    return typeof origin === "string" && NanoboxProxyWire.ALLOWED_PAGE_ORIGINS.some((pattern) => pattern.test(origin));
  }

  // The origin a chrome.runtime port's sender speaks for, or null when it has none we can trust.
  function pageOriginOf(sender: chrome.runtime.MessageSender | undefined): string | null {
    if (!sender) return null;
    if (typeof sender.origin === "string" && sender.origin) return sender.origin;
    if (typeof sender.url !== "string" || !sender.url) return null;
    try { return new URL(sender.url).origin; } catch { return null; }
  }

  // Why this http(s) target must be refused, or null when it may be fetched.
  function httpRefusal(url: string): string | null {
    let target: URL;
    try { target = new URL(url); } catch { return "not a URL: " + String(url); }
    if (!/^https?:$/.test(target.protocol)) return "only http(s) targets are proxied, not " + target.protocol;
    if (NanoboxProxyWire.BLOCKED_TARGET_HOSTS.has(target.hostname)) return "target host is blocked by the nanobox proxy policy";
    return null;
  }

  // Why this ws(s) target must be refused, or null when a socket may be opened to it.
  function webSocketRefusal(url: string): string | null {
    let target: URL;
    try { target = new URL(url); } catch { return "not a URL: " + String(url); }
    if (!/^wss?:$/.test(target.protocol)) return "only ws(s) targets are tunnelled, not " + target.protocol;
    if (NanoboxProxyWire.BLOCKED_TARGET_HOSTS.has(target.hostname)) return "target host is blocked by the nanobox proxy policy";
    return null;
  }

  // The header list the page is given for a fetched response: everything the browser exposed minus
  // the transport headers, plus where a redirect actually landed. content-length is deliberately
  // dropped and NOT recomputed — the body is streamed, so its total is unknown at head time.
  function responseHeadersFor(response: Response): readonly HeaderPair[] {
    const headers: HeaderPair[] = [];
    response.headers.forEach((value, name) => { if (!NanoboxProxyWire.STRIPPED_RESPONSE_HEADERS.has(name)) headers.push([name, value]); });
    if (response.redirected) headers.push(["x-nanobox-redirected-to", response.url]);
    return headers;
  }

  function base64Chunks(bytes: Uint8Array): readonly string[] {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += NanoboxProxyWire.CHUNK_BYTES) chunks.push(bytesToBase64(bytes.subarray(offset, offset + NanoboxProxyWire.CHUNK_BYTES)));
    return chunks;
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    // Spread, not String.fromCharCode.apply(null, …): under strictBindCallApply `apply` wants the
    // declared number[] and a Uint8Array is not one. Same 0x8000-element batches, same result.
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  // --- the parse boundary. Everything above this line works on typed values; these three are the
  // only functions in the extension allowed to look at a raw message off a port or a window.

  // A message port hands over `any`/`unknown`. This is the single narrowing step: a non-null
  // object whose every field still reads as `unknown`, so the caller is forced to coerce them.
  function asRecord(value: unknown): WireRecord | null {
    if (typeof value !== "object" || value === null) return null;
    // the line above just proved it is a non-null object, and WireRecord claims nothing more
    return value as WireRecord;
  }

  // The same, for something that must be dispatchable: a record carrying a string `type`.
  function asWireMessage(value: unknown): WireMessage | null {
    const record = asRecord(value);
    if (record === null) return null;
    // the guard on the next line is exactly WireMessage's one extra claim over WireRecord
    return typeof record["type"] === "string" ? (record as WireMessage) : null;
  }

  // A header list off the wire: [[name, value], …], with anything malformed dropped rather than
  // thrown on — a header the page could not state is not a reason to fail the whole request.
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

  function toStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return (value as readonly unknown[]).map(String);
  }

  // Makes adding a message type a COMPILE error at every switch that dispatches on one, instead of
  // a message that silently takes the `default` arm. Lives here because wire.js is the one file all
  // three extension contexts already load; web/src/proxyext.ts has its own copy for want of one.
  function assertNever(value: never): never {
    throw new Error("nanobox proxy: unhandled case " + String(value));
  }

  global.NanoboxProxyWire = NanoboxProxyWire;
})(typeof self !== "undefined" ? self : globalThis);
