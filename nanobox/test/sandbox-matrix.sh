#!/usr/bin/env bash
# The sandbox measurement matrix: for each CLI a COLD run (persistent tree + caches wiped, HTTP cache
# off: first visit — downloads node + the CLI from the vendors) then a WARM run (second visit: nothing
# downloaded), in headless Chrome (CDP :9222) against the shared server on :8093.
#   setsid ./test/sandbox-matrix.sh [claude codex agy] > work/sandbox-matrix.log   (ends with MATRIX-DONE)
# -> web/results/sandbox-<cli>-{cold,warm}.{json,png}, then tools/sandbox-report.mjs -> web/results/sandbox-<cli>.json + the table
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
CLIS=("$@"); [ ${#CLIS[@]} -eq 0 ] && CLIS=(claude codex agy)
for cli in "${CLIS[@]}"; do
  echo "=== $cli cold ($(date +%T))"; timeout 300 node test/e2e-sandbox.mjs --cli "$cli" --cold --timeout 240 2>&1 | grep -v "install:fetched\|vm:image\|vm:fs" | tail -25
  sleep 3
  echo "=== $cli warm ($(date +%T))"; timeout 300 node test/e2e-sandbox.mjs --cli "$cli" --timeout 240 2>&1 | grep -v "install:fetched\|vm:image\|vm:fs" | tail -25
  sleep 3
done
node tools/sandbox-report.mjs "${CLIS[@]}"
echo MATRIX-DONE
