# Deploying html2slides (server + SSL + Google Slides add-on)

Two halves:
1. **The UI server** — a Docker container on the holosweat server, behind its nginx and certbot certificate.
2. **The add-on** — a Google Apps Script project that loads the server-hosted UI into the Slides sidebar.

---

## Phase 1 — UI server + SSL

`bash deploy/publish.sh site` (or `npm run renderer:deploy`) from the repository root builds the image on the
server, installs the nginx site and obtains the certificate on a first deploy. See `deploy/DEPLOY.md`.

---

## Phase 2 — the Google Slides add-on

### 2a. Build the add-on pointing at your server
```bash
cd renderer/html2slides
SERVER_ORIGIN=https://slides.yourdomain.com npx tsx browser/build-addon.ts
# → dist/renderer/html2slides/addon/{Code.gs, Sidebar.html, appsscript.json}
```

### 2b. Push it to Apps Script (clasp)
```bash
npm i -g @google/clasp
clasp login
cd dist/renderer/html2slides/addon
clasp create --type slides --title "html2slides"   # or: clasp clone <existing scriptId>
clasp push
```
(Or manually: open a Google Slides deck → **Extensions → Apps Script**, paste `Code.gs`, add `Sidebar.html`, set the manifest from `appsscript.json`.)

### 2c. OAuth consent (one-time)
- The script needs scopes: `presentations`, `drive`, `script.container.ui`, `script.external_request`.
- In the linked Google Cloud project → **OAuth consent screen**: for personal use, set **User type = External**, publishing status **Testing**, and add your own Google account as a **test user**. (Publishing for others requires Google's add-on verification — a separate review process.)

### 2d. Use it
- Open any Google Slides presentation → **Extensions → html2slides → Open html2slides**.
- The sidebar loads the UI from `https://slides.yourdomain.com` (via `Code.gs`'s `UrlFetchApp` + `HtmlService`).
- First open prompts for the OAuth scopes — approve.

---

## Phase 3 — E2E smoke test in Slides
1. **Insert HTML**: paste/URL/drop a fixture → "Insert after current slide" (set oversampling 1–8×).
2. **Export**: slide-range + "Exclude skipped" → "Download slides as PNG (.zip)".
3. **drawio**: "Detect in deck" lists diagram images; Edit opens the self-hosted editor; the off-canvas `FF00FF` `DRAWIO_SRC_*` field round-trips the source.

---

## Updating the UI later (no add-on redeploy)
Because the sidebar fetches its UI from the server, UI changes ship by redeploying the container only:
```bash
bash deploy/publish.sh site
```
Re-push the add-on **only** when `Code.gs` / scopes / `SERVER_ORIGIN` change.
