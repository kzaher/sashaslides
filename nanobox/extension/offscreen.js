// GENERATED FILE — do not edit. Compiled from extension/src/offscreen.ts by build-proxy-extension.sh
// (tsc -p extension/tsconfig.json). Change the TypeScript source and rebuild; 'npm run typecheck' is the gate.
// nanobox proxy — the offscreen document (MIT License, see README.md)
//
// WHY THIS EXISTS. Chrome terminates an extension service worker "after 30 seconds of inactivity",
// "when a single request, such as an event or API call, takes longer than 5 minutes to process" and
// "when a fetch() response takes more than 30 seconds to arrive"
// (https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). An LLM
// SSE stream runs for minutes and can be silent for much longer than 30 s, so a fetch owned by the
// service worker is not survivable. An offscreen document has no such limit — "The AUDIO_PLAYBACK
// reason sets the document to close after 30 seconds without audio playing. All other reasons don't
// set lifetime limits." (https://developer.chrome.com/docs/extensions/reference/api/offscreen) — so
// every fetch and every WebSocket is owned HERE and the service worker only brokers messages.
//
// This document owns, per page session:
//   * the in-flight fetches (their AbortController and their body reader), and
//   * the tunnelled WebSockets,
// plus an OUTBOX of everything the page has not acknowledged yet. When the service worker is
// terminated mid-stream both ports die, the content script reconnects, the respawned worker connects
// here again with the same session id and the outbox is replayed from the page's last seq — so a
// terminated service worker costs a few milliseconds, not the stream.
"use strict";
(function () {
    const wire = NanoboxProxyWire;
    const sessions = new Map();
    chrome.runtime.onConnect.addListener((port) => {
        if (typeof port.name !== "string" || !port.name.startsWith(wire.OFFSCREEN_PORT_PREFIX))
            return;
        attach({ port, sessionId: port.name.slice(wire.OFFSCREEN_PORT_PREFIX.length) });
    });
    // Bind a (re)connected broker port to its session, reviving one that is still inside its grace
    // period. The "offscreen-ready" reply is what tells background.js the listener is live, so it does
    // not have to guess how long this document took to load.
    function attach({ port, sessionId }) {
        const session = sessions.get(sessionId) ?? newSession(sessionId);
        if (session.graceTimer !== null) {
            clearTimeout(session.graceTimer);
            session.graceTimer = null;
        }
        session.port = port;
        port.onMessage.addListener((message) => onSessionMessage(session, message));
        port.onDisconnect.addListener(() => detach(session));
        port.postMessage({ type: "offscreen-ready" });
    }
    function onSessionMessage(session, raw) {
        const message = parseUpstream(raw);
        if (message === null)
            return;
        switch (message.type) {
            // the content script's first message on every (re)connect: everything up to `ack` arrived
            case "hello":
                acknowledge(session, message.ack);
                replay(session);
                return;
            case "ack":
                acknowledge(session, message.seq);
                return;
            // the keepalive never travels further than the service worker it exists to poke
            case "keepalive": return;
            case "fetch-begin":
                session.requests.set(message.id, { url: message.url, method: message.method, headers: message.headers, bodyChunks: [], controller: new AbortController() });
                return;
            case "fetch-body": {
                const request = session.requests.get(message.id);
                if (request)
                    request.bodyChunks.push(message.b64);
                return;
            }
            case "fetch-end": {
                const request = session.requests.get(message.id);
                if (request)
                    void runFetch(session, message.id, request);
                return;
            }
            case "abort": {
                const request = session.requests.get(message.id);
                if (request) {
                    session.requests.delete(message.id);
                    request.controller.abort();
                }
                return;
            }
            case "ws-open":
                openSocket(session, message);
                return;
            case "ws-send":
                sendSocket(session, message);
                return;
            case "ws-close": {
                const socket = session.sockets.get(message.id);
                if (socket)
                    socket.close(message.code, message.reason);
                return;
            }
            // The PAGE is gone (not just the service worker): nothing will ever resume this session. This
            // side closes the port, so the broker never has to post-then-disconnect and depend on the two
            // surviving in order.
            case "session-gone": {
                const closing = session.port;
                destroy(session);
                if (closing)
                    closing.disconnect();
                return;
            }
            default: wire.assertNever(message);
        }
    }
    // --- fetch: streamed, so the page sees the first SSE event without waiting for the last one
    async function runFetch(session, id, request) {
        const refusal = wire.httpRefusal(request.url);
        if (refusal) {
            session.requests.delete(id);
            emit(session, { type: "error", id, message: refusal });
            return;
        }
        try {
            const { headers, dropped } = requestHeaders(request.headers);
            const hasBody = !["GET", "HEAD"].includes(request.method) && request.bodyChunks.length > 0;
            // credentials:"omit" is a POLICY, not a default: an extension with host_permissions is treated
            // as same-site by the target, so credentials:"include" would attach even SameSite=Strict cookies
            // (https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) and turn
            // this bridge into a confused deputy holding the user's whole cookie jar. redirect:"follow"
            // because redirect:"manual" only yields an opaqueredirect (status 0, no Location) in a browser.
            // `body` is spread in rather than set to undefined: exactOptionalPropertyTypes makes
            // `body: undefined` a different thing from "no body" for RequestInit.
            const response = await fetch(request.url, {
                method: request.method, headers, credentials: "omit", cache: "no-store", redirect: "follow",
                ...(hasBody ? { body: joinBase64(request.bodyChunks) } : {}),
                signal: request.controller.signal,
            });
            emit(session, { type: "head", id, status: response.status, statusText: response.statusText, headers: wire.responseHeadersFor(response), dropped });
            if (response.body)
                await pumpBody(session, id, response.body);
            emit(session, { type: "end", id });
        }
        catch (error) {
            emit(session, { type: "error", id, message: describe(error) });
        }
        finally {
            session.requests.delete(id);
        }
    }
    // `Origin`, `Host`, `Referer` and `Cookie` are forbidden request-header names: per the Fetch spec
    // (https://fetch.spec.whatwg.org/#forbidden-request-header) append() is a silent NO-OP for them even
    // from an extension context. Silently losing an auth-relevant header is worse than failing, so the
    // names that did not survive are reported to the page as `dropped` on the response head.
    function requestHeaders(pairs) {
        const headers = new Headers();
        const dropped = [];
        for (const [name, value] of pairs) {
            try {
                headers.append(name, value);
            }
            catch {
                dropped.push(name);
                continue;
            }
            if (!headers.has(name))
                dropped.push(name);
        }
        return { headers, dropped };
    }
    async function pumpBody(session, id, body) {
        const reader = body.getReader();
        try {
            for (;;) {
                const read = await reader.read();
                if (read.done)
                    return;
                await deliverBody(session, id, read.value);
            }
        }
        finally {
            // releases the socket on abort, on a destroyed session and on the happy path alike
            await reader.cancel().catch(() => { });
        }
    }
    async function deliverBody(session, id, bytes) {
        for (let offset = 0; offset < bytes.byteLength; offset += wire.CHUNK_BYTES) {
            const piece = bytes.slice(offset, offset + wire.CHUNK_BYTES);
            emit(session, { type: "chunk", id, b64: await codec.encode(piece) }, piece.byteLength);
            await drain(session);
        }
    }
    // --- WebSocket: a real socket to the destination, its frames piped over the port
    function openSocket(session, { id, url, protocols }) {
        const refusal = wire.webSocketRefusal(url);
        if (refusal) {
            emit(session, { type: "error", id, message: refusal });
            return;
        }
        let socket;
        try {
            socket = new WebSocket(url, protocols.length ? [...protocols] : undefined);
        }
        catch (error) {
            emit(session, { type: "error", id, message: describe(error) });
            return;
        }
        socket.binaryType = "arraybuffer";
        session.sockets.set(id, socket);
        socket.onopen = () => emit(session, { type: "ws-opened", id, protocol: socket.protocol || "", extensions: socket.extensions || "" });
        socket.onmessage = (event) => {
            if (typeof event.data === "string") {
                emit(session, { type: "ws-text", id, text: event.data }, event.data.length);
                return;
            }
            // binaryType is "arraybuffer" two lines above, so a non-string frame IS an ArrayBuffer
            const bytes = new Uint8Array(event.data);
            emit(session, { type: "ws-binary", id, b64: wire.bytesToBase64(bytes) }, bytes.byteLength);
        };
        socket.onclose = (event) => { session.sockets.delete(id); emit(session, { type: "ws-closed", id, code: event.code, reason: event.reason || "", wasClean: Boolean(event.wasClean) }); };
        // the close event carries the detail; `error` only says that something went wrong
        socket.onerror = () => emit(session, { type: "error", id, message: "websocket error" });
    }
    function sendSocket(session, message) {
        const socket = session.sockets.get(message.id);
        if (!socket) {
            emit(session, { type: "error", id: message.id, message: "no such socket" });
            return;
        }
        try {
            socket.send(message.text !== undefined ? message.text : wire.base64ToBytes(String(message.b64)));
        }
        catch (error) {
            emit(session, { type: "error", id: message.id, message: describe(error) });
        }
    }
    // --- session bookkeeping: sequence numbers, the replay outbox and backpressure
    function newSession(id) {
        const session = { id, port: null, nextSeq: 0, outbox: [], unackedBytes: 0, drainWaiters: [], requests: new Map(), sockets: new Map(), graceTimer: null };
        sessions.set(id, session);
        return session;
    }
    // Every downstream message is numbered and kept until the page acknowledges it, so a reconnect can
    // replay exactly the gap. `bytes` is the payload size that counts against the backpressure window.
    function emit(session, message, bytes = 0) {
        const numbered = { seq: ++session.nextSeq, ...message };
        session.outbox.push({ seq: numbered.seq, bytes, message: numbered });
        session.unackedBytes += bytes;
        if (!session.port)
            return;
        try {
            session.port.postMessage(numbered);
        }
        catch {
            session.port = null;
        }
    }
    function replay(session) {
        if (!session.port)
            return;
        for (const entry of session.outbox) {
            try {
                session.port.postMessage(entry.message);
            }
            catch {
                session.port = null;
                return;
            }
        }
    }
    function acknowledge(session, seq) {
        // `outbox[0]` is read into a local and tested for undefined rather than guarded by
        // `outbox.length > 0`: noUncheckedIndexedAccess types the element as possibly absent, and a
        // length check is a fact the compiler cannot connect to the index.
        for (;;) {
            const head = session.outbox[0];
            if (head === undefined || head.seq > seq)
                break;
            session.outbox.shift();
            session.unackedBytes -= head.bytes;
        }
        if (session.unackedBytes >= wire.HIGH_WATER_BYTES)
            return;
        for (const waiter of session.drainWaiters.splice(0))
            waiter.resolve();
    }
    // Stop reading the response body while the page is more than HIGH_WATER_BYTES behind: without this
    // a 250 MB download would be buffered in the extension instead of flowing through it.
    function drain(session) {
        if (session.unackedBytes < wire.HIGH_WATER_BYTES)
            return Promise.resolve();
        return new Promise((resolve, reject) => session.drainWaiters.push({ resolve, reject }));
    }
    // The broker port died. Either the service worker was terminated (the page will reconnect within
    // milliseconds) or the whole browser context is going away — both look identical from here, so the
    // fetches and sockets are kept for SESSION_GRACE_MS and only then dropped.
    function detach(session) {
        session.port = null;
        if (session.graceTimer !== null)
            clearTimeout(session.graceTimer);
        session.graceTimer = setTimeout(() => destroy(session), wire.SESSION_GRACE_MS);
    }
    function destroy(session) {
        if (session.graceTimer !== null) {
            clearTimeout(session.graceTimer);
            session.graceTimer = null;
        }
        sessions.delete(session.id);
        for (const request of session.requests.values())
            request.controller.abort();
        session.requests.clear();
        for (const socket of session.sockets.values()) {
            try {
                socket.close(1001, "nanobox proxy session gone");
            }
            catch { /* already closing */ }
        }
        session.sockets.clear();
        session.port = null;
        session.outbox.length = 0;
        for (const waiter of session.drainWaiters.splice(0))
            waiter.reject(new Error("nanobox proxy session gone"));
    }
    // --- base64 framing, off this document's main thread
    //
    // The port leg is JSON-only, so every body byte is base64-encoded here. For a 250 MB install that is
    // a lot of string building, and it must not block the event loop that is also pumping the SSE
    // streams and the sockets — hence a Worker, which is also the offscreen reason the manifest
    // declares ("WORKERS": "Specifies that the offscreen document needs to spawn workers").
    // Falls back to encoding inline where Worker is unavailable (the unit test's stub context).
    const codec = startCodec();
    function startCodec() {
        let worker = null;
        try {
            worker = new Worker("offscreen-codec.js");
        }
        catch {
            worker = null;
        }
        if (!worker)
            return { encode: (bytes) => Promise.resolve(wire.bytesToBase64(bytes)) };
        const spawned = worker;
        const waiters = new Map();
        let nextTicket = 0;
        spawned.onmessage = (event) => { const resolve = waiters.get(event.data.ticket); if (!resolve)
            return; waiters.delete(event.data.ticket); resolve(event.data.b64); };
        spawned.onerror = () => { for (const resolve of waiters.values())
            resolve(null); waiters.clear(); };
        return {
            encode: (bytes) => new Promise((resolve) => {
                const ticket = ++nextTicket;
                waiters.set(ticket, (b64) => resolve(b64 === null ? wire.bytesToBase64(bytes) : b64));
                // NOT transferred: the fallback above must still be able to read `bytes` if the worker dies
                spawned.postMessage({ ticket, bytes });
            }),
        };
    }
    // Uint8Array<ArrayBuffer>, not plain Uint8Array: lib.dom's BodyInit only accepts a view over a
    // real ArrayBuffer, so the looser ArrayBufferLike default cannot be a fetch() body.
    function joinBase64(chunks) {
        const parts = chunks.map(wire.base64ToBytes);
        const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
            joined.set(part, offset);
            offset += part.byteLength;
        }
        return joined;
    }
    // --- the parse boundary: the only function here that looks at a raw port message
    function parseUpstream(raw) {
        const message = wire.asWireMessage(raw);
        if (message === null)
            return null;
        const id = String(message["id"]);
        // A branch over an untrusted string off the port, not over the closed PortLegUpstream union:
        // an unrecognised type is ignored (the `null`), which is why there is no assertNever arm.
        switch (message.type) {
            case "hello": return { type: "hello", ack: Number(message["ack"]) || 0 };
            case "ack": return { type: "ack", seq: Number(message["seq"]) || 0 };
            case "keepalive": return { type: "keepalive" };
            case "fetch-begin": return { type: "fetch-begin", id, url: String(message["url"]), method: String(message["method"] || "GET").toUpperCase(), headers: wire.toHeaderPairs(message["headers"]) };
            case "fetch-body": return { type: "fetch-body", id, b64: String(message["b64"]) };
            case "fetch-end": return { type: "fetch-end", id };
            case "abort": return { type: "abort", id };
            case "ws-open": return { type: "ws-open", id, url: String(message["url"]), protocols: wire.toStringArray(message["protocols"]) };
            case "ws-send": {
                const text = message["text"];
                // `text` present means a text frame, absent means the b64 one — and under
                // exactOptionalPropertyTypes those are two different objects, not one with undefined in it.
                if (typeof text === "string")
                    return { type: "ws-send", id, text };
                return { type: "ws-send", id, b64: String(message["b64"]) };
            }
            case "ws-close": return { type: "ws-close", id, code: Number(message["code"]) || 1000, reason: String(message["reason"] || "") };
            case "session-gone": return { type: "session-gone" };
            default: return null;
        }
    }
    function describe(error) {
        if (error instanceof Error)
            return error.message;
        const record = wire.asRecord(error);
        const message = record === null ? undefined : record["message"];
        return typeof message === "string" && message ? message : String(error);
    }
})();