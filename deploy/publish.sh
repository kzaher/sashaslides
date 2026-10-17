#!/usr/bin/env bash
# Publish sashaslides.com (the website) and/or the Sasha Slides remote MCP connector to the
# holosweat server, building the images ON THE SERVER. Needs only ssh, scp, tar, gzip, dd
# and node on this machine: no Docker, no rsync, no registry tunnel.
#
#   deploy/publish.sh [--dry-run] site|connector|all|videos
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
# DEPLOY_DOMAIN (sashaslides.com), DEPLOY_ACME_EMAIL (certbot registration, used only when the
# domain has no certificate yet), DEPLOY_KEY (unset: ssh uses its agent, e.g. a forwarded
# SSH_AUTH_SOCK; set it to force one key file with IdentitiesOnly).
set -euo pipefail

HOST="${DEPLOY_HOST:-root@78.46.91.218}"
# The dedicated deploy key in .auth/ (git-ignored, survives container rebuilds) when present, so a
# deploy does not depend on an SSH agent forwarded by an editor; DEPLOY_KEY overrides, "" forces the agent.
KEY="${DEPLOY_KEY-$( [ -f "$(dirname "$0")/../.auth/deploy_ed25519" ] && echo "$(cd "$(dirname "$0")/.." && pwd)/.auth/deploy_ed25519" )}"
DOMAIN="${DEPLOY_DOMAIN:-sashaslides.com}"
ACME_EMAIL="${DEPLOY_ACME_EMAIL:-krunoslav.zaher@gmail.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="renderer/html2slides/addon-server"
CONNECTOR_DEPLOY_DIR="mcp/sasha-slides/deploy"
NGINX_CONF="$SITE_DIR/deploy/nginx-sashaslides.conf"
DRAWIO_WEBAPP="deps/drawio/src/main/webapp"
SITE_HOME="/root/sashaslides"
# Trees under renderer/ that the site image never builds from nor serves: the e2e fixture corpus
# and the bug_solving scaffolding (13 MB of the 14 MB context). The image builds only from
# addon-server's own build and server.ts's import graphs. .dockerignore lists the same.
SITE_EXCLUDES=(renderer/html2slides/e2e renderer/structured-prompts)
# Sources outside renderer/ that the site image builds from (its Dockerfile COPYs exactly these).
SITE_SHARED_SOURCES=(mcp/sasha-slides/converter mcp/sasha-slides/engine/src/contracts mcp/sasha-slides/engine/src/shared
  mcp/sasha-slides/engine/src/web/parsing mcp/sasha-slides/google-slides/insert-html-contract.ts
  mcp/sasha-slides/google-slides/slides-client.ts)
CONNECTOR_HOME="/root/sasha-connector"
# The connector's container user (mcp/sasha-slides/deploy/Dockerfile). Not 1000: on the
# server uid 1000 is a login user, who would then own the secrets.
CONNECTOR_UID="10100"
# Secrets copied from .auth/ when present and mounted into the connector by the same names
# (mcp/sasha-slides/deploy/docker-compose.yml). apple-signin.p8 is the Sign in with Apple key;
# mail-sender.json is the Gmail sender for email sign-in; with a service account it names
# gmail-service-account.json, the domain-wide-delegation key it signs with.
# There is no comment-bot.json any more: the comment bot acts as each signed-in user with their own
# Google grant (mcp/sasha-slides/comment-bot/owner-drive.ts), and the remote step below deletes a
# leftover one. Its picker page reads SASHA_PICKER_API_KEY from connector.env (set by hand).
SECRET_FILES="google_oauth_web.json identity-providers.json apple-signin.p8 mail-sender.json gmail-service-account.json"
# The server's host keys are pinned in the repo, so a rebuilt container (empty ~/.ssh) deploys
# without a prompt and still refuses an impostor. Refresh with: ssh-keyscan 78.46.91.218 > deploy/known_hosts
KNOWN_HOSTS="$(cd "$(dirname "$0")" && pwd)/known_hosts"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=3
          -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
