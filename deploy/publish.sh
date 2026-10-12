#!/usr/bin/env bash
# Publish sashaslides.com (the website) and/or the Sasha Slides remote MCP connector to the
# holosweat server, building the images ON THE SERVER. Needs only ssh, scp, tar, gzip, dd
# and node on this machine: no Docker, no rsync, no registry tunnel.
#
#   deploy/publish.sh [--dry-run] site|connector|all
#   deploy/publish.sh [--dry-run] rollback site|connector
#
# See deploy/DEPLOY.md for one-time setup, secrets and rollback. --dry-run builds the
# tarballs locally (to report their sizes), prints every remote command and connects to
# nothing.
#
# Server layout:
#   /root/sashaslides/        website  (compose project `sashaslides`,     127.0.0.1:6000)
#     src/                    build context, replaced each deploy (repo-relative layout)
#     drawio-webapp/          deps/drawio/src/main/webapp, re-uploaded only when its sha256 changes
#     drawio.sha256
#   /root/sasha-connector/    connector (compose project `sasha-connector`, 127.0.0.1:6100)
#     src/  data/  secrets/   see mcp/sasha-slides/deploy/docker-compose.yml
#
# Environment overrides: DEPLOY_HOST (root@78.46.91.218, the server "holosweat"),
# DEPLOY_DOMAIN (sashaslides.com), DEPLOY_KEY (unset: ssh uses its agent, e.g. a forwarded
# SSH_AUTH_SOCK; set it to force one key file with IdentitiesOnly).
set -euo pipefail

HOST="${DEPLOY_HOST:-root@78.46.91.218}"
KEY="${DEPLOY_KEY:-}"
DOMAIN="${DEPLOY_DOMAIN:-sashaslides.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="renderer/html2slides/addon-server"
CONNECTOR_DEPLOY_DIR="mcp/sasha-slides/deploy"
NGINX_CONF="$SITE_DIR/deploy/nginx-sashaslides.conf"
DRAWIO_WEBAPP="deps/drawio/src/main/webapp"
SITE_HOME="/root/sashaslides"
CONNECTOR_HOME="/root/sasha-connector"
# The connector's container user (mcp/sasha-slides/deploy/Dockerfile). Not 1000: on the
# server uid 1000 is a login user, who would then own the secrets.
CONNECTOR_UID="10100"
# The server's host keys are pinned in the repo, so a rebuilt container (empty ~/.ssh) deploys
# without a prompt and still refuses an impostor. Refresh with: ssh-keyscan 78.46.91.218 > deploy/known_hosts
KNOWN_HOSTS="$(cd "$(dirname "$0")" && pwd)/known_hosts"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=3
          -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
[ -z "$KEY" ] || SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)

# Wall-clock budgets (seconds). Each remote step is killed past its budget, and the ssh
# keepalive above kills a dead connection within ~30 s, so no step can hang silently.
BUDGET_SHORT=30
BUDGET_UPLOAD=600
BUDGET_BUILD=1800

DRY=0
WORK=""

main() {
  local args=()
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) args+=("$arg") ;;
    esac
  done
  [ "${#args[@]}" -ge 1 ] || { usage; exit 2; }

  cd "$REPO_ROOT"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  step "publish ${args[*]} → $HOST ($DOMAIN)$([ "$DRY" = 1 ] && echo ' [dry-run: nothing connects]')"

  case "${args[0]}" in
    site) publish_site; install_nginx; verify site ;;
    connector) publish_connector; install_nginx; verify connector ;;
    all) publish_site; publish_connector; install_nginx; verify all ;;
    rollback) rollback "${args[1]:-}" ;;
    *) usage; exit 2 ;;
  esac
  step "done"
}

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ── website ──────────────────────────────────────────────────────────────────

