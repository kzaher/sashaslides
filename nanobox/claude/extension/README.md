# nanobox proxy — a tiny Chrome/Chromium (Manifest V3) extension

```
MIT License

Copyright (c) 2026 nanobox contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## What it does

The nanobox pages run a Linux VM (and a "system node on the browser's V8" runtime) in the browser.
Their network egress ends in a plain `fetch()` from the page, and cross-origin that fetch is
subject to CORS: most vendors (api.anthropic.com, chatgpt.com, …) don't answer it, so without help
those requests need a server-side relay (`POST /net/fetch` in `serve.mjs`).

With this extension installed **no relay is needed at all**: the page hands every cross-origin
HTTP(S) request to the extension, the extension's background service worker fetches it (an
extension with `host_permissions` is not subject to CORS) and hands status, headers and body back
to the page. Only three files:

| file            | role |
| --------------- | ---- |
| `manifest.json` | MV3; `host_permissions: ["<all_urls>"]` (that IS the point — fetch anything without CORS), **no other permission**; the content script is injected only into the allow-listed page origins |
| `content.js`    | bridge between the page (`window.postMessage`) and the service worker (one long-lived `chrome.runtime.Port`) |
| `background.js` | does the `fetch()`, streams status/headers/body back |

The page side lives in `../web/proxyext.js` (`NanoboxProxy`).

## Load it (unpacked)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → pick this directory (`nanobox/claude/extension`).
3. Reload the nanobox page. Its console prints `[nanobox] proxy extension detected: cross-origin
   requests go through it`, and `window.nanoboxNetRoutes` counts `extension` routes.

Headless / automated Chrome: **Google Chrome ≥ 137 (branded builds) ignores `--load-extension`**
(Chromium / Chrome for Testing still honour it). What works everywhere is CDP
`Extensions.loadUnpacked({path})` over `--remote-debugging-pipe` with
`--enable-unsafe-extension-debugging` — `test/e2e-proxyext.mjs` does exactly that (fds 3/4 carry the
pipe; Chrome exits when the pipe closes, so it lives as long as the test). Loading unpacked through
`chrome://extensions` works in every Chrome.

## Privacy

* It only forwards requests that originate from allow-listed page origins — by default
  `http://localhost:*` and `http://127.0.0.1:*` (`content_scripts.matches` in the manifest, checked
  again by `background.js` `ALLOWED_PAGE_ORIGINS` on the sender of every port). To use it from
  another origin add it to both places.
