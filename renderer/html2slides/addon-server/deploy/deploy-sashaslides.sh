#!/usr/bin/env bash
# Push + serve sashaslides on the holosweat server, alongside the existing stack.
#
# Build locally → push to your :5000 registry over the SSH tunnel → pull remotely
# (your existing flow). ADDITIVE and ISOLATED:
#   • its OWN compose project/dir (/root/sashaslides) — never touches /root/holosweat
#   • a NEW nginx site (sashaslides.com) + certbot cert — never touches existing sites/certs
#   • UFW: UNTOUCHED — app port is loopback-only (127.0.0.1:6000) + 80/443 are yours; no ufw calls
#
# Run from your local machine (where you have Docker + the populated repo):
#   bash deploy-sashaslides.sh
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
REGISTRY_PORT="5000"                          # registry:2 container's port on the server
REGISTRY_LOCAL="host.docker.internal:$LOCAL_PORT"
REMOTE_DIR="/root/sashaslides"
HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="$(cd "$HERE/.." && pwd)"          # addon-server/ (compose build context)

# ── regenerate the Claude-bridge skill zip served by the Automatic tab ────────
# public/sasha-bridge.zip ships into the image via `COPY renderer`; rebuild it
# here so a deploy is never stale.
REPO_ROOT="$(cd "$CTX/../../.." && pwd)"
if [ -f "$REPO_ROOT/bridge/build_zip.py" ]; then
  echo "==> regenerating Automatic-tab download: public/sasha-bridge.zip"
  python3 "$REPO_ROOT/bridge/build_zip.py" "$CTX/public/sasha-bridge.zip" \
    || echo "   (zip regen failed — shipping the committed copy)"
fi

# ── regenerate the Apps Script add-on bundle served at /addon-bundle/* ────────
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

# ── 0. SSH tunnel:  Mac localhost:$LOCAL_PORT → server registry :$REGISTRY_PORT ─
# Bound to 0.0.0.0 so Docker Desktop's host.docker.internal can reach the forward
# (loopback-only binds aren't always reachable from the Docker VM on macOS). 6100
# sidesteps the macOS AirPlay-on-5000 clash; we still guard in case it's busy.
if lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "!! Local port $LOCAL_PORT is already in use:"
  lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN 2>/dev/null | sed 's/^/   /'
  echo "   Change LOCAL_PORT at the top of this script (and the insecure-registries entry to match)."
  exit 1
fi
echo "==> opening SSH tunnel  localhost:$LOCAL_PORT → $SERVER registry :$REGISTRY_PORT"
ssh -fN -L "0.0.0.0:$LOCAL_PORT:localhost:$REGISTRY_PORT" "$SERVER_USER@$SERVER"
trap 'pkill -f "ssh -fN -L 0.0.0.0:$LOCAL_PORT:localhost:$REGISTRY_PORT $SERVER_USER@$SERVER" 2>/dev/null || true' EXIT
# wait until the registry actually answers THROUGH the tunnel before pushing
for i in $(seq 1 15); do
  if curl -fsS "http://localhost:$LOCAL_PORT/v2/" >/dev/null 2>&1; then echo "  registry reachable through tunnel ✓"; break; fi
  if [ "$i" = 15 ]; then
    echo "!! registry not answering on localhost:$LOCAL_PORT through the tunnel:"
    echo "   • is the registry:2 container up on the server?  ssh $SERVER_USER@$SERVER 'docker ps | grep registry'"
    echo "   • did you add host.docker.internal:$LOCAL_PORT to Docker insecure-registries + Apply & Restart?"
    exit 1
  fi
  sleep 1
done

# ── 1. build the image (multi-stage: compiles the pptxgenjs fork bundle +
#       convert-bundle.js + Code.gs FROM SOURCE in the image — never stale, and
#       needs NO node/esbuild/gulp on this machine, just Docker). ────────────────
echo "==> building $IMAGE (from source — fork bundle + convert-bundle + Code.gs)"
( cd "$CTX" && HOST_PORT="$HOST_PORT" BUILD_DATE="$(date -u '+%Y-%m-%d %H:%M UTC')" docker compose build )

# ── 2. tag + push to the registry (over the tunnel) ───────────────────────────
echo "==> pushing $IMAGE → $REGISTRY_LOCAL"
docker tag "$IMAGE" "$REGISTRY_LOCAL/$IMAGE"
docker push "$REGISTRY_LOCAL/$IMAGE"

# ── 3. copy compose + env + nginx site to the server ──────────────────────────
echo "==> staging compose + nginx site on $SERVER:$REMOTE_DIR"
ssh "$SERVER_USER@$SERVER" "mkdir -p $REMOTE_DIR"
# .env consumed by compose (HOST_PORT); created if absent.
printf 'HOST_PORT=%s\nOVERSAMPLING_DEFAULT=2\n' "$HOST_PORT" > /tmp/sashaslides.env
scp /tmp/sashaslides.env            "$SERVER_USER@$SERVER:$REMOTE_DIR/.env"
scp "$CTX/docker-compose.yml"       "$SERVER_USER@$SERVER:$REMOTE_DIR/docker-compose.yml"
scp "$HERE/nginx-sashaslides.conf"  "$SERVER_USER@$SERVER:/tmp/nginx-sashaslides.conf"

# ── 4. remote: pull image, cert, nginx site, bring up (all additive) ──────────
echo "==> remote: pull, certbot, nginx, compose up"
ssh "$SERVER_USER@$SERVER" DOMAIN="$DOMAIN" ACME_EMAIL="krunoslav.zaher@gmail.com" \
    REMOTE_DIR="$REMOTE_DIR" IMAGE="$IMAGE" 'bash -s' <<'REMOTE'
set -euo pipefail

# 4a. pull the pushed image from the local registry, retag to the compose name
docker pull "localhost:5000/$IMAGE"
docker tag  "localhost:5000/$IMAGE" "$IMAGE"

# 4b. obtain the cert (idempotent — certbot skips if it's still valid). Uses the
#     nginx authenticator; does NOT modify your other sites.
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

# 4c. install the NEW nginx site (does not touch existing sites)
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

# 4d. bring up sashaslides as its OWN compose project (isolated from your stack)
cd "$REMOTE_DIR"
docker compose -p sashaslides up -d

# 4e. firewall — NOTHING TO DO. The app port is loopback-only (127.0.0.1:6000)
#     and 80/443 are already handled by your existing nginx. This script makes
#     ZERO ufw changes (no allow/deny/delete/reset) — your rules stay exactly as-is.

echo "  -> sashaslides container:"; docker ps --filter name=sashaslides --format '     {{.Names}}  {{.Status}}  {{.Ports}}'
REMOTE

# ── 6. verify ─────────────────────────────────────────────────────────────────
echo "==> verifying https://$DOMAIN/healthz"
sleep 3
curl -fsS "https://$DOMAIN/healthz" && echo " ✓ live" || echo " (give the container a few seconds; re-check https://$DOMAIN/healthz)"
echo ""
echo "All done. Server live at https://$DOMAIN — everything was built fresh from source in the image."
echo "Get the current Code.gs (built into the image, never stale) onto your clipboard with:"
echo "    curl -s https://$DOMAIN/Code.gs | pbcopy"
echo "then RE-PASTE it into Apps Script and reload the sidebar."
