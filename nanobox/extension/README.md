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

## Source layout (TypeScript in, classic scripts out)

Everything in this bridge is written in TypeScript and **compiled** to the plain `.js` Chrome and
the page load. The constraint was always on the artifact, never on the source language.

| source | emitted | loaded by |
| --- | --- | --- |
| `extension/src/wire.ts` | `extension/wire.js` | `content_scripts.js`, `importScripts()`, `offscreen.html` |
| `extension/src/background.ts` | `extension/background.js` | `background.service_worker` |
| `extension/src/content.ts` | `extension/content.js` | `content_scripts.js` |
| `extension/src/offscreen.ts` | `extension/offscreen.js` | `offscreen.html` |
| `extension/src/offscreen-codec.ts` | `extension/offscreen-codec.js` | `new Worker()` in `offscreen.js` |
| `web/src/proxyext.ts` | `web/proxyext.js` | `<script src>` in `vm.html` / `sandbox.html` |

The protocol types of both legs live once, in `extension/src/protocol.d.ts`, and are shared with
`web/src/proxyext.ts` — the two halves of the bridge cannot drift apart. No file has a top-level
`import`/`export`, so each emits as a classic script that still publishes its global
(`NanoboxProxyWire`, `NanoboxProxy`) exactly as before; `extension/src/wire-globals.d.ts` and
`web/src/page-globals.d.ts` declare those globals and `wire.ts` is checked against its own
declaration with `satisfies`.

* **Build**: `./build-proxy-extension.sh` (run by `./build-all.sh`, i.e. by `npm start` /
  `npm run build`, and available as `npm run build:proxyext`). It typechecks **both** projects with
  `tsc --noEmit` *before* emitting anything, so a broken tree never reaches `extension/*.js`.
* **Gate**: `npm run typecheck` is the first step of `npm run test:unit`. A transpiler is not a type
  checker, so this is a separate, build-failing step rather than a side effect of bundling.
* **The emitted `.js` is checked in and must not be hand-edited** — every file carries a
  generated-file header. It is tracked on purpose: Chrome loads `extension/` unpacked straight out
  of the repo and `serve.mjs` serves `web/` statically, so a fresh clone and the packed `dist/`
  (`tools/pack.mjs`, which excludes `src/` and the tsconfigs) both work with no build tools present.
* **One `lib` for four scopes.** `@types/chrome` does not compile against `lib.webworker` (it names
  `HTMLElement`, `ShadowRoot` and `MediaStream`), so every context is checked against `lib.dom` —
  see the note in `nanobox/tsconfig.json`. "A worker scope has no `window`/`document`" is therefore
  enforced by a grep step in `build-proxy-extension.sh` over `wire.ts`, `background.ts` and
  `offscreen-codec.ts`, which is a compensating control and not a type.

## What it does

The nanobox pages run a Linux VM (and a "system node on the browser's V8" runtime) in the browser.
Their network egress ends in a plain `fetch()` from the page, and cross-origin that fetch is
subject to CORS: most vendors (api.anthropic.com, chatgpt.com, …) don't answer it, so without help
those requests need a server-side relay (`POST /net/fetch` in `serve.mjs`).

With this extension installed **no relay is needed at all**: the page hands every cross-origin
HTTP(S) request — and every cross-origin WebSocket — to the extension, which performs it (an
extension with `host_permissions` is not subject to CORS) and streams the result back.

| file                 | role |
| -------------------- | ---- |
| `manifest.json`      | MV3; `host_permissions: ["<all_urls>"]` (that IS the point — fetch anything without CORS) + the single `offscreen` permission; the content script is injected only into the allow-listed page origins |
| `wire.js`            | the message vocabulary, the base64 framing and the target policy, shared by the three contexts below |
| `content.js`         | bridge between the page (`window.postMessage`, structured clone) and the extension (one `chrome.runtime.Port`, JSON only). Reconnects and resumes after a service-worker termination |
| `background.js`      | **a broker, not the transport.** Checks the sender's origin, makes sure the offscreen document exists, relays messages |
| `offscreen.html/.js` | owns the `fetch`es and the `WebSocket`s, their replay outbox and the backpressure window |
| `offscreen-codec.js` | base64-frames response bodies off the offscreen document's main thread |

