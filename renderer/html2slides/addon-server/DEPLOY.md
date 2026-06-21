# Deploying html2slides (server + SSL + Google Slides add-on)

Two halves:
1. **The UI server** — a Docker container (Node + Caddy) on *your* host, with automatic Let's Encrypt SSL.
2. **The add-on** — a Google Apps Script project that loads the server-hosted UI into the Slides sidebar.

The browser/sidebar never sees a cert you manage — Caddy terminates TLS and auto-renews.

---

## Phase 1 — UI server + SSL (on your host)

### Prereqs
- A host with Docker + Docker Compose, ports **80 and 443** open to the internet.
- A domain/subdomain (e.g. `slides.yourdomain.com`) with a DNS **A record → your host's public IP**. (Caddy needs port 80 reachable to solve the ACME HTTP challenge.)

### Steps
```bash
# 1. Get the repo onto the host (with submodules — drawio is one).
git clone --recurse-submodules <your-repo-url> sashaslides
cd sashaslides
git submodule update --init deps/drawio      # populates the self-hosted drawio editor

# 2. Configure the domain + ACME email.
cd renderer/html2slides/addon-server
cat > .env <<EOF
DOMAIN=slides.yourdomain.com
ACME_EMAIL=you@yourdomain.com
EOF

# 3. (Recommended) Build the drawio webapp once if the submodule ships source only.
#    drawio's prebuilt webapp lives under src/main/webapp; if a build step is
#    needed, run it on the host (it's heavy) — see deps/drawio/README. The server
#    serves whatever is under deps/drawio/src/main/webapp (or build/).

# 4. Bring it up. Caddy fetches the cert on first request.
docker compose up -d --build

# 5. Verify.
curl https://slides.yourdomain.com/healthz       # -> ok
curl https://slides.yourdomain.com/api/config    # -> {"oversampling":...,"drawioAvailable":true,...}
```

### Cert lifecycle (automatic)
- First hit on the domain → Caddy gets a Let's Encrypt cert.
- Renews ~30 days before expiry, no cron.
- Certs + ACME account key live in the `caddy_data` Docker **volume** → survive `docker compose down/up` and never needlessly re-issue (stays under LE rate limits).
- **Tip:** before going live, test with the staging CA (uncomment `acme_ca …staging…` in `Caddyfile`) so a typo doesn't burn your weekly rate limit; switch back once `curl` succeeds, then `docker compose restart caddy`.

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
cd renderer/html2slides/addon-server && docker compose up -d --build
```
Re-push the add-on **only** when `Code.gs` / scopes / `SERVER_ORIGIN` change.
