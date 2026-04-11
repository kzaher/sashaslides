#!/bin/bash
# whiteboard-presentation: build a whiteboard-styled Google Slides presentation
# from a slides.md file.
#
# Usage: whiteboard-presentation.sh <slides.md> [existing-presentation-url]
set -e

SLIDES_MD="${1:-presentations/1/slides.md}"
EXISTING_URL="${2:-}"

REPO="/workspaces/sashaslides"
SCRIPTS="$REPO/presentations/scripts"
TEMPLATE_DIR="$REPO/presentation-templates/whiteboard"
OUT_PPTX="$(dirname "$SLIDES_MD")/$(basename "$SLIDES_MD" .md)_whiteboard.pptx"

cd "$REPO"

# Sanity check template assets
for f in whiteboard_background.png whiteboard-graphs.js; do
  if [ ! -f "$TEMPLATE_DIR/$f" ]; then
    echo "ERROR: missing template asset: $TEMPLATE_DIR/$f" >&2
    exit 1
  fi
done

# Regenerate hand-drawn icons if they don't exist
if [ ! -f "$REPO/presentations/1/icons/lightbulb.png" ]; then
  echo "=== Generating hand-drawn icons ==="
  (cd "$SCRIPTS" && npx tsx generate-icons.ts)
fi

# Generate the styled .pptx
echo "=== Generating $OUT_PPTX from $SLIDES_MD ==="
(cd "$SCRIPTS" && npx tsx generate-pptx.ts "$SLIDES_MD" "$OUT_PPTX")

# Upload to Google Drive
echo "=== Uploading $OUT_PPTX to Google Drive ==="
(cd "$SCRIPTS" && npx tsx upload-pptx-to-slides.ts "$OUT_PPTX")

if [ -n "$EXISTING_URL" ]; then
  echo "=== Importing slides into existing presentation ==="
  echo "Target: $EXISTING_URL"
  # Extract file ID
  PRES_ID=$(echo "$EXISTING_URL" | grep -oP '/d/\K[a-zA-Z0-9_-]+')
  (cd "$SCRIPTS" && PRES_ID="$PRES_ID" npx tsx reimport-original.ts)
else
  echo "=== Opening uploaded presentation as Google Slides ==="
  (cd "$SCRIPTS" && npx tsx find-and-open-pptx.ts)
fi

echo "=== Done ==="