The page side lives in `../web/proxyext.js` (`NanoboxProxy`).

### Why an offscreen document (the MV3 lifetime problem)

Chrome's documented rules for an extension service worker
([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)):

> Normally, Chrome terminates a service worker when one of the following conditions is met: • After
> 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer. • When
> a single request, such as an event or API call, takes longer than 5 minutes to process. • When a
> `fetch()` response takes more than 30 seconds to arrive.

None of that survives an LLM SSE stream, and since Chrome 114 an idle port is explicitly *not* a
keep-alive — *"Sending a message with long-lived messaging keeps the service worker alive. Opening a
port no longer resets the timers."* An offscreen document has no such cap
([offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)): *"The
`AUDIO_PLAYBACK` reason sets the document to close after 30 seconds without audio playing. All other
reasons don't set lifetime limits."* So the connections live there and the worker only relays.

Two honest notes. There is **no `FETCH` or `WEBSOCKET` offscreen reason**; this declares `WORKERS`
(*"needs to spawn workers"*), which is true — it really does spawn `offscreen-codec.js` — but using
an offscreen document primarily for its lifetime is not something the docs sanction. And the
20 s `keepalive` the content script sends is *tolerated*, not blessed: the docs say only *"avoid
keeping your service worker alive indefinitely if possible"*. Hence the belt and braces — if the
worker dies anyway, the content script reconnects with the same session id and the offscreen
document replays from the page's last acknowledged sequence number, so a termination costs
milliseconds rather than the stream.

## Load it (unpacked)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → pick this directory (`nanobox/extension`).
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
  (`credentials: "omit"`), no logging. A request lives in memory only while it is in flight.
* `credentials: "omit"` is a deliberate policy, not a default. Per
  [storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies),
  *"Requests from an extension to a third-party are treated as same-site if the extension has host
  permissions for the third-party. This means `SameSite=Strict` cookies can be sent."* With
  `<all_urls>` that would make this bridge a confused deputy carrying the user's whole cookie jar to
  any host the page names. The CLIs authenticate with bearer tokens and device codes, so they do not
  need it — but a browser-cookie-based OAuth flow will **not** be silently authenticated through
  this extension, and that is on purpose.
* It refuses to be a bridge into cloud metadata endpoints (`169.254.169.254`,
  `metadata.google.internal`, …: `BLOCKED_TARGET_HOSTS`, mirrored by `NanoboxProxy.route()` →
  `"blocked"`). Everything else the browser can reach, the page can reach through it — that is the
  trust you grant by installing it.

## Protocol page ↔ extension (`window.postMessage`, same window)

| direction        | message |
| ---------------- | ------- |
| content → page   | `{type:"nanobox-proxy-hello", version:2, features:["stream","websocket","resume"]}` on load and in reply to every ping |
| page → content   | `{type:"nanobox-proxy-ping"}` |
| page → content   | `{type:"nanobox-proxy-fetch", id, spec:{url, method, headers:[[k,v]…] or {k:v}, body?: ArrayBuffer (transferable)}}` |
| page → content   | `{type:"nanobox-proxy-abort", id}` |
| content → page   | `{type:"nanobox-proxy-head", id, status, statusText, headers:[[k,v]…], dropped:[name…]}` |
| content → page   | `{type:"nanobox-proxy-chunk", id, body: ArrayBuffer}` — repeated as the body arrives |
| content → page   | `{type:"nanobox-proxy-done", id}` |
| content → page   | `{type:"nanobox-proxy-result", id, error}` — the only failure shape, at any point |
| page → content   | `{type:"nanobox-proxy-ws-open", id, url, protocols:[…]}` · `-ws-send {id, text? body?}` · `-ws-close {id, code, reason}` |
| content → page   | `{type:"nanobox-proxy-ws-opened", id, protocol, extensions}` · `-ws-message {id, text? body?}` · `-ws-closed {id, code, reason, wasClean}` |