# With a key, ignore any forwarded agent: a hung editor agent socket makes ssh wait forever even
# with -i (measured 2026-10-12).
if [ -n "$KEY" ]; then SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes); export SSH_AUTH_SOCK=; fi

# Wall-clock budgets (seconds). Each remote step is killed past its budget, and the ssh
# keepalive above kills a dead connection within ~30 s, so no step can hang silently.
BUDGET_SHORT=30
# install_nginx: two certbot attempts of at most 120 s each on a first deploy, otherwise seconds.
BUDGET_CERT=300
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
    videos) publish_videos; install_nginx; verify videos ;;
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

  step "website: packing build context (package*.json, .dockerignore, deps/pptxgenjs, renderer, the converter)"
  # The developer page bundles the product converter and the deck API contracts it shares with the
  # connector: the same paths the site Dockerfile COPYs (addon-server/dev/build.test.ts checks them).
  tar -czf "$WORK/site-src.tgz" \
    "${SITE_EXCLUDES[@]/#/--exclude=}" \
    --exclude=node_modules --exclude=.git --exclude=__pycache__ --exclude='*.pyc' \
    --exclude='*.log' --exclude='.sxs-*' --exclude=.auth \
    --exclude=deps/pptxgenjs/dist --exclude=deps/pptxgenjs/demos \
    package.json package-lock.json .dockerignore deps/pptxgenjs renderer \
    "${SITE_SHARED_SOURCES[@]}"
  report_tarball "$WORK/site-src.tgz"
  local excluded
  for excluded in "${SITE_EXCLUDES[@]}"; do
    ! tar -tzf "$WORK/site-src.tgz" | grep -q "^$excluded/" || die "site-src.tgz still contains $excluded/"
  done
  info "site-src.tgz excludes ${SITE_EXCLUDES[*]}"

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

# ── connector ────────────────────────────────────────────────────────────────