publish_site() {
  step "website: preflight"
  [ -f "$DRAWIO_WEBAPP/index.html" ] \
    || die "$DRAWIO_WEBAPP/index.html missing — the site image refuses to build without the drawio webapp"
  regenerate_site_downloads

  step "website: packing build context (package*.json, .dockerignore, deps/pptxgenjs, renderer)"
  tar -czf "$WORK/site-src.tgz" \
    --exclude=node_modules --exclude=.git --exclude=__pycache__ --exclude='*.pyc' \
    --exclude='*.log' --exclude='.sxs-*' --exclude=.auth \
    --exclude=deps/pptxgenjs/dist --exclude=deps/pptxgenjs/demos \
    package.json package-lock.json .dockerignore deps/pptxgenjs renderer
  report_tarball "$WORK/site-src.tgz"

  step "website: drawio webapp"
  local drawio_sha remote_sha
  drawio_sha="$(deterministic_tar "$DRAWIO_WEBAPP" | sha256sum | cut -d' ' -f1)"
  info "local drawio sha256 $drawio_sha"
  remote_sha="$(remote_capture "cat $SITE_HOME/drawio.sha256 2>/dev/null || true")"
  if [ "$remote_sha" = "$drawio_sha" ]; then
    info "server already has this drawio webapp — skipping its upload"
  else
    info "server has '${remote_sha:-nothing}' — uploading drawio webapp"
    deterministic_tar "$DRAWIO_WEBAPP" | gzip -1 > "$WORK/drawio.tgz"
    report_tarball "$WORK/drawio.tgz"
    upload "$WORK/drawio.tgz" "set -e; cd $SITE_HOME; rm -rf drawio-webapp.new; mkdir -p drawio-webapp.new;
      tar -xzf - --no-same-owner -C drawio-webapp.new; test -f drawio-webapp.new/index.html;
      rm -rf drawio-webapp; mv drawio-webapp.new drawio-webapp; echo $drawio_sha > drawio.sha256"
  fi

  step "website: uploading build context"
  upload "$WORK/site-src.tgz" "set -e; mkdir -p $SITE_HOME; cd $SITE_HOME; rm -rf src.new; mkdir src.new;
    tar -xzf - --no-same-owner -C src.new"

  step "website: building and starting on the server (output streams below)"
  remote_script "$BUDGET_BUILD" "$SITE_HOME" "$(date -u '+%Y-%m-%d %H:%M UTC')" <<'REMOTE'
set -euo pipefail
home="$1"; build_date="$2"
cd "$home"
test -f drawio-webapp/index.html || { echo "!! $home/drawio-webapp missing — rerun to upload it"; exit 1; }
mkdir -p src.new/deps/drawio/src/main
cp -al drawio-webapp src.new/deps/drawio/src/main/webapp   # hard links: instant, same filesystem
rm -rf src && mv src.new src
cd src/renderer/html2slides/addon-server
if docker image inspect holosweat-sashaslides:latest > /dev/null 2>&1; then
  docker tag holosweat-sashaslides:latest holosweat-sashaslides:previous
  echo "  -> kept the running image as holosweat-sashaslides:previous (rollback target)"
fi
export HOST_PORT=6000 BUILD_DATE="$build_date" BUILDKIT_PROGRESS=plain
# The live stack keeps HOST_PORT / OVERSAMPLING_DEFAULT in $home/.env; compose would look
# for .env next to this compose file instead, so name it.
env_args=(); [ -f "$home/.env" ] && env_args=(--env-file "$home/.env")
docker compose -p sashaslides "${env_args[@]}" build
docker compose -p sashaslides "${env_args[@]}" up -d
docker compose -p sashaslides "${env_args[@]}" ps
REMOTE
}

# The two downloads the old local-Docker deploy regenerated before every build: the
# Claude-bridge zip and the Apps Script add-on bundle that install.sh?doc= pushes.
regenerate_site_downloads() {
  if [ "$DRY" = 1 ]; then
    info "[dry-run] would regenerate $SITE_DIR/public/sasha-bridge.zip and $SITE_DIR/public/addon-bundle/"
    return
  fi
  if [ -f bridge/build_zip.py ]; then
    info "regenerating $SITE_DIR/public/sasha-bridge.zip"
    python3 bridge/build_zip.py "$SITE_DIR/public/sasha-bridge.zip" || info "zip regeneration failed — shipping the committed copy"
  fi
  info "regenerating $SITE_DIR/public/addon-bundle/ (SERVER_ORIGIN=https://$DOMAIN)"
  ( cd renderer/html2slides && SERVER_ORIGIN="https://$DOMAIN" timeout 300 npx tsx browser/build-addon.ts ) \
    || die "add-on bundle build failed"
  mkdir -p "$SITE_DIR/public/addon-bundle"
  for file in Code.gs appsscript.json Sidebar.html; do
    cp "dist/renderer/html2slides/addon/$file" "$SITE_DIR/public/addon-bundle/$file" || die "bundle file missing: $file"
  done
}