**Requests and replies never share a message type** (`-ws-open` vs `-ws-opened`). `window.postMessage`
delivers to *every* listener on the window, the sender's own included, so with one name for both
directions each half answers its own replies — a bug `test/proxyext-unit.mjs` caught.

Content ↔ background ↔ offscreen travels over Ports named `nanobox-proxy:<session>` and
`nanobox-offscreen:<session>`: `hello {ack} / fetch-begin / fetch-body* / fetch-end / abort /
ws-open / ws-send / ws-close / ack {seq} / keepalive` upstream, and `head / chunk* / end / error /
ws-opened / ws-text / ws-binary / ws-closed` downstream, each numbered with a `seq`. Bodies are
base64 in ≤ 4 MiB chunks (extension messages are JSON-serialised — an `ArrayBuffer` arrives as `{}`
— and capped at ~64 MB per message). Downstream messages stay in the offscreen document's outbox
until the page acks them, which is both the replay buffer and the backpressure window (8 MiB: past
it the body reader stops, so a 250 MB download flows through the extension instead of into it). The
offscreen document strips `content-encoding` / `content-length` (the browser already decoded the
body, and a streamed total is unknown at head time); when the vendor redirected,
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
* `NanoboxProxy.fetch(spec) → Promise<{status, statusText, headers: Headers, ok, url, dropped, body: ReadableStream|null, arrayBuffer(), text(), json(), toResponse()}>`
  — the raw extension transport; `spec = {url, method, headers, body?: ArrayBuffer|view, signal?}`.
  **Resolves at the HEAD**, while `body` keeps filling — that is what makes an SSE response usable.
  `dropped` names the request headers the extension could not send (see *Limitations*). Rejects with
  a `TypeError` when the failure arrives before the head, and errors `body` when it arrives after.
* `NanoboxProxy.WebSocket` — a `WebSocket`-shaped class whose real socket is opened by the extension's
  offscreen document, with frames piped over the port. `addEventListener` / `on{open,message,close,
  error}` / `send` / `close` / `readyState` / `protocol` / `binaryType` all work. It has **no native
  fallback** and tunnels same-origin sockets too, so install it (`self.WebSocket = …`) only when
  `detect()` returned true — `web/native/src/worker.js` does exactly that. `bufferedAmount` is always
  0 and `event.target` inside a listener is an internal `EventTarget`, not the socket.
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
  has no content script; its `extension` route posts `nanobox-proxy-*` messages to its owner, the
  bridge performs them and posts the replies back **in the same vocabulary**, so a response body
  reaches the worker chunk by chunk rather than buffered). It uses `addEventListener`, so it coexists
  with `worker.onmessage`; the worker's own `message` handlers must ignore `nanobox-proxy-*` messages.

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

`node test/proxyext-unit.mjs` (part of `npm run test:unit`, < 1 s, no browser): loads
`web/netpolicy.js` + `web/proxyext.js` + `wire.js` + `content.js` + `background.js` + `offscreen.js`
— the real EMITTED files, which is what Chrome runs — into separate scopes and stubs only `chrome.runtime` / `chrome.offscreen`, the
offscreen `fetch`, its `WebSocket` and its `Headers`. The port leg is JSON-round-tripped so binary
on it fails as it silently would in Chrome. It asserts the routing policy, the version handshake,
that the page resolves at the head and reads the first SSE event while the response is still open,
that forbidden headers are reported in `dropped`, the WebSocket tunnel in both directions, that a
blocked host is refused by the extension and not just by `route()`, the offscreen-document contract
(one document, reason `WORKERS`, the codec worker) — and the two lifetime cases:
**the service worker is terminated mid-stream** (the upstream fetch is neither restarted nor
aborted and the body spans the gap without a duplicate) and **the page goes away** (the upstream
fetch is aborted at once rather than after the grace period).

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

