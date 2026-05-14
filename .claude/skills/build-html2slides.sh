#!/usr/bin/env bash
# Builds the self-contained renderer/html2slides/browser/html2slides.html
# (single-file drag-drop converter), then serves it on http://localhost:PORT
# so the user can open it directly. Run after any change to extract-dom.ts
# or convert-pptx-lib.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=${HTML2SLIDES_PORT:-3500}
SERVE_DIR="$PWD/renderer/html2slides/browser"
LOG="/tmp/html2slides-serve.log"

npx tsx renderer/html2slides/browser/build.ts

# Kill any existing server on this port (idempotent re-runs).
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 0.2

# Background static server. Python's http.server is universally available
# in this devcontainer; we serve only the browser/ dir so the HTML is the
# only thing exposed.
nohup python3 -m http.server "$PORT" --directory "$SERVE_DIR" \
  > "$LOG" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

# Wait briefly for bind, then sanity-check the URL.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null "http://localhost:${PORT}/html2slides.html"; then break; fi
  sleep 0.1
done

echo ""
echo "✓ html2slides bundle served:"
echo "    http://localhost:${PORT}/html2slides.html"
echo "  (server PID $SERVER_PID, log $LOG; HTML2SLIDES_PORT=N to override)"