# ── connector ────────────────────────────────────────────────────────────────

publish_connector() {
  step "connector: computing build context from server.ts's import graph"
  timeout 60 npx tsx "$CONNECTOR_DEPLOY_DIR/context-files.ts" > "$WORK/connector-files.txt" \
    || die "context-files.ts failed"
  info "$(wc -l < "$WORK/connector-files.txt") files"
  tar -czf "$WORK/connector-src.tgz" -T "$WORK/connector-files.txt"
  report_tarball "$WORK/connector-src.tgz"

  step "connector: secrets and state directories (never overwrites a key)"
  remote_script "$BUDGET_SHORT" "$CONNECTOR_HOME" "$CONNECTOR_UID" <<'REMOTE'
set -euo pipefail
home="$1"; uid="$2"
umask 077
install -d -m 0700 "$home" "$home/secrets"
install -d -m 0700 -o "$uid" -g "$uid" "$home/data"
env_file="$home/secrets/connector.env"
touch "$env_file"; chmod 600 "$env_file"
if grep -q '^SASHA_MASTER_KEY=' "$env_file"; then
  echo "  -> SASHA_MASTER_KEY present (left untouched)"
elif [ -s "$home/data/account-keys.json" ]; then
  echo "!! $home/data/account-keys.json exists but SASHA_MASTER_KEY does not."
  echo "!! A new key cannot unwrap the existing account keys. Restore the key from its backup into $env_file."
  exit 1
else
  echo "SASHA_MASTER_KEY=$(openssl rand -hex 32)" >> "$env_file"
  echo "  -> GENERATED SASHA_MASTER_KEY in $env_file — back it up OFF this server now"
fi
if grep -q '^SASHA_SESSION_SECRET=' "$env_file"; then
  echo "  -> SASHA_SESSION_SECRET present (left untouched)"
else
  echo "SASHA_SESSION_SECRET=$(openssl rand -hex 32)" >> "$env_file"
  echo "  -> generated SASHA_SESSION_SECRET (losing it only signs everyone out of /account)"
fi
REMOTE

  step "connector: OAuth client and identity providers"
  local name
  for name in google_oauth_web.json identity-providers.json; do
    if [ -f ".auth/$name" ]; then
      info "sending .auth/$name"
      run timeout "$BUDGET_SHORT" scp -q "${SSH_OPTS[@]}" ".auth/$name" "$HOST:$CONNECTOR_HOME/secrets/$name.new"
    else
      info ".auth/$name not on this machine — keeping the server's copy"
    fi
  done
  remote_script "$BUDGET_SHORT" "$CONNECTOR_HOME" "$CONNECTOR_UID" <<'REMOTE'
set -euo pipefail
home="$1"; uid="$2"
cd "$home/secrets"
for name in google_oauth_web.json identity-providers.json; do
  [ -f "$name.new" ] || continue
  install -m 0600 -o "$uid" -g "$uid" "$name.new" "$name" && rm -f "$name.new"
  echo "  -> installed $name (0600, uid $uid)"
done
if [ ! -f identity-providers.json ]; then
  echo '{"providers":[{"name":"google"}]}' > identity-providers.json
  chown "$uid:$uid" identity-providers.json; chmod 600 identity-providers.json
  echo "  -> wrote a Google-only identity-providers.json"
fi
test -s google_oauth_web.json || { echo "!! $home/secrets/google_oauth_web.json missing — copy the Web OAuth client there"; exit 1; }
REMOTE

  step "connector: uploading build context"
  upload "$WORK/connector-src.tgz" "set -e; cd $CONNECTOR_HOME; rm -rf src.new; mkdir src.new;
    tar -xzf - --no-same-owner -C src.new; rm -rf src; mv src.new src"

  step "connector: building and starting on the server (output streams below)"
  remote_script "$BUDGET_BUILD" "$CONNECTOR_HOME" "$CONNECTOR_DEPLOY_DIR" <<'REMOTE'
set -euo pipefail
home="$1"; deploy_dir="$2"
cd "$home/src/$deploy_dir"
if docker image inspect sasha-connector:latest > /dev/null 2>&1; then
  docker tag sasha-connector:latest sasha-connector:previous
  echo "  -> kept the running image as sasha-connector:previous (rollback target)"
fi
export SASHA_CONNECTOR_HOME="$home" BUILDKIT_PROGRESS=plain
docker compose -p sasha-connector build
docker compose -p sasha-connector up -d
# Poll the container's own port (observable state) with a 90 s deadline, one line per try.
for attempt in $(seq 1 45); do
  if curl -fsS -m 3 http://127.0.0.1:6100/healthz > /dev/null 2>&1; then
    echo "  -> connector healthy on 127.0.0.1:6100 (try $attempt)"; exit 0
  fi
  echo "  .. waiting for 127.0.0.1:6100/healthz (try $attempt/45)"
  sleep 2
done
echo "!! connector did not become healthy; last log lines:"
docker compose -p sasha-connector logs --tail 40
exit 1
REMOTE
}

