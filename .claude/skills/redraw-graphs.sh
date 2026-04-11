#!/bin/bash
# Regenerate graph assets from graphs.json and sync to the original presentation.
set -e

REPO="/workspaces/sashaslides"
SCRIPTS="$REPO/presentations/scripts"
SLIDES_MD="$REPO/presentations/1/slides.md"
PPTX="$REPO/presentations/1/RobPresentation.pptx"

cd "$REPO"

if [ ! -f "$REPO/presentations/1/graphs.json" ]; then
  echo "ERROR: graphs.json not found at presentations/1/graphs.json" >&2
  exit 1
fi

echo "=== 1/4 Regenerating assets from graphs.json ==="
(cd "$SCRIPTS" && npx tsx render-assets.ts "$SLIDES_MD")

echo "=== 2/4 Regenerating $PPTX ==="
(cd "$SCRIPTS" && npx tsx generate-pptx.ts "$SLIDES_MD" "$PPTX")

echo "=== 3/4 Uploading to Drive (replacing existing file) ==="
(cd "$SCRIPTS" && npx tsx upload-pptx-to-slides.ts "$PPTX")
(cd "$SCRIPTS" && npx tsx click-replace.ts)
sleep 1.5

echo "=== 4/4 Re-importing into original presentation ==="
(cd "$SCRIPTS" && npx tsx reimport-original.ts)
sleep 0.5
(cd "$SCRIPTS" && npx tsx complete-import.ts)

echo "=== Done ==="
