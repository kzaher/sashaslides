#!/usr/bin/env node
// Unit test of the whole nanobox proxy egress chain, with only the three things a browser would
// provide stubbed out: chrome.runtime / chrome.offscreen, the offscreen document's fetch, and its
// WebSocket. Everything in between is the REAL code:
//
//   web/netpolicy.js + web/proxyext.js   (page)      -- window.postMessage -->
//   extension/wire.js + content.js       (content)   -- chrome.runtime.Port -->
//   extension/wire.js + background.js    (worker)    -- chrome.runtime.Port -->
//   extension/wire.js + offscreen.js     (offscreen) -- fetch / WebSocket   --> the stub
//
// Each file is loaded with `new Function`, so its top-level declarations land in their own scope
// (that is what makes "the service worker was terminated and respawned" expressible: the background
// source is simply re-run, while the offscreen scope keeps running). Intrinsics are shared with this
// realm on purpose — a vm context would give each side its own ArrayBuffer and every `instanceof`
// in the production code would be wrong for reasons the browser does not have.
//
// The two fidelity rules the stubs enforce, because they are what the design hinges on:
//   * the Port leg is JSON-ONLY: every port message is JSON.parse(JSON.stringify(...))'d, so sending
//     binary over it fails here exactly as it silently would in Chrome;
//   * the page leg structured-CLONES, so neither side can accidentally share a mutable object.
//
//   node test/proxyext-unit.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_ORIGIN = "http://localhost:8093";
const FORBIDDEN_REQUEST_HEADERS = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via"]);
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