# ── nginx ────────────────────────────────────────────────────────────────────

install_nginx() {
  step "nginx: installing $NGINX_CONF as sites-available/$DOMAIN"
  run timeout "$BUDGET_SHORT" scp -q "${SSH_OPTS[@]}" "$NGINX_CONF" "$HOST:/tmp/nginx-sashaslides.conf.new"
  remote_script "$BUDGET_SHORT" "$DOMAIN" "$SITE_HOME" <<'REMOTE'
set -euo pipefail
domain="$1"; home="$2"
test -d "/etc/letsencrypt/live/$domain" \
  || { echo "!! no certificate for $domain — run the certbot step of deploy-sashaslides.sh first"; exit 1; }
site="/etc/nginx/sites-available/$domain"
mkdir -p "$home"
[ -f "$site" ] && cp "$site" "$home/nginx-sashaslides.conf.previous"
cp /tmp/nginx-sashaslides.conf.new "$site"
ln -sf "$site" "/etc/nginx/sites-enabled/$domain"
[ -f /etc/nginx/proxy_params ] || printf '%s\n' \
  'proxy_set_header Host $http_host;' \
  'proxy_set_header X-Real-IP $remote_addr;' \
  'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  'proxy_set_header X-Forwarded-Proto $scheme;' > /etc/nginx/proxy_params
if ! nginx -t; then
  echo "!! nginx -t failed — restoring the previous site file, NOT reloading"
  if [ -f "$home/nginx-sashaslides.conf.previous" ]; then cp "$home/nginx-sashaslides.conf.previous" "$site"; fi
  exit 1
fi
systemctl reload nginx
echo "  -> nginx reloaded"
REMOTE
}

# ── verification ─────────────────────────────────────────────────────────────

verify() {
  local target="$1" failures=0
  step "verify: https://$DOMAIN"
  if [ "$target" != connector ]; then
    check "/healthz" 200 "" || failures=$((failures + 1))
    check "/privacy" 200 "" || failures=$((failures + 1))
  fi
  if [ "$target" != site ]; then
    check "/connector/healthz" 200 '"status"' || failures=$((failures + 1))
    check "/account" 200 "" || failures=$((failures + 1))
    check "/.well-known/oauth-protected-resource/mcp" 200 '"resource"' || failures=$((failures + 1))
  fi
  [ "$failures" = 0 ] || die "$failures check(s) failed"
}

