// nanobox proxy — background service worker (MIT License, see README.md)
//
// It is a BROKER, not the transport. All it does is: check that the port's sender is an allow-listed
// page origin, make sure the offscreen document exists, and relay messages between the content
// script's port and an offscreen port for the same session. The fetches and the WebSockets live in
// the offscreen document because this worker is not allowed to live long enough to own them:
//
//   "Normally, Chrome terminates a service worker when one of the following conditions is met:
//    - After 30 seconds of inactivity. Receiving an event or calling an extension API resets this
//      timer. - When a single request, such as an event or API call, takes longer than 5 minutes to
//    process. - When a fetch() response takes more than 30 seconds to arrive."
//   https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
//
// Relaying resets the idle timer by itself, and the content script also sends {type:"keepalive"}
// every 20 s while anything is in flight (swallowed here — its only job is being received). Note
// that "Opening a port no longer resets the timers" since Chrome 114, so an IDLE port is not a
// keep-alive. If this worker is terminated anyway, both ports die, the content script reconnects
// with the same session id and the offscreen document replays what the page had not acknowledged.
"use strict";

importScripts("wire.js");

(function () {
  const wire = NanoboxProxyWire;
  // createDocument() resolves when the document exists, but its runtime.onConnect listener is
  // registered by a <script> that may not have run yet, so the first connect can find no receiver.
  const CONNECT_ATTEMPTS = 5;
  const CONNECT_RETRY_MS = 50;

  let creatingOffscreenDocument: Promise<void> | null = null;

  chrome.runtime.onConnect.addListener((port) => {
    // the other direction (this worker -> the offscreen document) is handled by offscreen.js
    if (typeof port.name !== "string" || !port.name.startsWith(wire.PAGE_PORT_PREFIX)) return;
    if (!wire.isAllowedPageOrigin(wire.pageOriginOf(port.sender))) { port.disconnect(); return; }
    broker({ pagePort: port, sessionId: port.name.slice(wire.PAGE_PORT_PREFIX.length) });
  });

  function broker({ pagePort, sessionId }: { pagePort: chrome.runtime.Port; sessionId: string }): void {
    const queuedFromPage: unknown[] = [];
    let offscreenPort: chrome.runtime.Port | null = null;
    let pageGone = false;

    pagePort.onMessage.addListener((message: unknown) => {
      if (isKeepalive(message)) return;   // receiving it is the whole point
      if (!offscreenPort) { queuedFromPage.push(message); return; }
      relay(offscreenPort, message);
    });
    // Reading "my page port disconnected" as "the page is gone" is safe BECAUSE this handler running
    // at all proves this worker is alive: a terminated service worker runs no listener, so the content
    // script's reconnect — not this branch — is what a termination looks like from here.
    pagePort.onDisconnect.addListener(() => {
      pageGone = true;
      if (!offscreenPort) return;
      // The PAGE went away (closed / navigated), not this worker. Nothing will ever resume this
      // session, so the offscreen document must drop it now instead of holding its sockets open for
      // the grace period that exists for the service-worker-was-terminated case. The offscreen side
      // closes the port once it has done that — disconnecting here would race its own message.
      relay(offscreenPort, sessionGone());
    });

    connectOffscreen(sessionId).then((port) => {
      if (pageGone) { relay(port, sessionGone()); port.disconnect(); return; }
      offscreenPort = port;
      port.onMessage.addListener((message: unknown) => relay(pagePort, message));
      port.onDisconnect.addListener(() => { if (!pageGone) pagePort.disconnect(); });
      for (const message of queuedFromPage.splice(0)) relay(port, message);
    }, (error: unknown) => {
      relay(pagePort, brokerFailure("nanobox proxy: offscreen document unavailable (" + describe(error) + ")"));
      pagePort.disconnect();
    });
  }

  // The ONE question this file asks about a message. The broker is deliberately opaque — a protocol
  // addition must need no change here — so everything else is forwarded as the `unknown` it arrived
  // as, and this is a parse-boundary guard on an untrusted value rather than a branch on the closed
  // PortLegUpstream union (which is why it may compare a string without an assertNever arm).
  function isKeepalive(message: unknown): boolean {
    const parsed = wire.asWireMessage(message);
    return parsed !== null && parsed.type === "keepalive";
  }

  function sessionGone(): PortLegUpstream { return { type: "session-gone" }; }

  function brokerFailure(message: string): BrokerFailure { return { type: "error", fatal: true, message }; }

  // postMessage on a port whose other end is already gone throws; that is a normal race here (the
  // page navigated while a chunk was in flight), not an error worth propagating.
  function relay(port: chrome.runtime.Port, message: unknown): void {
    try { port.postMessage(message); } catch { /* the far end disconnected */ }
  }

  async function connectOffscreen(sessionId: string): Promise<chrome.runtime.Port> {
    await ensureOffscreenDocument();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      try { return await connectAndWaitForReady(wire.OFFSCREEN_PORT_PREFIX + sessionId); }
      catch (error) { lastError = error; await delay(CONNECT_RETRY_MS); }
    }
    throw lastError instanceof Error ? lastError : new Error("could not reach the offscreen document");
  }

  // Resolves on the offscreen document's "offscreen-ready" reply, rejects when the port disconnects
  // because nothing was listening — so there is no fixed timeout to tune.
  function connectAndWaitForReady(name: string): Promise<chrome.runtime.Port> {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name });
      const onReady = (message: unknown): void => { if (wire.asWireMessage(message)?.type !== "offscreen-ready") return; stopWaiting(); resolve(port); };
      const onGone = (): void => { stopWaiting(); reject(new Error(chrome.runtime.lastError?.message ?? "no offscreen listener")); };
      const stopWaiting = (): void => { port.onMessage.removeListener(onReady); port.onDisconnect.removeListener(onGone); };
      port.onMessage.addListener(onReady);
      port.onDisconnect.addListener(onGone);
    });
  }

  async function ensureOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    // "an installed extension can only have one open at a time", so concurrent brokers must not race
    // into two createDocument calls — and the loser of a race Chrome resolved differently is fine too.
    if (!creatingOffscreenDocument) {
      creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: "offscreen.html",
        // The document really does spawn a worker (offscreen-codec.js, which base64-frames the response
        // bodies off its main thread). There is no "long-lived fetch" reason in the API.
        reasons: ["WORKERS"],
        justification: "Owns the extension's cross-origin fetches and tunnelled WebSockets, whose lifetimes exceed a service worker's, and base64-frames their bodies in a worker.",
      }).finally(() => { creatingOffscreenDocument = null; });
    }
    try { await creatingOffscreenDocument; }
    catch (error) { if (!await chrome.offscreen.hasDocument()) throw error; }
  }

  function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    const parsed = wire.asWireMessage(error);
    const message = parsed === null ? undefined : parsed["message"];
    return typeof message === "string" && message ? message : String(error);
  }

  function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();
