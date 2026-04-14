#!/usr/bin/env bash
set -euo pipefail

HTML_DIR="${1:?Usage: rate-slides.sh <html-dir> [presentation-id]}"
PRES_ID="${2:-}"
PORT=3456
RATE_DIR="/tmp/rate-slides-$$"
RENDERER_DIR="/workspaces/sashaslides/analysis/renderer"
H2S_DIR="$RENDERER_DIR/html2slides"

# Resolve html dir
HTML_DIR="$(cd "$HTML_DIR" && pwd)"

# 1. Screenshot original HTML slides
echo "==> Screenshotting original HTML slides..."
SCREENSHOTS_DIR="$HTML_DIR/screenshots"
if [ ! -d "$SCREENSHOTS_DIR" ] || [ "$(ls "$SCREENSHOTS_DIR"/*.png 2>/dev/null | wc -l)" -eq 0 ]; then
  SCREENSHOTS_DIR="/tmp/rate-originals-$$"
  mkdir -p "$SCREENSHOTS_DIR"
  cd "$RENDERER_DIR"
  npx tsx /workspaces/sashaslides/analysis/scripts/screenshot-html-slides.ts "$HTML_DIR" "$SCREENSHOTS_DIR"
fi

# 2. Get Slides API thumbnails
echo "==> Getting Slides API thumbnails..."
THUMBS_DIR="/tmp/rate-thumbs-$$"
mkdir -p "$THUMBS_DIR"

if [ -z "$PRES_ID" ]; then
  echo "  No presentation ID provided, running converter..."
  cd "$H2S_DIR"
  # Extract title from dir name
  TITLE="$(basename "$(dirname "$HTML_DIR")")/$(basename "$HTML_DIR")"
  OUTPUT=$(npx tsx convert-slides-api.ts "$HTML_DIR" --title "$TITLE" 2>&1)
  echo "$OUTPUT"
  PRES_ID=$(echo "$OUTPUT" | grep "ID:" | head -1 | sed 's/.*ID: //')
  echo "  Created presentation: $PRES_ID"
fi

cd "$H2S_DIR"
npx tsx export-thumbs.ts "$PRES_ID" "$THUMBS_DIR"

# 3. Set up rating directory
mkdir -p "$RATE_DIR/originals" "$RATE_DIR/slides"
cp "$SCREENSHOTS_DIR"/slide_*.png "$RATE_DIR/originals/" 2>/dev/null || true
cp "$THUMBS_DIR"/slide_*.png "$RATE_DIR/slides/" 2>/dev/null || true

ORIG_COUNT=$(ls "$RATE_DIR/originals/"*.png 2>/dev/null | wc -l)
SLIDES_COUNT=$(ls "$RATE_DIR/slides/"*.png 2>/dev/null | wc -l)
echo "==> $ORIG_COUNT originals, $SLIDES_COUNT slides thumbnails"

# 4. Kill any existing rating server on the port
lsof -ti:$PORT 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 0.5

# 5. Launch rating server
echo "==> Launching rating server at http://localhost:$PORT"
cd "$H2S_DIR"
exec npx tsx rating-server.ts "$RATE_DIR" --port "$PORT"