# One line per check: ok/FAIL, status, path. A non-empty needle must appear in the body.
check() {
  local path="$1" want="$2" needle="$3" url="https://$DOMAIN$1" status
  if [ "$DRY" = 1 ]; then
    info "[dry-run] would check GET $url → $want${needle:+, body contains $needle}"
    return 0
  fi
  status="$(curl -sS -m 8 -o "$WORK/body" -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  if [ "$status" = "$want" ] && { [ -z "$needle" ] || grep -q "$needle" "$WORK/body"; }; then
    echo "  ok   $status $path"
    return 0
  fi
  echo "  FAIL $status $path (want $want${needle:+ with $needle})"
  return 1
}

# ── rollback ─────────────────────────────────────────────────────────────────

rollback() {
  local target="$1"
  case "$target" in
    site)
      step "rollback: website → holosweat-sashaslides:previous"
      remote_script "$BUDGET_SHORT" "$SITE_HOME" <<'REMOTE'
set -euo pipefail
cd "$1/src/renderer/html2slides/addon-server"
docker image inspect holosweat-sashaslides:previous > /dev/null || { echo "!! no previous image"; exit 1; }
docker tag holosweat-sashaslides:previous holosweat-sashaslides:latest
HOST_PORT=6000 docker compose -p sashaslides up -d --no-build --force-recreate
REMOTE
      verify site ;;
    connector)
      step "rollback: connector → sasha-connector:previous (data/ and secrets/ are kept)"
      remote_script "$BUDGET_SHORT" "$CONNECTOR_HOME" "$CONNECTOR_DEPLOY_DIR" <<'REMOTE'
set -euo pipefail
cd "$1/src/$2"
docker image inspect sasha-connector:previous > /dev/null || { echo "!! no previous image"; exit 1; }
docker tag sasha-connector:previous sasha-connector:latest
SASHA_CONNECTOR_HOME="$1" docker compose -p sasha-connector up -d --no-build --force-recreate
REMOTE
      verify connector ;;
    *) die "rollback needs a target: site or connector" ;;
  esac
}

# ── plumbing ─────────────────────────────────────────────────────────────────

step() { echo "==> $*"; }
info() { echo "  -> $*"; }
die() { echo "!! $*" >&2; exit 1; }

# Runs a local command, or prints it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] $*"
    return 0
  fi
  "$@"
}

# Runs the script on stdin remotely as `bash -s -- <args>`, or prints it under --dry-run.
remote_script() {
  local budget="$1"; shift
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] timeout $budget ssh $HOST bash -s -- $(printf '%q ' "$@") <<script"
    sed 's/^/  |   /'
    return 0
  fi
  # ssh joins its arguments into one string for the remote shell, so quote each one.
  timeout "$budget" ssh "${SSH_OPTS[@]}" "$HOST" "bash -s -- $(printf '%q ' "$@")"
}

# Prints a remote command's stdout. Under --dry-run prints nothing (empty result).
remote_capture() {
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] timeout $BUDGET_SHORT ssh $HOST '$1'" >&2
    return 0
  fi
  timeout "$BUDGET_SHORT" ssh "${SSH_OPTS[@]}" "$HOST" "$1"
}

# Streams a local tarball into a remote command with a live byte count (dd status=progress).
upload() {
  local file="$1" command="$2"
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] dd if=$(basename "$file") status=progress | timeout $BUDGET_UPLOAD ssh $HOST '$command'"
    return 0
  fi
  info "sending $(bytes "$file") bytes"
  dd if="$file" bs=1M status=progress | timeout "$BUDGET_UPLOAD" ssh "${SSH_OPTS[@]}" "$HOST" "$command"
  info "upload finished"
}

# A tar stream whose bytes depend only on the files, so its sha256 identifies the content.
deterministic_tar() {
  tar -cf - --sort=name --mtime='2000-01-01 00:00Z' --owner=0 --group=0 --numeric-owner \
    --exclude=.git -C "$1" .
}

report_tarball() {
  info "$(basename "$1"): $(tar -tzf "$1" | grep -vc '/$') files, $(bytes "$1") bytes compressed"
}

bytes() { wc -c < "$1" | tr -d ' '; }

main "$@"
