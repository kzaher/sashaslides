#!/usr/bin/env bash
set -euo pipefail

HTML_DIR="${1:?Usage: rate-slides.sh <html-dir> [presentation-id]}"
PRES_ID="${2:-}"
PORT=3456
RATE_DIR="/tmp/rate-slides-$$"
RENDERER_DIR="/workspaces/sashaslides/renderer"
H2S_DIR="$RENDERER_DIR/html2slides"
FILTERED="$RENDERER_DIR/structured-prompts/bug_solving/scripts/filtered-rating-server.ts"

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
  TITLE="$(basename "$(dirname "$HTML_DIR")")/$(basename "$HTML_DIR")"
  CONVERT_LOG="/tmp/rate-slides-convert-$$.log"
  npx tsx convert-pptx.ts "$HTML_DIR" --title "$TITLE" 2>&1 | tee "$CONVERT_LOG"
  PRES_ID=$(grep -oE 'presentation/d/[A-Za-z0-9_-]+' "$CONVERT_LOG" | head -1 | cut -d/ -f3)
  [ -n "$PRES_ID" ] || { echo "❌ Could not extract presentation ID from converter output"; exit 1; }
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

# 5. Launch the unified SxS rating server (filtered-rating-server — the
#    single rating UI: 🔍 magnifier, annotation canvas, client-side diff
#    overlay). NO --goldens-dir here: rate-slides reviews arbitrary html
#    dirs, so it never blesses goldens (that's serve-sxs.sh's basics flow).
SLIDES="$(ls "$RATE_DIR"/originals/slide_*.png 2>/dev/null | xargs -n1 basename | sed 's/\.png$//' | sort | paste -sd, -)"
[ -n "$SLIDES" ] || { echo "❌ no slide_*.png in $RATE_DIR/originals"; exit 1; }
ANALYSIS="$RATE_DIR/analysis.md"; echo "(rate-slides — no per-slide analysis)" > "$ANALYSIS"
mkdir -p "$RATE_DIR/diffs"
# manifest.json → Google-Slides deep links in the UI.
printf '{"presentation_id":"%s"}\n' "$PRES_ID" > "$RATE_DIR/slides/manifest.json"

echo "==> Launching unified SxS rating UI at http://localhost:$PORT"
exec npx tsx "$FILTERED" \
  --port "$PORT" \
  --slides "$SLIDES" \
  --analysis "$ANALYSIS" \
  --diffs "$RATE_DIR/diffs" \
  --thumbnails "$RATE_DIR/slides" \
  --originals "$RATE_DIR/originals" \
  --html-dir "$HTML_DIR" \
  --ratings-file "$RATE_DIR/ratings.json" \
  --task-title "rate-slides — $(basename "$HTML_DIR")"