* It never stores anything: no storage permission, no cache (`cache: "no-store"`), no cookies
  (`credentials: "omit"` — the browser's cookies for the target site are never attached), no
  logging. A request lives in memory only while it is in flight.
* It refuses to be a bridge into cloud metadata endpoints (`169.254.169.254`,
  `metadata.google.internal`, …: `BLOCKED_TARGET_HOSTS`, mirrored by `NanoboxProxy.route()` →
  `"blocked"`). Everything else the browser can reach, the page can reach through it — that is the
  trust you grant by installing it.

## Protocol page ↔ extension (`window.postMessage`, same window)

| direction        | message |
| ---------------- | ------- |
| content → page   | `{type:"nanobox-proxy-hello", version:1}` on load and in reply to every ping |
| page → content   | `{type:"nanobox-proxy-ping"}` |
| page → content   | `{type:"nanobox-proxy-fetch", id, spec:{url, method, headers:[[k,v]…] or {k:v}, body?: ArrayBuffer (transferable)}}` |
| page → content   | `{type:"nanobox-proxy-abort", id}` |
| content → page   | `{type:"nanobox-proxy-result", id, status, statusText, headers:[[k,v]…], body: ArrayBuffer}` or `{type:"nanobox-proxy-result", id, error}` |

Content ↔ background travels over a Port named `nanobox-proxy` as `fetch-begin / fetch-body* /
fetch-end` and `result-begin / result-body* / result-end | result-error` messages; bodies are
base64 in ≤ 8 MiB chunks (extension messages are JSON-serialised — an `ArrayBuffer` arrives as
`{}` — and capped at ~64 MB per message). The background strips `content-encoding` (the browser
already decoded the body) and sets `content-length` to the decoded size; when the vendor redirected,
`x-nanobox-redirected-to` carries the final URL.

## Page-side library: `web/proxyext.js` (`NanoboxProxy`)

Load `/netpolicy.js` first (it throws otherwise). Works in a window and in a dedicated worker.

* `NanoboxProxy.detect(timeoutMs = 300) → Promise<boolean>` — hello/ping handshake; window only
  (a worker resolves `false` — the page passes the answer in `cfg`, see below). Result cached in
  `NanoboxProxy.detected`.
* `NanoboxProxy.route(url, {extension?}) → "direct" | "extension" | "relay" | "blocked"` — the
  policy: same-origin / non-http(s) → `direct`; blocked hosts → `blocked`; extension present →
  `extension` for **everything** cross-origin; else `NanoboxNetPolicy.isProxied(host)` → `relay`
  (our server, the low-traffic vendor set); else `direct`. `extension` defaults to
  `NanoboxProxy.detected`.
* `NanoboxProxy.fetch(spec) → Promise<{status, statusText, headers: Headers, ok, url, arrayBuffer(), text(), json(), toResponse()}>`
  — the raw extension transport; `spec = {url, method, headers, body?: ArrayBuffer|view, signal?}`.
  Rejects with a `TypeError` when the extension reports an error (like a failed browser fetch).
* `NanoboxProxy.workerFetch(origFetch, input, init, cfg) → Promise<Response>` — the complete body
  of a `fetch` override, usable **as-is from the page and from a worker**:
  ```js
  // in the worker (e.g. web/native/src/worker.js) — after importScripts("/netpolicy.js", "/proxyext.js"):
  const origFetch = self.fetch.bind(self);
  self.fetch = (input, init) => NanoboxProxy.workerFetch(origFetch, input, init, {
    extension: cfg.proxyExtension,                       // boolean the page got from NanoboxProxy.detect()
    onRoute: ({ route, method, url }) => { /* optional: netlog / byte accounting */ },
  });
  ```
  Contract: `route(url)` decides; `direct` → `origFetch(input, init)` untouched; `relay` → the
  existing `POST /net/fetch` encoding (`x-nanobox-target` = base64url JSON `{url, method, headers}`
  + body); `extension` → `NanoboxProxy.fetch`; `blocked` → a synthetic `403` Response. Any body shape
  `fetch` accepts (string, `Uint8Array`, `Blob`, `FormData`, `ReadableStream`, a `Request` as
  `input`) is normalised through `new Request()`, so implicit `content-type`s survive; `init.signal`
  aborts on every route. Same-origin requests never touch the extension.
* `NanoboxProxy.bridgeWorker(worker)` — **the page that owns the worker must call this** (a worker
  has no content script; its `extension` route posts `nanobox-proxy-fetch` messages to its owner,
  the bridge forwards them and posts `nanobox-proxy-result` back). It uses `addEventListener`, so it
  coexists with `worker.onmessage`; the worker's own `message` handlers must ignore
  `nanobox-proxy-result` messages (they only need to look at their own message types).

  Wiring on the page (what `sandbox.html` / `claude-native.html` need for the runtime worker):
  ```html
  <script src="/netpolicy.js"></script><script src="/proxyext.js"></script>
  <script>
    const proxyExtension = await NanoboxProxy.detect();          // before posting "init"
    const worker = NanoboxProxy.bridgeWorker(new Worker("/native/runtime.js"));
    worker.postMessage({ type: "init", cfg: { ...cfg, proxyExtension } });
  </script>
  ```

`web/vm.html` already uses `workerFetch` for the VM's egress and exposes
`window.nanoboxNetRoutes = {extension, relay, direct, blocked, log:[…]}`.

## Test

`node test/e2e-proxyext.mjs` (≈ 90 s; runs both halves, `--only extension|fallback`):

* **extension**: starts a fresh Google Chrome on `:9223`, loads the extension over the CDP pipe, opens
  `vm.html?engine=opt&image=codex`, asserts `detect() === true` and the routing table, boots to the
  codex sign-in menu, chooses *Sign in with Device Code*, and asserts every request took the
  `extension` route with **zero** relay hits (page counter and CDP `Network.requestWillBeSent` on
  `/net/fetch`).
* **fallback**: the plain Chrome on `:9222` (no extension): `detect() === false`,
  `route(api.anthropic.com) === "relay"`, `route(auth.openai.com) === "direct"`, the same sign-in
  goes relay/direct and the CDP-observed relay hits equal the page's `relay` counter.

## Limitations

* **Redirects**: a browser `fetch` with `redirect: "manual"` yields only an opaque redirect (status
  0, no `Location`), so — unlike the Node relay, which returns the 30x — the extension follows the
  redirect and reports the final URL in `x-nanobox-redirected-to`. Cross-origin redirects are thus
  followed by the browser (no cookies attached); the guest sees the final response.
* **Streaming**: responses are buffered (whole body, then handed over) — fine for API calls and
  tarballs, not for long-lived SSE/streaming responses (the relay is buffered too).
* **MV3 service-worker lifetime**: Chrome stops an idle service worker after ~30 s; the content
  script sends a `keepalive` on the port every 20 s while requests are in flight and reconnects the
  port lazily, so a stopped worker only costs a few ms on the next request. If the worker is killed
  mid-request (extension reload), the pending requests reject with `extension service worker
  disconnected`.
* **Headers the browser owns**: `Host`, `Content-Length`, `Origin`, `Cookie`, `Accept-Encoding`,
  `Connection`… cannot be set from an extension `fetch` either; requests carry the browser's
  `Origin: chrome-extension://…`. Vendors that reject unknown `Origin`s see that.
* **Google Chrome ≥ 137 ignores `--load-extension`**: headless automation must load it through CDP
  `Extensions.loadUnpacked` (pipe) or use Chromium / Chrome for Testing — and Chrome for Testing 131
  (the one in `~/.cache/puppeteer`) cannot run the optimized engine (new wasm-EH needs Chrome ≥ 137).
  Manual *Load unpacked* is unaffected.
