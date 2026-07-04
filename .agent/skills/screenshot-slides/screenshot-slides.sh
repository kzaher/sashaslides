#!/bin/bash
set -e
cd /workspaces/sashaslides
PRESENTATION_URL="${1:-https://docs.google.com/presentation/d/1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY/edit}"
OUTPUT_DIR="${2:-presentations/1/screenshots}"
echo "=== Screenshotting slides ==="
npx --prefix presentations/scripts tsx presentations/scripts/screenshot-slides.ts "$PRESENTATION_URL" "$OUTPUT_DIR"