let bad = 0;
const check = (ok, what, detail) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`); if (!ok) bad++; };
const flush = async (rounds = 12) => { for (let round = 0; round < rounds; round++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// 1. the routing policy: what goes where, with and without the extension
{
  console.log("\n=== routing policy (web/proxyext.js route)");
  const world = makeWorld();
  const { NanoboxProxy } = world.page;
  check(NanoboxProxy.route(PAGE_ORIGIN + "/vm.html") === "direct", "same-origin is never proxied");
  check(NanoboxProxy.route("data:text/plain,x") === "direct", "non-http(s) is never proxied");
  check(NanoboxProxy.route("http://169.254.169.254/latest") === "blocked", "the cloud metadata endpoint is blocked");
  check(NanoboxProxy.route(ANTHROPIC, { extension: false }) === "relay", "without the extension a PROXY_HOSTS vendor takes the relay");
  check(NanoboxProxy.route("https://registry.npmjs.org/node", { extension: false }) === "direct", "without the extension a CORS-friendly host is fetched directly");
  check(NanoboxProxy.route(ANTHROPIC, { extension: true }) === "extension", "with the extension a PROXY_HOSTS vendor takes the extension");
  check(NanoboxProxy.route("https://registry.npmjs.org/node", { extension: true }) === "extension", "with the extension EVERY cross-origin host takes the extension (POLICY)");
  check(NanoboxProxy.route("https://registry.npmjs.org/node", { extension: true, preferDirect: true }) === "direct", "preferDirect opts a CORS-friendly host out of the extension");
  check(NanoboxProxy.route(ANTHROPIC, { extension: true, preferDirect: true }) === "extension", "preferDirect cannot send a no-CORS vendor to a direct fetch");
  check(typeof NanoboxProxy.POLICY === "string" && NanoboxProxy.POLICY.length > 40, "the policy is documented on the object", NanoboxProxy.POLICY.slice(0, 48) + "…");
}

// 2. detect(): the version handshake refuses to speak to an older extension
{
  console.log("\n=== detect() version handshake");
  const world = makeWorld();
  const detected = world.page.NanoboxProxy.detect(50);
  check(await detected === true, "a v2 content script is detected");
  check(world.page.NanoboxProxy.features.includes("stream") && world.page.NanoboxProxy.features.includes("websocket"), "it advertises stream + websocket", world.page.NanoboxProxy.features.join(","));

  const stale = makeWorld({ withContentScript: false });
  const staleDetect = stale.page.NanoboxProxy.detect(60);
  stale.windowBus.postFrom({ type: "nanobox-proxy-hello", version: 1 });
  check(await staleDetect === false, "a v1 (pre-streaming) extension is NOT detected, so the page falls back to the relay");
}

// 3. a streamed response: the page gets the head immediately and each chunk as it arrives
{
  console.log("\n=== streamed response body");
  const world = makeWorld();
  world.page.NanoboxProxy.detected = true;
  const upstream = world.offscreen.nextFetch();
  const pending = world.page.NanoboxProxy.fetch({
    url: ANTHROPIC, method: "POST",
    // Origin/Host/Referer/Cookie are forbidden request-header names: the extension cannot send them
    headers: { authorization: "Bearer k", "content-type": "application/json", origin: "https://example.invalid", cookie: "a=b" },
    body: new TextEncoder().encode('{"stream":true}'),
  });
  const call = await upstream;
  check(call.url === ANTHROPIC && call.init.method === "POST", "the offscreen document fetched the target", call.init.method + " " + call.url);
  check(call.init.credentials === "omit" && call.init.cache === "no-store" && call.init.redirect === "follow", "credentials:omit / no-store / follow are the extension's policy");
  check(new TextDecoder().decode(call.body) === '{"stream":true}', "the request body arrived byte for byte");
  check(call.init.headers.get("authorization") === "Bearer k", "a normal header survives");
  check(!call.init.headers.has("origin") && !call.init.headers.has("cookie"), "the forbidden headers were not sent");

  call.respond({ status: 200, statusText: "OK", headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } });
  const response = await pending;
  check(response.status === 200 && response.ok, "the page resolved at the HEAD, before the body closed", "status " + response.status);
  check(response.headers.get("content-type") === "text/event-stream", "response headers reached the page");
  check(!response.headers.has("content-encoding"), "the transport header content-encoding was stripped");
  check(response.dropped.includes("origin") && response.dropped.includes("cookie"), "the page is TOLD which headers were dropped", response.dropped.join(","));

  const reader = response.body.getReader();
  call.push(new TextEncoder().encode("data: one\n\n"));
  const first = await reader.read();
  check(!first.done && new TextDecoder().decode(first.value) === "data: one\n\n", "the first SSE event is readable while the response is still open");
  call.push(new TextEncoder().encode("data: two\n\n"));
  call.close();
  let rest = "";
  for (;;) { const read = await reader.read(); if (read.done) break; rest += new TextDecoder().decode(read.value); }
  check(rest === "data: two\n\n", "the remaining events arrive and the stream closes", JSON.stringify(rest));
  check(world.ports.nonJsonAttempts.length === 0, "nothing tried to put binary on the JSON-only port leg", world.ports.nonJsonAttempts.join(","));
  check(world.ports.sentByContent.filter((message) => message.type === "ack").length > 0, "the content script acknowledged what it delivered (backpressure window)");
}

// 4. a body larger than the backpressure window: the offscreen document parks its reader until the
// page acks, and the ack trigger has to be in BYTES or this deadlocks on the third 4 MiB chunk
{
  console.log("\n=== a body larger than the 8 MiB backpressure window");
  const world = makeWorld();
  const upstream = world.offscreen.nextFetch();
  const pending = world.page.NanoboxProxy.fetch({ url: "https://downloads.claude.ai/big", method: "GET" });
  const call = await upstream;
  call.respond({ status: 200, statusText: "OK", headers: {} });
  const response = await pending;
  const pieces = 3;
  const pieceBytes = 4 * 1024 * 1024;
  for (let piece = 0; piece < pieces; piece++) call.push(new Uint8Array(pieceBytes).fill(piece + 1));
  call.close();
  const settled = await Promise.race([
    response.arrayBuffer().then((buffer) => ({ bytes: buffer.byteLength })),
    new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 8000)),
  ]);
  check(settled.bytes === pieces * pieceBytes, `all ${pieces * pieceBytes} bytes crossed a window of ${8 * 1024 * 1024}`, settled.stalled ? "STALLED — the ack trigger is not byte-based" : String(settled.bytes));
}

// 5. the service worker is terminated MID-STREAM: the offscreen document keeps the fetch and replays
{
  console.log("\n=== service-worker termination mid-stream");
  const world = makeWorld();
  world.page.NanoboxProxy.detected = true;
  const upstream = world.offscreen.nextFetch();
  const pending = world.page.NanoboxProxy.fetch({ url: ANTHROPIC, method: "GET" });
  const call = await upstream;
  call.respond({ status: 200, statusText: "OK", headers: {} });
  const response = await pending;
  const reader = response.body.getReader();
  call.push(new TextEncoder().encode("before "));
  const before = await reader.read();

  const fetchesBefore = world.offscreen.fetchCalls.length;
  world.ports.terminateServiceWorker();
  await flush();
  check(world.ports.backgroundRespawns === 1, "the content script reconnected, which respawned the service worker", String(world.ports.backgroundRespawns));
  check(world.offscreen.fetchCalls.length === fetchesBefore, "the upstream fetch was NOT restarted", `${world.offscreen.fetchCalls.length} fetch(es) in total`);
  check(!call.signal.aborted, "and it was not aborted either");

  call.push(new TextEncoder().encode("after"));
  call.close();
  let text = new TextDecoder().decode(before.value);
  for (;;) { const read = await reader.read(); if (read.done) break; text += new TextDecoder().decode(read.value); }
  check(text === "before after", "the body spans the termination without a gap or a duplicate", JSON.stringify(text));
}

// 6. the PAGE goes away: the offscreen document must drop the session at once, not after the grace
{
  console.log("\n=== page gone");
  const world = makeWorld();
  world.page.NanoboxProxy.detected = true;
  const upstream = world.offscreen.nextFetch();
  world.page.NanoboxProxy.fetch({ url: ANTHROPIC, method: "GET" }).catch(() => {});
  const call = await upstream;
  call.respond({ status: 200, statusText: "OK", headers: {} });
  await flush();
  world.ports.closePageSide();
  await flush();
  check(call.signal.aborted, "the in-flight upstream fetch was aborted");
}

// 7. the WebSocket tunnel
{
  console.log("\n=== WebSocket tunnel");
  const world = makeWorld();
  world.page.NanoboxProxy.detected = true;
  const socket = new world.page.NanoboxProxy.WebSocket("wss://chatgpt.com/backend-api/codex/ws", ["codex.v1"]);
  check(socket.readyState === 0, "a fresh socket is CONNECTING");
  await flush();
  const server = world.offscreen.sockets[0];
  check(!!server && server.url === "wss://chatgpt.com/backend-api/codex/ws", "the offscreen document opened the real socket", server && server.url);
  check(!!server && JSON.stringify(server.protocols) === '["codex.v1"]', "subprotocols were forwarded", server && JSON.stringify(server.protocols));

  const events = [];
  socket.onmessage = (event) => events.push(event.data);
  const opened = new Promise((resolve) => socket.addEventListener("open", resolve));
  server.simulateOpen({ protocol: "codex.v1" });
  await opened;
  check(socket.readyState === 1 && socket.protocol === "codex.v1", "the page sees OPEN and the negotiated subprotocol");

  socket.send("hello");
  socket.send(new TextEncoder().encode("bin"));
  await flush();
  check(server.sent.length === 2 && server.sent[0] === "hello", "a text frame reached the socket", JSON.stringify(server.sent[0]));
  check(typeof server.sent[1] !== "string" && new TextDecoder().decode(server.sent[1]) === "bin", "a binary frame reached the socket intact");

  server.simulateMessage("pong");
  server.simulateMessage(new TextEncoder().encode("blob").buffer);
  await flush();
  check(events.length === 2 && events[0] === "pong", "a text frame reached the page", JSON.stringify(events[0]));
  check(events[1] instanceof ArrayBuffer && new TextDecoder().decode(events[1]) === "blob", "a binary frame reached the page as an ArrayBuffer");

  const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
  server.simulateClose({ code: 1000, reason: "bye", wasClean: true });
  const closeEvent = await closed;
  check(socket.readyState === 3 && closeEvent.code === 1000 && closeEvent.reason === "bye", "the close frame reached the page", `${closeEvent.code} ${closeEvent.reason}`);

  const refused = new world.page.NanoboxProxy.WebSocket("ws://169.254.169.254/");
  const refusedClose = await new Promise((resolve) => refused.addEventListener("close", resolve));
  check(refusedClose.code === 1006 && /blocked/.test(refusedClose.reason), "a blocked host is refused by the extension, not just by route()", refusedClose.reason);
  check(world.offscreen.sockets.length === 1, "and no socket was opened for it");
}

// 8. workerFetch: the drop-in fetch override, on the extension route
{
  console.log("\n=== workerFetch on the extension route");
  const world = makeWorld();
  const upstream = world.offscreen.nextFetch();
  const pending = world.page.NanoboxProxy.workerFetch(world.page.failingFetch, ANTHROPIC, { method: "POST", body: "ping" }, { extension: true });
  const call = await upstream;
  check(new TextDecoder().decode(call.body) === "ping", "a string body was normalised through Request");
  check(call.init.headers.get("content-type") === "text/plain;charset=UTF-8", "and its implicit content-type survived", call.init.headers.get("content-type"));
  call.respond({ status: 201, statusText: "Created", headers: { "x-request-id": "abc" } });
  call.push(new TextEncoder().encode("pong"));
  call.close();
  const response = await pending;
  check(response instanceof Response && response.status === 201, "a real Response came back", String(response.status));
  check(response.headers.get("x-request-id") === "abc", "a non-CORS-safelisted header is visible to the caller (the reason for the POLICY)");
  check(await response.text() === "pong", "and its body is the streamed payload");
}

// 9. the offscreen document is created once, with the reason the manifest declares
{
  console.log("\n=== offscreen document contract");
  const world = makeWorld();
  const first = world.offscreen.nextFetch();
  world.page.NanoboxProxy.fetch({ url: ANTHROPIC, method: "GET" }).catch(() => {});
  const call = await first;
  call.respond({ status: 200, statusText: "OK", headers: {} });
  call.push(new TextEncoder().encode("body"));
  call.close();
  await flush();
  const second = world.offscreen.nextFetch();
  world.page.NanoboxProxy.fetch({ url: "https://registry.npmjs.org/node", method: "GET" }).catch(() => {});
  await second;
  check(world.offscreen.creations.length === 1, "two requests share one offscreen document", String(world.offscreen.creations.length));
  const creation = world.offscreen.creations[0];
  check(creation.url === "offscreen.html", "created from offscreen.html", creation.url);
  check(JSON.stringify(creation.reasons) === '["WORKERS"]', "reason WORKERS (it really does spawn offscreen-codec.js)", JSON.stringify(creation.reasons));
  check(typeof creation.justification === "string" && creation.justification.length > 40, "with a justification", creation.justification.slice(0, 40) + "…");
  check(world.offscreen.codecWorkerUrls.length === 1 && world.offscreen.codecWorkerUrls[0] === "offscreen-codec.js", "and it spawned exactly that worker", world.offscreen.codecWorkerUrls.join(","));
  check(world.offscreen.codecEncodes > 0, "the response bodies were base64-framed by the worker, not on the document's main thread", String(world.offscreen.codecEncodes));
}

console.log(bad ? `\nFAILED (${bad})` : "\nALL OK");
process.exit(bad ? 1 : 0);

// --- the world: one page, one content script, one service worker, one offscreen document

function makeWorld({ withContentScript = true } = {}) {
  const windowBus = makeWindowBus();
  const offscreen = makeOffscreenHost();
  const ports = makePortRouter({ offscreen });
  const page = loadPage({ windowBus });
  if (withContentScript) loadContentScript({ windowBus, ports });
  return { windowBus, ports, offscreen, page };
}

// window.postMessage between the page and the content script's isolated world: structured clone,
// delivered to every listener on this window (including the sender's own, as in a browser).
function makeWindowBus() {
  const listeners = [];
  const post = (data, transfer) => {
    for (const transferable of transfer || []) if (!(transferable instanceof ArrayBuffer)) throw new TypeError("not transferable: " + typeof transferable);
    const snapshot = structuredClone(data);
    for (const entry of listeners) queueMicrotask(() => entry.handler({ source: entry.window, origin: PAGE_ORIGIN, data: structuredClone(snapshot) }));
  };
  return {
    post,
    postFrom: (data) => post(data, []),
    attach(fakeWindow) {
      fakeWindow.addEventListener = (type, handler) => { if (type === "message") listeners.push({ window: fakeWindow, handler }); };
      fakeWindow.removeEventListener = (type, handler) => { const at = listeners.findIndex((entry) => entry.handler === handler); if (at >= 0) listeners.splice(at, 1); };
      fakeWindow.postMessage = (data, _targetOrigin, transfer) => post(data, transfer);
    },
  };
}

function loadPage({ windowBus }) {
  const fakeWindow = { location: { href: PAGE_ORIGIN + "/vm.html", origin: PAGE_ORIGIN } };
  windowBus.attach(fakeWindow);
  fakeWindow.self = fakeWindow;
  runScript({ path: join(HERE, "../web/netpolicy.js"), params: { self: fakeWindow, window: fakeWindow, document: {} } });
  runScript({ path: join(HERE, "../web/proxyext.js"), params: { self: fakeWindow, window: fakeWindow, document: {}, location: fakeWindow.location } });
  // a fetch that must never be reached on the extension route
  fakeWindow.failingFetch = () => { throw new Error("workerFetch took the direct/relay path"); };
  return fakeWindow;
}

function loadContentScript({ windowBus, ports }) {
  const fakeWindow = { location: { href: PAGE_ORIGIN + "/vm.html", origin: PAGE_ORIGIN } };
  windowBus.attach(fakeWindow);
  const wire = loadWire();
  runScript({ path: join(HERE, "../extension/content.js"), params: { window: fakeWindow, location: fakeWindow.location, chrome: ports.chromeForContent(), NanoboxProxyWire: wire } });
  return fakeWindow;
}

// extension/wire.js, loaded fresh into its own scope (each extension context has its own copy)
function loadWire() {
  const host = {};
  runScript({ path: join(HERE, "../extension/wire.js"), params: { self: host } });
  return host.NanoboxProxyWire;
}

function runScript({ path, params }) {
  const names = Object.keys(params);
  // eslint-disable-next-line no-new-func -- loading a browser classic script into its own scope IS the test fixture
  new Function(...names, readFileSync(path, "utf8"))(...names.map((name) => params[name]));
}

// --- chrome.runtime: two port legs (content <-> worker, worker <-> offscreen) and a kill switch

function makePortRouter({ offscreen }) {
  const backgroundOnConnect = [];
  const contentEnds = new Set();       // the content script's end of each page leg
  const workerChannels = new Set();    // every channel the service-worker SCOPE owns an end of
  const router = {
    sentByContent: [],
    nonJsonAttempts: [],
    backgroundRespawns: 0,
    terminateServiceWorker,
    closePageSide: () => { for (const end of [...contentEnds]) end.disconnect(); },
    chromeForContent: () => ({ runtime: { connect: connectFromContent, onConnect: listenerBag([]), lastError: null } }),
  };

  function connectFromContent({ name }) {
    const channel = makeChannel({ name, sender: { origin: PAGE_ORIGIN }, router });
    const [contentEnd, workerEnd] = channel.ends;
    contentEnds.add(contentEnd);
    workerChannels.add({ channel, workerEndIndex: 1 });
    contentEnd.onPost = (message) => router.sentByContent.push(message);
    queueMicrotask(() => { for (const listener of [...backgroundOnConnect]) listener(workerEnd); });
    return contentEnd;
  }

  function connectFromBackground({ name }) {
    const channel = makeChannel({ name, sender: {}, router });
    const [workerEnd, offscreenEnd] = channel.ends;
    workerChannels.add({ channel, workerEndIndex: 0 });
    queueMicrotask(() => { for (const listener of [...offscreen.connectListeners]) listener(offscreenEnd); });
    return workerEnd;
  }

  // Everything a respawned worker must NOT remember: its scope, its listeners, its ports. Only the
  // PEER of each of its ends is notified — a terminated scope runs no onDisconnect handler, which is
  // exactly why background.js may read "my page port disconnected" as "the page went away". The
  // offscreen scope is deliberately untouched; that it survives this is the property under test.
  function terminateServiceWorker() {
    for (const { channel, workerEndIndex } of [...workerChannels]) channel.killOwnedBy(workerEndIndex);
    workerChannels.clear();
    backgroundOnConnect.length = 0;
    router.backgroundRespawns++;
    spawnBackground();
  }

  function spawnBackground() {
    runScript({
      path: join(HERE, "../extension/background.js"),
      params: {
        importScripts: () => {},
        NanoboxProxyWire: loadWire(),
        chrome: {
          runtime: { connect: connectFromBackground, onConnect: listenerBag(backgroundOnConnect), lastError: null },
          offscreen: offscreen.api,
        },
      },
    });
  }

  spawnBackground();
  return router;
}

// a function declaration, not a const: the tests above run at module top level, before a
// `const` further down this file would have left its TDZ
function listenerBag(bag) {
  return { addListener: (listener) => bag.push(listener), removeListener: (listener) => { const at = bag.indexOf(listener); if (at >= 0) bag.splice(at, 1); } };
}

// One chrome.runtime channel, two ends. Messages are JSON-round-tripped, which is what makes the
// "the port leg is JSON-only, an ArrayBuffer arrives as {}" constraint real instead of a comment.
// disconnect() notifies the PEER only (Chrome's semantics); kill() takes the whole channel down,
// which is what the death of an owning context looks like.
function makeChannel({ name, sender, router }) {
  let up = true;
  const ends = [makeEnd(0), makeEnd(1)];

  function makeEnd(index) {
    const messageListeners = [];
    const disconnectListeners = [];
    const end = {
      name, sender, messageListeners, disconnectListeners, onPost: null,
      onMessage: listenerBag(messageListeners),
      onDisconnect: listenerBag(disconnectListeners),
      postMessage(message) {
        if (!up) throw new Error("Attempting to use a disconnected port object");
        if (end.onPost) end.onPost(message);
        const onWire = JSON.parse(JSON.stringify(message));
        if (JSON.stringify(onWire) !== JSON.stringify(message)) router.nonJsonAttempts.push(String(message && message.type));
        // delivered even if this end disconnects before the microtask runs: Chrome keeps a channel's
        // postMessage/disconnect in order, and the code under test is allowed to rely on that
        queueMicrotask(() => { for (const listener of [...ends[1 - index].messageListeners]) listener(onWire); });
      },
      disconnect() { if (!up) return; up = false; notify(ends[1 - index]); },
    };
    return end;
  }

  function notify(end) { for (const listener of [...end.disconnectListeners]) listener(end); }

  // The scope holding ends[index] died: its own listeners are gone with it, only the peer learns.
  return { ends, killOwnedBy: (index) => { if (!up) return; up = false; notify(ends[1 - index]); } };
}

// --- the offscreen document: chrome.offscreen plus the fetch / WebSocket / Worker it is given

function makeOffscreenHost() {
  const host = {
    creations: [],
    fetchCalls: [],
    sockets: [],
    codecWorkerUrls: [],
    codecEncodes: 0,
    connectListeners: [],
    nextFetch,
    api: {
      hasDocument: async () => loaded,
      createDocument: async (options) => { host.creations.push(options); load(); },
    },
  };
  let loaded = false;
  let waitingForFetch = null;

  function nextFetch() { return new Promise((resolve) => { waitingForFetch = resolve; }); }

  function load() {
    if (loaded) return;
    loaded = true;
    runScript({
      path: join(HERE, "../extension/offscreen.js"),
      params: {
        NanoboxProxyWire: loadWire(),
        chrome: { runtime: { onConnect: listenerBag(host.connectListeners), lastError: null } },
        fetch: stubFetch,
        Headers: BrowserHeaders,
        WebSocket: StubWebSocket,
        Worker: StubCodecWorker,
      },
    });
  }

  // The real fetch's contract, reduced to what the offscreen document uses: a Response whose body is
  // a ReadableStream the test fills by hand, so "the head arrived but the body is still open" — the
  // whole reason this redesign exists — is directly expressible.
  async function stubFetch(url, init) {
    let sink = null;
    const body = new ReadableStream({ start: (controller) => { sink = controller; } });
    const call = {
      url: String(url), init, signal: init.signal,
      body: init.body ? new Uint8Array(init.body) : null,
      respond: ({ status, statusText, headers }) => call.settle(new Response(body, { status, statusText, headers })),
      push: (bytes) => sink.enqueue(bytes),
      close: () => sink.close(),
      settle: null, abandon: null,
    };
    host.fetchCalls.push(call);
    init.signal.addEventListener("abort", () => {
      try { sink.error(new Error("aborted")); } catch { /* already closed */ }
      call.abandon(new DOMException("aborted", "AbortError"));
    });
    const response = new Promise((resolve, reject) => { call.settle = resolve; call.abandon = reject; });
    response.catch(() => {});   // the rejection is observed by the code under test, not here
    if (waitingForFetch) { const resolve = waitingForFetch; waitingForFetch = null; resolve(call); }
    return response;
  }

  function StubWebSocket(url, protocols) {
    const socket = this;
    socket.url = String(url);
    socket.protocols = protocols === undefined ? [] : protocols;
    socket.sent = [];
    socket.binaryType = "blob";
    socket.send = (data) => socket.sent.push(data);
    socket.close = (code, reason) => socket.simulateClose({ code, reason, wasClean: true });
    socket.simulateOpen = ({ protocol }) => { socket.protocol = protocol; if (socket.onopen) socket.onopen(); };
    socket.simulateMessage = (data) => { if (socket.onmessage) socket.onmessage({ data }); };
    socket.simulateClose = (event) => { if (socket.onclose) socket.onclose(event); };
    host.sockets.push(socket);
  }

  // Node's Headers accepts everything; a browser's refuses the Fetch spec's forbidden request-header
  // names with a silent no-op, and detecting that is the point of offscreen.js requestHeaders().
  // https://fetch.spec.whatwg.org/#forbidden-request-header
  function BrowserHeaders(init) {
    const headers = new Headers(init);
    const append = headers.append.bind(headers);
    headers.append = (name, value) => { if (FORBIDDEN_REQUEST_HEADERS.has(String(name).toLowerCase())) return; append(name, value); };
    return headers;
  }

  // Stands in for offscreen-codec.js, which cannot be loaded as a real Worker from here. Answers in
  // arrival order, which is the property the real one relies on to keep the chunks ordered.
  function StubCodecWorker(url) {
    const worker = this;
    host.codecWorkerUrls.push(String(url));
    worker.postMessage = (data) => queueMicrotask(() => {
      host.codecEncodes++;
      if (worker.onmessage) worker.onmessage({ data: { ticket: data.ticket, b64: Buffer.from(data.bytes).toString("base64") } });
    });
  }

  return host;
}