* **Headers the extension cannot send.** `Origin`, `Host`, `Referer` and `Cookie` are
  [forbidden request-header names](https://fetch.spec.whatwg.org/#forbidden-request-header), and
  `Headers.append()` is a silent no-op for them in an extension context too — so the handshake
  carries `Origin: chrome-extension://<id>`, and a vendor that checks `Origin` sees that. The
  offscreen document compares what it was asked to send with what the `Headers` object actually
  holds and reports the difference as `dropped` on the head, so this surfaces as a diagnosable 401
  instead of a mystery. `User-Agent` is *not* forbidden and is settable.
  The only way to override the rest is `declarativeNetRequest` `modifyHeaders`, which *does* apply
  here — *"it will affect calls to `fetch()` made in a service worker"*
  ([declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)) —
  but the docs publish **no forbidden-header list for its `set` operation**, so whether it can set
  `Origin` / `Host` / `Referer` is *not answerable from primary sources*. `cookie` and `user-agent`
  are at least in its documented `append` allowlist, and `webRequest` separately warns that
  *"Modifying the `Origin` request header might not work as intended and may result in unexpected
  errors in the response's CORS checks."* This extension does not use dNR; it would need the
  `declarativeNetRequestWithHostAccess` permission and a rule set.
* **Cookies**: see *Privacy* — `credentials: "omit"` by policy, so no OAuth flow that depends on the
  browser's cookie jar will complete through this extension.
* **Redirects**: a browser `fetch` with `redirect: "manual"` yields only an opaque redirect (status
  0, no `Location`), so — unlike the Node relay, which returns the 30x — the extension follows the
  redirect and reports the final URL in `x-nanobox-redirected-to`.
* **WebSocket reach**: the tunnel is only usable by code that can call `NanoboxProxy.WebSocket`, i.e.
  the CLIs running on the page's V8. codex running as an x86-64 binary **inside the emulated guest**
  still cannot use it: its egress crosses container2wasm's in-wasm HTTP proxy, which re-issues each
  request as a page `fetch()`, and `fetch` cannot express an `Upgrade`. That is why
  `model_providers.nanobox-https.supports_websockets` is still `false` in `web/sandbox.html`.
* **Chrome Web Store review.** No policy clause names "proxying arbitrary requests", but four apply:
  *"Request access to the narrowest permissions necessary"*
  ([permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions/));
  *"Because it affects all hosts, Chrome web store reviews for extensions that use it may take
  longer"* about `<all_urls>`
  ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns));
  the remote-code ban — *"the full functionality of an extension must be easily discernible from its
  submitted code"*
  ([MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements/)),
  which this satisfies since it forwards data and never fetches logic; and single purpose
  ([quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines/)).
  Expect a slow review and a reviewer asking why `<all_urls>` is narrowest. Loading unpacked, which
  is how nanobox uses it, is unaffected.
* **Firefox MV3 would need changes.** `offscreen` is not in
  [Mozilla's API list](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs),
  Firefox does not support `background.service_worker` (it uses non-persistent **event pages**:
  `background.scripts`, and `persistent: true` is an error in MV3), and `externally_connectable` is
  unsupported. A Firefox build would put the connections in the event page and need its own
  lifetime story; host permissions are also user-revocable there.
* **Serving the page over https.** `content_scripts.matches` lists only `http://localhost/*` and
  `http://127.0.0.1/*`, so on any other origin the bridge is simply not injected and `detect()`
  returns false. Add the origin (or `https://*/*`) to `content_scripts.matches` **and** to
  `ALLOWED_PAGE_ORIGINS` in `wire.js` — both, since `background.js` re-checks the port's sender.
  `host_permissions` alone is not enough: a web page can only reach an extension directly through
  `externally_connectable.matches`, and *"If left empty or unspecified, no web pages can connect."*
  ([externally_connectable](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)).
* **Google Chrome ≥ 137 ignores `--load-extension`**: headless automation must load it through CDP
  `Extensions.loadUnpacked` (pipe) or use Chromium / Chrome for Testing — and Chrome for Testing 131
  (the one in `~/.cache/puppeteer`) cannot run the optimized engine (new wasm-EH needs Chrome ≥ 137).
  Manual *Load unpacked* is unaffected.
