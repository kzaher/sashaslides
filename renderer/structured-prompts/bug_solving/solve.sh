#!/usr/bin/env bash
# solve.sh — build + launch the bug_solving cluster solver end-to-end.
# Run from the repo root via:  npm run solve            (fresh)
#                              npm run solve -- --clean  (discard prior overlay state)
#                              npm run solve -- --continue (resume merging persisted overlays)
#
# Solves the clusters in clusters.ts (regenerate with `npm run solve:clusters`).
# Each fork solves in a JAILED, copy-free overlay sandbox; boots its own rating UI
# and BLOCKS for your good/bad; green forks go through the LLM merge + regression
# gate. Overlays PERSIST — on a re-run the engine makes you pick --clean/--continue.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
BUNDLE="structured-prompting/dist/main-scaffolding.mjs"   # build + launch the SAME path

# 1. Chrome on :9222 (rendering needs it) — start if absent.
if ! curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "▶ starting headless Chrome on :9222 …"
  setsid google-chrome-stable --headless=new --remote-debugging-port=9222 --no-sandbox \
    --user-data-dir=/tmp/chrome-cdp >/tmp/chrome.log 2>&1 < /dev/null & disown
  for i in $(seq 1 25); do curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 1; done
fi
curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 || { echo "❌ Chrome not on :9222"; exit 1; }

# 2. Build the bundle (into structured-prompting/dist, where preact + the workspace lib resolve).
echo "▶ building $BUNDLE …"
npx tsx structured-prompting/build.ts renderer/structured-prompts/bug_solving/main-scaffolding.ts "$BUNDLE"

# 3. Show the clusters actually baked into the bundle (catch a stale build).
echo "▶ clusters in bundle:"
grep -oE 'slide-[0-9]+-[a-z-]+' "$BUNDLE" | sort -u | sed 's/^/    /' || true

# 4. Launch (foreground so you see the monitor + rating URLs; Ctrl-C to stop).
#    Env defaults target the complex fixture set + Opus; override by exporting first.
echo "▶ launching solver (Ctrl-C to stop) …"
BUG_SOLVING_MODEL="${BUG_SOLVING_MODEL:-opus}" \
BUG_SOLVING_SXS_DIR="${BUG_SOLVING_SXS_DIR:-/tmp/sxs-complex}" \
BUG_SOLVING_RATINGS_JSON="${BUG_SOLVING_RATINGS_JSON:-/tmp/sxs-complex/ratings.json}" \
BUG_SOLVING_FIXTURES_DIR="${BUG_SOLVING_FIXTURES_DIR:-renderer/html2slides/e2e/fixtures}" \
  exec node "$BUNDLE" --engine=claude "$@"
