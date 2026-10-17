# The sashaslides.com website

`renderer/html2slides/addon-server/` is the website: the product home page (`/`), the legal pages
(`/privacy`, `/terms`), the setup walkthroughs (`/walkthroughs/*`), the developer page (`/dev`, linked
from no public page) and the self-hosted draw.io editor (`/drawio/`). `server.ts` serves static files
only; nginx sends the connector's paths (`/mcp`, `/account`, `/decks`, `/deck-api`, ...) to the
connector (`deploy/nginx-sashaslides.conf`, contract in `deploy/nginx-routing.test.ts`).

## Develop

```bash
cd renderer/html2slides/addon-server
npm ci                 # preact (the page's renderer); everything else comes from the repository root
npm run build          # dev/build.ts -> public/dev.js, public/dev-pptx.js, public/e2e-drawio.js
PORT=8787 npm start    # http://127.0.0.1:8787/dev
npm test               # type check (three projects), build, unit tests, routing contract
npm run smoke          # headless Chrome on :9222 drives /dev on a free port (no Google)
```

The page's TypeScript lives in `dev/`:

| File | What it is |
|---|---|
| `dev-page.tsx` | The page (Preact). Renders the pure modules below. |
| `queue-state.ts` | The queue of pasted or dropped documents and their conversions (a reducer). |
| `conversion.ts` | One document through the PRODUCT converter (`mcp/sasha-slides/converter`), with the compiled extractor and draw.io rendering at `/drawio/`. |
| `warnings.ts` | The converter's `unsupported` list as numbered marks over the preview. |
| `insert-request.ts` | The body of `POST /deck-api/google-slides/insert-html` (`mcp/sasha-slides/google-slides/insert-html-contract.ts`). |
| `export-request.ts` | The body of `POST /deck-api/google-slides/export-png`. |
| `deck-api.ts` | The session (`GET /deck-api/session`), insert and export calls, and their answers. |
| `pptx-builder.ts`, `pptx-download.ts` | The offline `.pptx` download: a separate bundle loaded on demand, the command-line converter's browser core with our pptxgenjs fork built from `deps/pptxgenjs/src`. |
| `drawio-harness.ts` | `public/e2e-drawio.html`'s `window.__run`, driven by `renderer/html2slides/e2e/drawio-editor.e2e.ts`. |
| `build.ts` | The esbuild build. The type check is `npm run typecheck`, never the bundler. |

## Signing in and Google

The page uses the deck web application's session: the `sasha_deck` cookie (`Path=/deck-api`), read with
`GET /deck-api/session`, and the `X-Sasha-Csrf` header on every POST. Signed out, "Sign in" goes to
`/account/deck-session?return=/dev`. Without a Google grant the connector answers 409
`googleNotConnected` with a `connectAddress`, which the page offers as "Connect Google Slides". Inserting
and exporting run on the signed-in person's own Google grant, on the connector; the website holds no
Google credentials at all.

## Deploy

`bash deploy/publish.sh site` from the repository root packs the build context, builds the image on the
server (the `Dockerfile` builds the page's bundles itself) and restarts it. See `deploy/DEPLOY.md`.

After a deploy, check: `/`, `/dev`, `/static/dev.js`, `/drawio/` and `/walkthroughs/claude-ai` answer
200; `/shell.html`, `/install.sh`, `/api/config` and `/api/fetch-html` answer 404; on `/dev`, signed in,
an insert into a scratch presentation lands at the chosen position, and a PNG export of it downloads.