publish_connector() {
  # The deck web application is read from disk at runtime (engine/dist/web), so it is built here,
  # before context-files.ts lists it; the image never builds it (no esbuild, no React in it).
  step "connector: building the deck web application (engine/dist/web)"
  run timeout "$BUDGET_UPLOAD" bash -c 'cd mcp/sasha-slides/engine && npm ci --no-audit --no-fund && npm run -s build:web'
  if [ "$DRY" != 1 ]; then
    [ -f mcp/sasha-slides/engine/dist/web/manifest.json ] \
      || die "mcp/sasha-slides/engine/dist/web/manifest.json missing after build:web — /decks would answer 503"
  fi

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
# Defect reports (--reports /data/reports): stored by the connector, readable at /account/reports only
# by the verified addresses in SASHA_ADMIN_EMAILS, which is set by hand and never generated.
install -d -m 0700 -o "$uid" -g "$uid" "$home/data/reports"
if grep -q '^SASHA_ADMIN_EMAILS=.' "$env_file"; then
  echo "  -> SASHA_ADMIN_EMAILS present (defect reports readable at /account/reports)"
else
  echo "  -> SASHA_ADMIN_EMAILS not set: defect reports are stored but nobody can read them; add SASHA_ADMIN_EMAILS=<address> to $env_file"
fi
REMOTE

  step "connector: OAuth client and identity providers"
  local name
  for name in $SECRET_FILES; do
    if [ -f ".auth/$name" ]; then
      info "sending .auth/$name"
      run timeout "$BUDGET_SHORT" scp -q "${SSH_OPTS[@]}" ".auth/$name" "$HOST:$CONNECTOR_HOME/secrets/$name.new"
    else
      info ".auth/$name not on this machine — keeping the server's copy"
    fi
  done
  remote_script "$BUDGET_SHORT" "$CONNECTOR_HOME" "$CONNECTOR_UID" "$SECRET_FILES" <<'REMOTE'
set -euo pipefail
home="$1"; uid="$2"; names="$3"
cd "$home/secrets"
for name in $names; do
  if [ -f "$name.new" ]; then
    install -m 0600 -o "$uid" -g "$uid" "$name.new" "$name" && rm -f "$name.new"
    echo "  -> installed $name (0600, uid $uid)"
  elif [ ! -e "$name" ]; then
    # Every secret is bind-mounted by name, and Docker turns a missing source into a DIRECTORY.
    # An empty file is harmless: it is only read when the providers file names it.
    install -m 0600 -o "$uid" -g "$uid" /dev/null "$name"
    echo "  -> created an empty placeholder $name"
  fi
done
# The shared comment-bot account's refresh token is obsolete: never leave a Drive grant lying around.
if [ -e comment-bot.json ] || [ -e comment-bot.json.new ]; then
  rm -f comment-bot.json comment-bot.json.new
  echo "  -> removed the obsolete comment-bot.json (the comment bot now acts as each signed-in user)"
fi
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
# Always restart: the secrets (identity providers, OAuth client) are read once at startup, so an
# unchanged image left running kept the old sign-in providers (measured 2026-10-13).
docker compose -p sasha-connector up -d --force-recreate
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
  remote_script "$BUDGET_CERT" "$DOMAIN" "$SITE_HOME" "$ACME_EMAIL" <<'REMOTE'
set -euo pipefail
domain="$1"; home="$2"; acme_email="$3"
# First deploy only: obtain the certificate the site file names, before installing that file
# (nginx -t would reject it otherwise). certbot's own timer renews it afterwards.
if [ ! -d "/etc/letsencrypt/live/$domain" ]; then
  echo "  -> certbot: obtaining a certificate for $domain"
  timeout 120 certbot certonly --nginx --non-interactive --agree-tos -m "$acme_email" -d "$domain" || {
    echo "  !! certbot --nginx failed; retrying with --webroot /var/www/html"
    mkdir -p /var/www/html
    timeout 120 certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos -m "$acme_email" -d "$domain"
  }
  test -d "/etc/letsencrypt/live/$domain" || { echo "!! certbot produced no certificate for $domain"; exit 1; }
else
  echo "  -> certificate for $domain present (certbot renews it on its own timer)"
fi
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
  if [ "$target" = videos ]; then
    for file in "$VIDEO_DIR"/*.mp4; do
      [ -f "$file" ] && { check "/videos/$(basename "$file")" 200 "" || failures=$((failures + 1)); }
    done
    [ "$failures" = 0 ] || die "$failures check(s) failed"
    return 0
  fi
  if [ "$target" != site ]; then
    check "/connector/healthz" 200 '"status"' || failures=$((failures + 1))
    check "/account" 200 "" || failures=$((failures + 1))
    # Defect reports: signed out, the admin pages send the browser to sign in; an unknown id reaches the intake.
    check "/account/reports" 303 "" || failures=$((failures + 1))
    check "/v1/reports/rep_00000000000000000000000000" 404 '"not-found"' || failures=$((failures + 1))
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

# ── walkthrough videos ───────────────────────────────────────────────────────

# The redacted walkthroughs from docs/connect/recording/record.ts. They are git-ignored, so they go
# straight to disk on the server (nginx serves /videos/ from there), never into an image.
VIDEO_DIR="mcp/sasha-slides/docs/connect/recording/recordings"
VIDEO_HOME="/var/www/sashaslides-videos"

publish_videos() {
  step "videos: uploading $VIDEO_DIR/*.mp4 to $VIDEO_HOME"
  local found=0 file
  for file in "$VIDEO_DIR"/*.mp4; do
    [ -f "$file" ] || continue
    found=1
    info "$(basename "$file"): $(bytes "$file") bytes"
    run timeout "$BUDGET_SHORT" ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $VIDEO_HOME"
    run timeout 120 scp -q "${SSH_OPTS[@]}" "$file" "$HOST:$VIDEO_HOME/$(basename "$file").new"
    run timeout "$BUDGET_SHORT" ssh "${SSH_OPTS[@]}" "$HOST" \
      "chmod 644 $VIDEO_HOME/$(basename "$file").new && mv $VIDEO_HOME/$(basename "$file").new $VIDEO_HOME/$(basename "$file")"
  done
  [ "$found" = 1 ] || die "no videos in $VIDEO_DIR — record them first (docs/connect/README.md)"
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
