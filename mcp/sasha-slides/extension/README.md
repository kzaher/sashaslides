# sasha-slides picker — MV3 Chrome extension (PAUSED pending the vehicle decision)

Observes Drive for sasha-slides `READY` markers, shows the candidate slides as a numbered picker
inside Google Slides with an **HTML ⇄ converted-slide** toggle and per-region anomaly reporting,
inserts the chosen slide and writes `PICK`. Contract: [`../PROTOCOL.md`](../PROTOCOL.md).

**Status: the protocol layer is built, tested and green; the extension plumbing is blocked on two
findings and on PROTOCOL.md's newer "Apps Script add-on, not necessarily a Chrome extension"
section.** See *What is blocked* below before changing anything here.

## Source layout (TypeScript in, classic scripts out)

| source | emitted | loaded by |
| --- | --- | --- |
| `src/background.ts` | `background.js` | `manifest.background.service_worker` |
| `src/offscreen.ts` | `offscreen.js` | `offscreen.html` |
| `src/content.ts` (+ `Picker.tsx`, React) | `content.js` | `manifest.content_scripts.js` |

* **Build**: `./build-extension.sh` — `tsc --noEmit` on **both** projects first, then esbuild. A
  broken tree never reaches the emitted `.js`.
* **Gate**: `npm run typecheck` (`tsconfig.json` = shipped sources, browser types only;
  `tsconfig.test.json` = tests, the only project allowed `@types/node`).
* **The emitted `.js` is generated and must never be hand-edited** — each file carries a header.
* `npm test` → 48 unit tests, no network, no browser. `npm run smoke` → a real Chrome.

## Manifest permissions, and why each one

| entry | why |
| --- | --- |
| `permissions: offscreen` | the Drive poll loop and the token cannot live in a service worker (terminated at 30 s idle / 5 min per request / 30 s per fetch; since Chrome 114 an idle port is not a keep-alive) |
| `permissions: storage` | the `seen` proposal-id set, so an answered proposal is not re-offered, and the channel choice |
| `permissions: identity` | `launchWebAuthFlow` under channel option A only; unused under option B |
| `host_permissions: www.googleapis.com, slides.googleapis.com` | Drive v3 + Slides v1 from an extension origin, where `host_permissions` exempts the request from CORS. A content-script fetch cannot be used: it carries the page's origin and cookies, and `Origin` is a [forbidden request-header name](https://fetch.spec.whatwg.org/#forbidden-request-header) — `Headers.append()` is a silent no-op for it even from an extension |
| `host_permissions: *.googleusercontent.com` | `pages.getThumbnail` returns a short-lived unauthenticated `contentUrl` there; it is fetched to produce `render/NN.png` |
| `host_permissions: 127.0.0.1, localhost` | channel option B, the MCP-server bridge |
| `content_scripts: https://docs.google.com/presentation/*` | the only page the picker belongs on. No `tabs`, no `activeTab`, no `<all_urls>`, no `declarativeNetRequest` |

## The OAuth conclusion

`appProperties` are *"private to the requesting app"* and `drive.file` is per-app in the same way,
so **the extension and the MCP server must authenticate as the same OAuth client id** or the
extension sees none of the server's files — with no error. That rules out
`chrome.identity.getAuthToken`, which requires a *Chrome Extension*-type client keyed to the
extension id, i.e. necessarily a second client. `src/drive-channel.ts` therefore makes the transport
a seam with two implementations, selected by `chrome.storage.local.driveChannel`:

* **A `google-oauth`** — `launchWebAuthFlow` against the server's client id (which must become a
  *Web application* client with a `https://<extension-id>.chromiumapp.org/` redirect). Implicit
  flow, because an extension cannot keep a client secret; silent renewal with `prompt=none`.
* **B `localhost-bridge`** (the default, and the recommendation) — the server does every Drive call
  with the credential it already has. No second credential, one Drive app, and the proven pattern in
  `nanobox/extension`.

`src/google-identity.ts` argues both at length, including the fallbacks if Google refuses the
implicit flow for a freshly created Web client.

## What is blocked

1. **An offscreen document does not get the extension API surface — measured on Chrome 154.** In the
   service worker `Object.keys(chrome)` lists `storage` and `identity`; in the offscreen document
   both are `undefined` and `chrome.runtime.getManifest()` throws. Only `chrome.runtime` messaging
   is present. `src/offscreen.ts` reads `chrome.storage.local` and would call `chrome.identity`, so
   `npm run smoke` fails with *"Cannot read properties of undefined (reading 'local') at
   readChannelChoice"*. The fix is to proxy both through the service worker over the port it already
   brokers — **not done, on purpose**: if storage and auth must live in the service worker anyway,
   the offscreen document only buys the sub-30 s poll timer, which weakens the case for an extension
   at all. (nanobox's offscreen document never hit this: it uses only `fetch`, `WebSocket` and
   `chrome.runtime`.)
2. **Discovery must move from `appProperties` to file NAMES** (PROTOCOL.md, *"Discovery is by NAME,
   not by appProperties"*). `src/observer.ts`'s reducer, dedupe, cadence and backoff are unaffected;
   `nextCandidate`'s input and `DriveApi.listByRoles` become a name walk
   (`Sasha Slides Inbox` → `<proposalId>` → `READY`/`PICK`). Held because the Apps Script sidebar
   replaces the Drive client wholesale.

What is **not** blocked, and carries to either vehicle: `src/observer.ts` (the reducer),
`src/observer-runtime.ts`, `src/protocol.ts`, `src/pick-writer.ts`, `src/render-artifact.ts`,
`src/picker-state.ts`, `src/Picker.tsx`, `src/rendered-preview.ts`, `src/html-check.ts`,
`src/converter-contract.ts` and all 48 tests.

## Assumptions about other streams

* **The converter.** `mcp/sasha-slides/converter/` did not exist, so `src/converter-contract.ts`
  declares the interface the task described and ships `stubConvertHtmlToSlideRequests`.
  `normalizeUnsupported` accepts the plausible spellings of an unsupported entry's bounding box
  (`region`/`bounds`/`box`/`rect`, `x|left`, `w|width`, …). Wiring the real one is **one line**:
  `src/content.ts`'s `convertHtmlToSlideRequests` constant.
* **The rendered pane is a projection of the converter's requests, not a Google rasterisation.** A
  true raster needs `pages.getThumbnail`, which needs the slide to already exist — so the preview
  draws each element's box, kind and text, and assumes Slides' 16:9 default page (720 × 405 pt).
  See `src/rendered-preview.ts`.
* **`render/NN.png` is written for the picked slide only**, from the real thumbnail after the insert,
  and is best-effort: by then the slide is in the user's deck, so a failed upload must never be
  reported as a failed insert.

## Load it

Unpacked, `chrome://extensions` → Developer mode → **Load unpacked** → this directory. Headless:
Google Chrome ≥ 137 ignores `--load-extension`; use CDP `Extensions.loadUnpacked` over
`--remote-debugging-pipe` with `--enable-unsafe-extension-debugging`, which is what
`src/smoke.e2e.ts` does (recipe from `nanobox/test/chrome-extension-harness.mjs`).
