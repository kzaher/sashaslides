#!/usr/bin/env bash
set -euo pipefail

# html2googleslides — Convert HTML slides to Google Slides with fidelity tracking
#
# Usage:
#   bash run.sh <html-dir> [output-dir]
#   bash run.sh eval/results/sequoia-template/candidate_2/reconstruction
#
# Steps:
#   1. Convert HTML → .pptx (DOM extraction + pptxgenjs)
#   2. Screenshot originals for comparison
#   3. Upload .pptx to Drive, open as Slides
#   4. Screenshot Google Slides result
#   5. Launch rating server for SxS comparison

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HTML_DIR="${1:?Usage: run.sh <html-dir> [output-dir]}"
OUTPUT_DIR="${2:-$HTML_DIR/html2slides_output}"

mkdir -p "$OUTPUT_DIR/originals" "$OUTPUT_DIR/slides"

cd "$SCRIPT_DIR"

# Ensure deps
if [ ! -d "$SCRIPT_DIR/../../renderer/node_modules" ]; then
  cd "$SCRIPT_DIR/../../renderer" && npm install && cd "$SCRIPT_DIR"
fi

# Step 1: Convert HTML → .pptx
echo "=== Step 1: HTML → .pptx ==="
PPTX_PATH="$OUTPUT_DIR/converted.pptx"
npx tsx convert.ts "$HTML_DIR" "$PPTX_PATH"

# Step 2: Copy original screenshots (created during extraction)
echo ""
echo "=== Step 2: Collecting original screenshots ==="
for f in "$HTML_DIR"/slide_*_original.png; do
  [ -f "$f" ] || continue
  BASE=$(basename "$f" | sed 's/_original//')
  cp "$f" "$OUTPUT_DIR/originals/$BASE"
done
ORIG_COUNT=$(ls "$OUTPUT_DIR/originals"/*.png 2>/dev/null | wc -l)
echo "  $ORIG_COUNT original screenshots"

# Step 3+4: Upload and screenshot (requires Google account in Chrome)
echo ""
echo "=== Step 3: Upload + Screenshot ==="
echo "  To complete the pipeline, the .pptx needs to be uploaded to Google Drive."
echo "  Run manually if Google auth is available:"
echo "    npx tsx screenshot-pptx.ts $PPTX_PATH $OUTPUT_DIR/slides"
echo ""

# Step 5: Launch rating server
echo "=== Step 4: Rating Server ==="
echo "  Starting at http://localhost:3456"
npx tsx rating-server.ts "$OUTPUT_DIR"
