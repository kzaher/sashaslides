// nanobox proxy — the globals the extension's classic scripts share (MIT License, see
// extension/README.md).
//
// wire.js assigns `NanoboxProxyWire` onto the global of whichever context loaded it; content.js,
// background.js and offscreen.js read it as a free identifier. A runtime assignment is invisible
// to the compiler, so the global is declared here ONCE and wire.ts is checked against the same
// interface with `satisfies` — drift between the declaration and the implementation is a compile
// error, which is the whole reason the declaration is not just a hand-maintained shim.

interface NanoboxProxyWireApi {
  // Bumped when the page<->extension protocol changes incompatibly.
  readonly PROTOCOL_VERSION: number;
  // chrome.runtime.connect names. The session id suffix is what lets a reconnecting content script
  // re-attach to the offscreen document's still-live fetches and sockets.
  readonly PAGE_PORT_PREFIX: string;
  readonly OFFSCREEN_PORT_PREFIX: string;
  // One base64 message is 4/3 of this.
  readonly CHUNK_BYTES: number;
  readonly KEEPALIVE_MS: number;
  readonly SESSION_GRACE_MS: number;
  readonly HIGH_WATER_BYTES: number;
  readonly ALLOWED_PAGE_ORIGINS: readonly RegExp[];
  readonly BLOCKED_TARGET_HOSTS: ReadonlySet<string>;
  readonly STRIPPED_RESPONSE_HEADERS: ReadonlySet<string>;
  isAllowedPageOrigin(origin: string | null): boolean;
  pageOriginOf(sender: chrome.runtime.MessageSender | undefined): string | null;
  httpRefusal(url: string): string | null;
  webSocketRefusal(url: string): string | null;
  responseHeadersFor(response: Response): readonly HeaderPair[];
  base64Chunks(bytes: Uint8Array): readonly string[];
  bytesToBase64(bytes: Uint8Array): string;
  // Uint8Array<ArrayBuffer>, not plain Uint8Array: the caller transfers `.buffer` to the page,
  // and on a plain Uint8Array that property is the useless ArrayBufferLike.
  base64ToBytes(b64: string): Uint8Array<ArrayBuffer>;
  // --- the parse-boundary primitives. Nothing else in the extension may look at a raw port or
  // page message: these five are the only place an `unknown` off the wire is narrowed.
  asRecord(value: unknown): WireRecord | null;
  asWireMessage(value: unknown): WireMessage | null;
  toHeaderPairs(value: unknown): readonly HeaderPair[];
  toStringArray(value: unknown): readonly string[];
  assertNever(value: never): never;
}

// `var`, not `const`: wire.ts assigns it through `global.NanoboxProxyWire = …`, and only a `var`
// declaration puts the name on `typeof globalThis`.
declare var NanoboxProxyWire: NanoboxProxyWireApi;

// Service-worker-only global (background.js). lib.dom.d.ts has no declaration for it, and the
// service worker lib cannot be used here — see the note in ../../tsconfig.json.
declare function importScripts(...urls: readonly string[]): void;
