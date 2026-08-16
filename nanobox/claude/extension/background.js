// nanobox proxy — background service worker (MIT License, see README.md)
//
// One long-lived Port per page (opened by content.js). Over it the content script streams
//   {type:"fetch-begin", id, url, method, headers:[[k,v]...]}  {type:"fetch-body", id, b64}*  {type:"fetch-end", id}
//   {type:"abort", id}   {type:"keepalive"}
// and gets back
//   {type:"result-begin", id, status, statusText, headers:[[k,v]...]}  {type:"result-body", id, b64}*  {type:"result-end", id}
//   {type:"result-error", id, message}
// Bodies travel base64-encoded in chunks: extension messages are JSON-serialised (an ArrayBuffer
// arrives as {} — verified on Chrome 131), and a single message is capped at ~64 MB.
"use strict";

const ALLOWED_PAGE_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
// cloud metadata endpoints: reachable from the browser's network but never from a web page — the
// one class of target this extension refuses to become a bridge to (mirrored in web/proxyext.js)
const BLOCKED_TARGET_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "[fd00:ec2::254]", "100.100.100.200"]);
// hop-by-hop / transport headers that must not be replayed to the page: the browser already
// decoded the body (content-encoding) and its length changed accordingly (content-length)
const STRIPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
const CHUNK_BYTES = 8 * 1024 * 1024;

chrome.runtime.onConnect.addListener((port) => {
  if (!isAllowedSender(port.sender)) { port.disconnect(); return; }
  /** @type {Map<string, {url:string, method:string, headers:[string,string][], chunks:string[], controller:AbortController}>} */
  const inflight = new Map();
  port.onMessage.addListener((message) => onPortMessage(port, inflight, message));
  port.onDisconnect.addListener(() => { for (const request of inflight.values()) request.controller.abort(); inflight.clear(); });
});

function isAllowedSender(sender) {
  const origin = sender && (sender.origin || (sender.url && new URL(sender.url).origin));
  return typeof origin === "string" && ALLOWED_PAGE_ORIGINS.some((pattern) => pattern.test(origin));
}

function onPortMessage(port, inflight, message) {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "keepalive": return;                     // its only job is resetting the service-worker idle timer
    case "fetch-begin":
      inflight.set(message.id, { url: String(message.url), method: String(message.method || "GET"), headers: Array.isArray(message.headers) ? message.headers : [], chunks: [], controller: new AbortController() });
      return;
    case "fetch-body": { const request = inflight.get(message.id); if (request) request.chunks.push(String(message.b64)); return; }
    case "fetch-end": {
      const request = inflight.get(message.id);
      if (!request) return;
      performFetch(request).then(
        (result) => { if (inflight.delete(message.id)) sendResult(port, message.id, result); },
        (error) => { if (inflight.delete(message.id)) port.postMessage({ type: "result-error", id: message.id, message: String(error && error.message || error) }); });
      return;
    }
    case "abort": { const request = inflight.get(message.id); if (request) { request.controller.abort(); inflight.delete(message.id); } return; }
    default: return;
  }
}

async function performFetch(request) {
  const target = new URL(request.url);
  if (!/^https?:$/.test(target.protocol)) throw new Error("only http(s) targets are proxied");
  if (BLOCKED_TARGET_HOSTS.has(target.hostname)) throw new Error("target host is blocked by the nanobox proxy policy");
  const headers = new Headers();
  for (const [name, value] of request.headers) { try { headers.append(name, value); } catch { /* forbidden or malformed header: the browser owns it */ } }
  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase()) && request.chunks.length > 0;
  const body = hasBody ? concatBase64Chunks(request.chunks) : undefined;
  // redirect:"manual" only yields an opaqueredirect (status 0, no Location) in a browser, so the
  // redirect is followed and the final URL is reported instead of a bare 30x (README: limitations)
  const response = await fetch(target.href, { method: request.method, headers, body, credentials: "omit", cache: "no-store", redirect: "follow", signal: request.controller.signal });
  const buffer = new Uint8Array(await response.arrayBuffer());
  const responseHeaders = [];
  response.headers.forEach((value, name) => { if (!STRIPPED_RESPONSE_HEADERS.has(name)) responseHeaders.push([name, value]); });
  responseHeaders.push(["content-length", String(buffer.byteLength)]);
  if (response.redirected) responseHeaders.push(["x-nanobox-redirected-to", response.url]);
  return { status: response.status, statusText: response.statusText, headers: responseHeaders, body: buffer };
}

function sendResult(port, id, result) {
  port.postMessage({ type: "result-begin", id, status: result.status, statusText: result.statusText, headers: result.headers });
  for (let offset = 0; offset < result.body.byteLength; offset += CHUNK_BYTES) port.postMessage({ type: "result-body", id, b64: bytesToBase64(result.body.subarray(offset, offset + CHUNK_BYTES)) });
  port.postMessage({ type: "result-end", id });
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
