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

for target in site connector all; do
  output="$(PATH="$STUBS:$PATH" timeout 25 bash "$HERE/publish.sh" --dry-run "$target" 2>&1)" \
    || { echo "FAIL $target: dry-run exited non-zero"; echo "$output"; exit 1; }
  if [ "$target" != connector ]; then
    expect "$target: site tarball size" 'site-src\.tgz: [0-9]+ files, [0-9]+ bytes' "$output"
    expect "$target: drawio checked by sha256" 'local drawio sha256 [0-9a-f]{64}' "$output"
    expect "$target: compose build for the site" 'docker compose -p sashaslides .*build$' "$output"
    expect "$target: checks /privacy" 'check GET https://[^ ]+/privacy' "$output"
  fi
  if [ "$target" != site ]; then
    expect "$target: connector tarball size" 'connector-src\.tgz: [0-9]+ files, [0-9]+ bytes' "$output"
    expect "$target: master key only generated when absent" "grep -q '\^SASHA_MASTER_KEY=' " "$output"
    expect "$target: refuses a new key over existing account keys" 'A new key cannot unwrap' "$output"
    expect "$target: checks the protected-resource document" 'oauth-protected-resource/mcp' "$output"
  fi
  expect "$target: nginx -t before reload" 'if ! nginx -t; then' "$output"
  expect "$target: reload after the test" 'systemctl reload nginx' "$output"
done

if [ -s "$STUBS/calls" ]; then
  echo "FAIL dry-run invoked the network:"; cat "$STUBS/calls"; failures=$((failures + 1))
else
  echo "ok   dry-run made no ssh/scp call"
fi
[ "$failures" = 0 ] || { echo "$failures failure(s)"; exit 1; }
echo "all passed"
