#!/usr/bin/env bash
# Push + serve sashaslides on the holosweat server, alongside the existing stack.
#
# Build locally → push to your :5000 registry over the SSH tunnel → pull remotely
# (your existing flow). ADDITIVE and ISOLATED:
#   • its OWN compose project/dir (/root/sashaslides) — never touches /root/holosweat
#   • a NEW nginx site (sashaslides.com) + certbot cert — never touches existing sites/certs
#   • UFW: UNTOUCHED — app port is loopback-only (127.0.0.1:6000) + 80/443 are yours; no ufw calls
#
# This is now a THIN WRAPPER: the sashaslides-specific steps (bridge zip + add-on
# bundle regen, image build, nginx site + certbot) live here; the generic
# "ship image to Hetzner + restart container + verify" part is delegated to the
# COMMON script  prod/scripts/deploy_hetzner.sh  in the claude repo
# (override its location with DEPLOY_HETZNER_SH=/path/to/deploy_hetzner.sh).
#
# Run from your local machine (where you have Docker + the populated repo):
#   bash deploy-sashaslides.sh [--dry-run]
set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────
SERVER_USER="root"
SERVER="server.holosweat.com"
DOMAIN="sashaslides.com"          # <-- the subdomain (A-record → server IP)
ACME_EMAIL="krunoslav.zaher@gmail.com"         # <-- certbot registration email
HOST_PORT="6000"                       # localhost port nginx proxies to (free one)
IMAGE="holosweat-sashaslides:latest"
# Registry tunnel: LOCAL port 45012 (NOT 5000 — macOS AirPlay Receiver owns 5000;
# NOT 6100 — VS Code grabbed it), forwarded to the SERVER's registry which stays on 5000.
# ⚠ ONE-TIME: add the matching entry to Docker Desktop ▸ Settings ▸ Docker Engine ▸
#   "insecure-registries":  "host.docker.internal:45012"   (next to your :5000 one),
#   then Apply & Restart.
LOCAL_PORT="45012"
REMOTE_DIR="/root/sashaslides"
HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="$(cd "$HERE/.." && pwd)"          # addon-server/ (compose build context)

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# ── locate the common deploy script ──────────────────────────────────────────
REPO_ROOT="$(cd "$CTX/../../.." && pwd)"
COMMON="${DEPLOY_HETZNER_SH:-}"
if [ -z "$COMMON" ]; then
  for c in "$REPO_ROOT/../claude/prod/scripts/deploy_hetzner.sh" \
           /workspaces/claude/prod/scripts/deploy_hetzner.sh; do
    [ -f "$c" ] && COMMON="$c" && break
  done
fi
[ -n "$COMMON" ] && [ -f "$COMMON" ] || {
  echo "!! common deploy script not found — set DEPLOY_HETZNER_SH=/path/to/deploy_hetzner.sh" >&2
  exit 1
}

if [ "$DRY" = 1 ]; then
  echo "~ [dry-run] skipping: sasha-bridge.zip regen, add-on bundle regen, docker compose build"
else
  # ── regenerate the Claude-bridge skill zip served by the Automatic tab ──────
  # public/sasha-bridge.zip ships into the image via `COPY renderer`; rebuild it
  # here so a deploy is never stale.
  if [ -f "$REPO_ROOT/bridge/build_zip.py" ]; then
    echo "==> regenerating Automatic-tab download: public/sasha-bridge.zip"
    python3 "$REPO_ROOT/bridge/build_zip.py" "$CTX/public/sasha-bridge.zip" \
      || echo "   (zip regen failed — shipping the committed copy)"
  fi

  # ── regenerate the Apps Script add-on bundle served at /addon-bundle/* ──────
  # install.sh?doc=<id> downloads these three files and clasp-pushes them onto the
  # target deck/doc, so a deploy must never ship a stale bundle.
  echo "==> regenerating add-on bundle: public/addon-bundle/ (SERVER_ORIGIN=https://$DOMAIN)"
  ( cd "$REPO_ROOT/renderer/html2slides" && SERVER_ORIGIN="https://$DOMAIN" npx tsx browser/build-addon.ts ) \
    || { echo "!! add-on bundle build failed"; exit 1; }
  mkdir -p "$CTX/public/addon-bundle"
  for f in Code.gs appsscript.json Sidebar.html; do
    cp "$REPO_ROOT/dist/renderer/html2slides/addon/$f" "$CTX/public/addon-bundle/$f" \
      || { echo "!! bundle file missing: $f"; exit 1; }
  done

  # ── build the image (multi-stage: compiles the pptxgenjs fork bundle +
  #     convert-bundle.js + Code.gs FROM SOURCE in the image — never stale, and
  #     needs NO node/esbuild/gulp on this machine, just Docker). ──────────────
  echo "==> building $IMAGE (from source — fork bundle + convert-bundle + Code.gs)"
  ( cd "$CTX" && HOST_PORT="$HOST_PORT" BUILD_DATE="$(date -u '+%Y-%m-%d %H:%M UTC')" docker compose build )
