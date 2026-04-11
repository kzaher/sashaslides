#!/bin/bash
set -e
cd /workspaces/sashaslides
SLIDES_MD="${1:-presentations/1/slides.md}"
PRESENTATION_URL="${2:-https://docs.google.com/presentation/d/1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY/edit}"
echo "=== Pushing slides from $SLIDES_MD to presentation ==="
npx --prefix presentations/scripts tsx presentations/scripts/push-slides-keyboard.ts "$SLIDES_MD"
