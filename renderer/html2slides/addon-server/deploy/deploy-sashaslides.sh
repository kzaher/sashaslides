#!/usr/bin/env bash
# Push + serve sashaslides on the holosweat server, alongside the existing stack.
#
# Mirrors your registry-push flow (build local → push to the :5000 registry over
# the SSH tunnel → pull remotely) but is ADDITIVE and ISOLATED:
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
REGISTRY_LOCAL="host.docker.internal:5000"   # your registry via the SSH tunnel
REMOTE_DIR="/root/sashaslides"
HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="$(cd "$HERE/.." && pwd)"          # addon-server/ (compose build context)

# ── 0. SSH tunnel for the registry (:5000), like your other deploy ────────────
echo "==> opening SSH tunnel to the registry (:5000)"
ssh -fN -L 5000:localhost:5000 "$SERVER_USER@$SERVER"
TUNNEL_PID=$(pgrep -f "ssh -fN -L 5000:localhost:5000 $SERVER_USER@$SERVER" | head -1 || true)
trap '[ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true' EXIT
sleep 2

# ── 1. build the image locally ────────────────────────────────────────────────
echo "==> building $IMAGE"
( cd "$CTX" && HOST_PORT="$HOST_PORT" docker compose build )

# ── 2. push via the registry ──────────────────────────────────────────────────
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

# 4a. pull the pushed image from the local registry and retag to the compose name
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

# ── 5. build the add-on Code.gs pointing at this domain (ready to paste) ──────
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
echo "==> building add-on Code.gs (SERVER_ORIGIN=https://$DOMAIN)"
( cd "$REPO_ROOT" && SERVER_ORIGIN="https://$DOMAIN" npx tsx renderer/html2slides/browser/build-addon.ts ) \
  && echo "    → paste this into Apps Script: $REPO_ROOT/dist/renderer/html2slides/addon/Code.gs" \
  || echo "    (add-on build skipped/failed — run it manually: SERVER_ORIGIN=https://$DOMAIN npm run build:addon)"

# ── 6. verify ─────────────────────────────────────────────────────────────────
echo "==> verifying https://$DOMAIN/healthz"
curl -fsS "https://$DOMAIN/healthz" && echo " ✓ live" || echo " (DNS may still be propagating; retry shortly)"
echo "All done. Server live at https://$DOMAIN — paste Code.gs into Apps Script to finish the add-on."
