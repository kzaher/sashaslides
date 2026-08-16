// nanobox proxy — content script (MIT License, see README.md)
//
// Bridge between the page (window.postMessage) and the background service worker (a Port).
// Page -> content:  {type:"nanobox-proxy-ping"}
//                   {type:"nanobox-proxy-fetch", id, spec:{url, method, headers:[[k,v]...]|{k:v}, body?:ArrayBuffer}}
//                   {type:"nanobox-proxy-abort", id}
// Content -> page:  {type:"nanobox-proxy-hello", version}   (on load and in reply to every ping)
//                   {type:"nanobox-proxy-result", id, status, statusText, headers:[[k,v]...], body:ArrayBuffer}
//                   {type:"nanobox-proxy-result", id, error:"..."}
// Only messages posted by this very window (ev.source === window) are honoured, and the manifest's
// content_scripts.matches decides which page origins get the bridge at all.
"use strict";

const PROTOCOL_VERSION = 1;
const CHUNK_BYTES = 8 * 1024 * 1024;
const KEEPALIVE_MS = 20000;   // < the 30 s idle timeout of an MV3 service worker

/** @type {Map<string, {headers:[string,string][], status:number, statusText:string, chunks:string[]}|{pending:true}>} */
const pending = new Map();
let port = null;
let keepaliveTimer = null;

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || typeof event.data !== "object") return;
  switch (event.data.type) {
    case "nanobox-proxy-ping": announce(); return;
    case "nanobox-proxy-fetch": startFetch(event.data); return;
    case "nanobox-proxy-abort": abortFetch(String(event.data.id)); return;
    default: return;
  }
});
announce();

function announce() { window.postMessage({ type: "nanobox-proxy-hello", version: PROTOCOL_VERSION }, location.origin); }

function startFetch(message) {
  const id = String(message.id);
  const spec = message.spec || {};
  const headers = Array.isArray(spec.headers) ? spec.headers : Object.entries(spec.headers || {});
  const body = spec.body instanceof ArrayBuffer ? new Uint8Array(spec.body) : ArrayBuffer.isView(spec.body) ? new Uint8Array(spec.body.buffer, spec.body.byteOffset, spec.body.byteLength) : null;
  let bridge;
  try { bridge = ensurePort(); } catch (error) { replyError(id, "extension unavailable: " + (error && error.message || error)); return; }
  pending.set(id, { pending: true });
  bridge.postMessage({ type: "fetch-begin", id, url: String(spec.url), method: String(spec.method || "GET").toUpperCase(), headers });
  for (let offset = 0; body && offset < body.byteLength; offset += CHUNK_BYTES) bridge.postMessage({ type: "fetch-body", id, b64: bytesToBase64(body.subarray(offset, offset + CHUNK_BYTES)) });
  bridge.postMessage({ type: "fetch-end", id });
  scheduleKeepalive();
}

function abortFetch(id) {
  if (!pending.delete(id)) return;
  if (port) port.postMessage({ type: "abort", id });
  replyError(id, "aborted");
}

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "nanobox-proxy" });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    const lost = [...pending.keys()];
    pending.clear();
    for (const id of lost) replyError(id, "extension service worker disconnected (" + (chrome.runtime.lastError && chrome.runtime.lastError.message || "no reason") + ")");
  });
  return port;
}

function onPortMessage(message) {
  if (!message || typeof message !== "object") return;
  const id = String(message.id);
  const entry = pending.get(id);
  if (!entry) return;
  switch (message.type) {
    case "result-begin": pending.set(id, { status: message.status, statusText: String(message.statusText || ""), headers: Array.isArray(message.headers) ? message.headers : [], chunks: [] }); return;
    case "result-body": if (!entry.pending) entry.chunks.push(String(message.b64)); return;
    case "result-end": {
      pending.delete(id);
      if (entry.pending) { replyError(id, "protocol error: result-end without result-begin"); return; }
      const body = concatBase64Chunks(entry.chunks);
      window.postMessage({ type: "nanobox-proxy-result", id, status: entry.status, statusText: entry.statusText, headers: entry.headers, body: body.buffer }, location.origin, [body.buffer]);
      scheduleKeepalive();
      return;
    }
    case "result-error": pending.delete(id); replyError(id, String(message.message)); scheduleKeepalive(); return;
    default: return;
  }
}

function replyError(id, error) { window.postMessage({ type: "nanobox-proxy-result", id, error }, location.origin); }

// while requests are in flight, poke the service worker so its idle timer never expires mid-fetch
function scheduleKeepalive() {
  if (pending.size === 0) { if (keepaliveTimer) clearInterval(keepaliveTimer); keepaliveTimer = null; return; }
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => { if (port && pending.size > 0) port.postMessage({ type: "keepalive" }); else scheduleKeepalive(); }, KEEPALIVE_MS);
}

function concatBase64Chunks(chunks) {
  const parts = chunks.map(base64ToBytes);
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