fi

# ── stage nginx site + cert (sashaslides-specific, additive) ─────────────────
if [ "$DRY" = 1 ]; then
  echo "~ [dry-run] would: scp $HERE/nginx-sashaslides.conf → $SERVER:/tmp/ ; ssh certbot certonly (if no cert) ; install sites-available/$DOMAIN ; nginx -t ; systemctl reload nginx"
else
  echo "==> staging nginx site + certbot on $SERVER"
  scp "$HERE/nginx-sashaslides.conf" "$SERVER_USER@$SERVER:/tmp/nginx-sashaslides.conf"
  ssh "$SERVER_USER@$SERVER" DOMAIN="$DOMAIN" ACME_EMAIL="$ACME_EMAIL" 'bash -s' <<'REMOTE'
set -euo pipefail

# obtain the cert (idempotent — certbot skips if it's still valid). Uses the
# nginx authenticator; does NOT modify your other sites.
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "  -> certbot: obtaining cert for $DOMAIN"
  certbot certonly --nginx --non-interactive --agree-tos -m "$ACME_EMAIL" -d "$DOMAIN" || {
    echo "  !! certbot --nginx failed; retrying with --webroot /var/www/html"
    mkdir -p /var/www/html
    certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos -m "$ACME_EMAIL" -d "$DOMAIN"
  }
else
  echo "  -> cert for $DOMAIN already present (certbot renews it on its own timer)"
fi

# install the NEW nginx site (does not touch existing sites)
cp /tmp/nginx-sashaslides.conf "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
# proxy_params is shipped by nginx on Debian/Ubuntu; create if your box lacks it.
[ -f /etc/nginx/proxy_params ] || cat > /etc/nginx/proxy_params <<'PP'
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
PP
nginx -t                       # abort on a bad config rather than reload-break
systemctl reload nginx         # graceful: existing sites/connections unaffected

# firewall — NOTHING TO DO. The app port is loopback-only (127.0.0.1:6000)
# and 80/443 are already handled by your existing nginx. This script makes
# ZERO ufw changes (no allow/deny/reset) — your rules stay exactly as-is.
REMOTE
fi

# ── .env consumed by compose on the server (HOST_PORT) ───────────────────────
printf 'HOST_PORT=%s\nOVERSAMPLING_DEFAULT=2\n' "$HOST_PORT" > /tmp/sashaslides.env

# ── ship image + restart + verify via the COMMON script ──────────────────────
# (tunnel :45012 → registry :5000, tag/push, remote pull+retag,
#  docker compose -p sashaslides up -d in /root/sashaslides, health poll)
echo "==> delegating to common deploy script: $COMMON"
EXTRA=()
[ "$DRY" = 1 ] && EXTRA+=(--dry-run)
DEPLOY_SSH_USER="$SERVER_USER" \
DEPLOY_SSH_HOST="$SERVER" \
DEPLOY_TUNNEL_PORT="$LOCAL_PORT" \
bash "$COMMON" "$IMAGE" sashaslides \
  --compose-file "$CTX/docker-compose.yml" \
  --env-file /tmp/sashaslides.env \
  --remote-dir "$REMOTE_DIR" \
  --project sashaslides \
  --health-url "https://$DOMAIN/healthz" \
  ${EXTRA[@]+"${EXTRA[@]}"}

echo ""
echo "All done. Server live at https://$DOMAIN — everything was built fresh from source in the image."
echo "Get the current Code.gs (built into the image, never stale) onto your clipboard with:"
echo "    curl -s https://$DOMAIN/Code.gs | pbcopy"
echo "then RE-PASTE it into Apps Script and reload the sidebar."
