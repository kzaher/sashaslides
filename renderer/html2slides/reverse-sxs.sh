#!/usr/bin/env bash
# reverse-sxs.sh — run the REVERSE round trip (Google Slides -> Sasha import -> HTML -> screenshot)
# for the basic set, the complex set and the test deck, into /workspaces/sashaslides/.sxs-reverse.
#
# Usage: ./reverse-sxs.sh [reverse-roundtrip.ts arguments...]
#   ./reverse-sxs.sh                              all sets, reusing uploads/thumbnails already fetched
#   ./reverse-sxs.sh --sets deck                  one set
#   ./reverse-sxs.sh --fresh-upload               re-run the forward conversion + upload first
#   ./reverse-sxs.sh --presentation basic=<id>    measure an existing forward presentation
#
# The engine's renderer is .tsx with the automatic JSX runtime. tsx applies a tsconfig only to the
# files that tsconfig includes, so it runs with the ENGINE's own tsconfig: the engine's sources get
# exactly the settings they are built with, and these scripts (not included there) tsx's defaults.
# That is the only reason this wrapper exists. Typecheck: npx tsc -p reverse/tsconfig.json
# Rate the results with the SxS rating server pointed at .sxs-reverse/<set> (reverse) or
# .sxs-reverse/<set>/round-trip (whole trip). Goldens are written ONLY by the user's "Good" click.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
# Screenshots are taken in the headless Chrome on :9222 (reverse/chrome-capture.ts says why it
# must be headless); it dies with the container, so start it when it is absent.
if ! curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "▶ starting headless Chrome on :9222 …"
  setsid google-chrome-stable --headless=new --remote-debugging-port=9222 --no-sandbox \
    --user-data-dir=/tmp/chrome-cdp >/tmp/chrome.log 2>&1 < /dev/null & disown
  for _ in $(seq 1 25); do curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 1; done
fi
exec npx tsx --tsconfig ../../mcp/sasha-slides/engine/tsconfig.json reverse-roundtrip.ts "$@"
