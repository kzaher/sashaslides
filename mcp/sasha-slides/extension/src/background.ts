// The service worker. It is a BROKER and nothing else: it checks that a connecting port really is a
// Google Slides tab, makes sure the offscreen document exists, and relays messages between the
// content script's port and an offscreen port for the same session.
//
// Nothing stateful lives here because nothing is ALLOWED to. Chrome's documented rules
// (https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle):
// terminated after 30 s of inactivity, after 5 minutes on a single request, and after 30 s waiting
// for a fetch response -- and since Chrome 114, "Opening a port no longer resets the timers", so a
// quiet port is not a keep-alive either. A Drive poll loop with a 5 s cadence, a cached access
// token and a picker the user reads for a minute would all be cut in half. The offscreen document
// has no lifetime cap, so it owns all of that, and this worker may be terminated between any two
// messages without losing anything: the content script simply reconnects.

import { CONTENT_PORT_PREFIX, OFFSCREEN_PORT_PREFIX, asWireMessage, presentationIdOf } from "./wire.ts";

const OFFSCREEN_DOCUMENT_URL = "offscreen.html";
// createDocument() resolves once the document exists, but its runtime.onConnect listener is
// registered by a <script> that may not have run yet, so the first connect can find no receiver.
const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_MS = 50;

let creatingOffscreenDocument: Promise<void> | null = null;

chrome.runtime.onConnect.addListener((port) => {
  // The other direction (this worker -> the offscreen document) is handled in offscreen.ts.
  if (!port.name.startsWith(CONTENT_PORT_PREFIX)) return;
  if (!isSlidesSender(port.sender)) {
    port.disconnect();
    return;
  }
  broker({ contentPort: port, sessionId: port.name.slice(CONTENT_PORT_PREFIX.length) });
});

function broker({ contentPort, sessionId }: { contentPort: chrome.runtime.Port; sessionId: string }): void {
  const queuedFromContent: unknown[] = [];
  let offscreenPort: chrome.runtime.Port | null = null;
  let tabGone = false;

  contentPort.onMessage.addListener((message: unknown) => {
    if (offscreenPort === null) {
      queuedFromContent.push(message);
      return;
    }
    relay(offscreenPort, message);
  });
  // Reading "my content port disconnected" as "the tab is gone" is safe BECAUSE this handler
  // running at all proves this worker is alive: a terminated service worker runs no listener, so a
  // termination looks like the content script reconnecting, not like this branch.
  contentPort.onDisconnect.addListener(() => {
    tabGone = true;
    if (offscreenPort === null) return;
    offscreenPort.disconnect();
  });

  connectOffscreen(sessionId).then(
    (port) => {
      if (tabGone) {
        port.disconnect();
        return;
      }
      offscreenPort = port;
      port.onMessage.addListener((message: unknown) => relay(contentPort, message));
      port.onDisconnect.addListener(() => {
        if (!tabGone) contentPort.disconnect();
      });
      for (const message of queuedFromContent.splice(0)) relay(port, message);
    },
    (error: unknown) => {
      relay(contentPort, { type: "broker-failed", message: `offscreen document unavailable (${describe(error)})` });
      contentPort.disconnect();
    },
  );
}

/**
 * The port's sender must be a Google Slides editor tab. `manifest.content_scripts.matches` already
 * restricts injection, but a port's name is attacker-controlled, so the sender is re-checked here --
 * same belt-and-braces as nanobox's origin allow-list.
 */
function isSlidesSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (sender === undefined) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url;
  return typeof url === "string" && presentationIdOf(url) !== null;
}

// postMessage on a port whose far end is already gone throws; that is a normal race here (the tab
// navigated while a message was in flight), not an error worth propagating.
function relay(port: chrome.runtime.Port, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    /* the far end disconnected */
  }
}

async function connectOffscreen(sessionId: string): Promise<chrome.runtime.Port> {
  await ensureOffscreenDocument();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      return await connectAndWaitForReady(OFFSCREEN_PORT_PREFIX + sessionId);
    } catch (error) {
      lastError = error;
      await delay(CONNECT_RETRY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("could not reach the offscreen document");
}

// Resolves on the offscreen document's "offscreen-ready" reply and rejects when the port
// disconnects because nothing was listening -- so there is no fixed timeout to tune.
function connectAndWaitForReady(name: string): Promise<chrome.runtime.Port> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name });
    const stopWaiting = (): void => {
      port.onMessage.removeListener(onReady);
      port.onDisconnect.removeListener(onGone);
    };
    function onReady(message: unknown): void {
      if (asWireMessage(message)?.["type"] !== "offscreen-ready") return;
      stopWaiting();
      resolve(port);
    }
    function onGone(): void {
      stopWaiting();
      reject(new Error(chrome.runtime.lastError?.message ?? "no offscreen listener"));
    }
    port.onMessage.addListener(onReady);
    port.onDisconnect.addListener(onGone);
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  // "an installed extension can only have one open at a time", so concurrent brokers must not race
  // into two createDocument calls.
  if (creatingOffscreenDocument === null) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_URL,
        // DOM_PARSER is declared because the document really does use DOMParser: it checks every
        // candidate HTML against PROTOCOL.md's "self-contained 1280x720 document" invariant before
        // the picker shows it, which a service worker cannot do. Stated honestly, though: the
        // REASON the document exists is that it owns a 5 s poll timer and a cached OAuth token,
        // and there is no offscreen reason for "needs a timer that outlives 30 s".
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification:
          "Owns the Drive poll loop and the OAuth token, whose lifetimes exceed a service worker's, and parses each candidate slide's HTML to validate it before it is shown.",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }
  try {
    await creatingOffscreenDocument;
  } catch (error) {
    if (!(await chrome.offscreen.hasDocument())) throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
