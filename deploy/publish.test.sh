#!/usr/bin/env bash
# deploy/publish.sh --dry-run must connect to nothing, yet show every remote step and the
# upload sizes. ssh and scp are replaced by stubs that record any call and fail.
#
#   bash deploy/publish.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUBS="$(mktemp -d)"
trap 'rm -rf "$STUBS"' EXIT
for tool in ssh scp; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/calls"\nexit 99\n' "$tool" "$STUBS" > "$STUBS/$tool"
  chmod +x "$STUBS/$tool"
done

failures=0
expect() {
  local label="$1" pattern="$2" text="$3"
  if grep -qE -- "$pattern" <<< "$text"; then echo "ok   $label"; return; fi
  echo "FAIL $label (no line matching: $pattern)"; failures=$((failures + 1))
}
reject() {
  local label="$1" pattern="$2" text="$3"
  if ! grep -qE -- "$pattern" <<< "$text"; then echo "ok   $label"; return; fi
  echo "FAIL $label (unexpected line matching: $pattern)"; failures=$((failures + 1))
}

for target in site connector all; do
  output="$(PATH="$STUBS:$PATH" timeout 25 bash "$HERE/publish.sh" --dry-run "$target" 2>&1)" \
    || { echo "FAIL $target: dry-run exited non-zero"; echo "$output"; exit 1; }
  if [ "$target" != connector ]; then
    expect "$target: site tarball size" 'site-src\.tgz: [0-9]+ files, [0-9]+ bytes' "$output"
    expect "$target: drawio checked by sha256" 'local drawio sha256 [0-9a-f]{64}' "$output"
    expect "$target: compose build for the site" 'docker compose -p sashaslides .*build$' "$output"
    expect "$target: checks /privacy" 'check GET https://[^ ]+/privacy' "$output"
    # The site image neither builds from nor serves the e2e corpus or bug_solving (13 MB of 14).
    expect "$target: site tarball excludes e2e and structured-prompts" \
      'site-src\.tgz excludes renderer/html2slides/e2e renderer/structured-prompts$' "$output"
    # The bridge zip and the old html2slides add-on bundle were retired on 2026-10-17.
    reject "$target: no legacy downloads regenerated" 'sasha-bridge\.zip|addon-bundle|build-addon' "$output"
  fi
  if [ "$target" != site ]; then
    expect "$target: connector tarball size" 'connector-src\.tgz: [0-9]+ files, [0-9]+ bytes' "$output"
    expect "$target: builds the deck web application before packing" 'npm run -s build:web' "$output"
    expect "$target: master key only generated when absent" "grep -q '\^SASHA_MASTER_KEY=' " "$output"
    expect "$target: refuses a new key over existing account keys" 'A new key cannot unwrap' "$output"
    expect "$target: checks the protected-resource document" 'oauth-protected-resource/mcp' "$output"
    # Secrets are read at startup: an unchanged image must still restart on new secrets (2026-10-13).
    expect "$target: connector restarts even when its image is unchanged" 'docker compose -p sasha-connector up -d --force-recreate' "$output"
    # Defect reports: a storage directory owned by the container user, the admin allow-list checked
    # (never generated), and both routes verified.
    expect "$target: reports directory for the container user" 'install -d -m 0700 -o "\$uid" -g "\$uid" "\$home/data/reports"' "$output"
    expect "$target: admin allow-list only reported, never generated" "grep -q '\^SASHA_ADMIN_EMAILS=\.' " "$output"
    expect "$target: checks the report admin pages" 'check GET https://[^ ]+/account/reports → 303' "$output"
    expect "$target: checks the report intake" 'check GET https://[^ ]+/v1/reports/rep_0+ → 404' "$output"
  fi
  # First deploy obtains the certificate before the site file that names it is installed.
  expect "$target: certbot only when the certificate is missing" 'if \[ ! -d "/etc/letsencrypt/live/\$domain" \]; then' "$output"
  expect "$target: certbot via nginx" 'certbot certonly --nginx --non-interactive --agree-tos -m "\$acme_email" -d "\$domain"' "$output"
  expect "$target: certbot before the site file is installed" '^certbot$' \
    "$(grep -oE -m1 'certbot certonly|cp /tmp/nginx-sashaslides\.conf\.new' <<< "$output" | cut -d' ' -f1)"
  expect "$target: nginx -t before reload" 'if ! nginx -t; then' "$output"
  expect "$target: reload after the test" 'systemctl reload nginx' "$output"
done

dockerignore="$(cat "$HERE/../.dockerignore")"
expect ".dockerignore: e2e corpus" '^renderer/html2slides/e2e$' "$dockerignore"
expect ".dockerignore: structured-prompts" '^renderer/structured-prompts$' "$dockerignore"

if [ -s "$STUBS/calls" ]; then
  echo "FAIL dry-run invoked the network:"; cat "$STUBS/calls"; failures=$((failures + 1))
else
  echo "ok   dry-run made no ssh/scp call"
fi
[ "$failures" = 0 ] || { echo "$failures failure(s)"; exit 1; }
echo "all passed"
