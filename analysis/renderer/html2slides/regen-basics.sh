#!/usr/bin/env bash
# regen-basics.sh — Convert fixtures-basic/ → pptx → Slides → thumbs → goldens check.
#
# Usage:
#   ./regen-basics.sh          # regen + check against goldens, write diffs to /tmp/sxs/diffs
#
# NOTE: There is no --bless flag here. Goldens can only be written by the
# user via the SxS rating UI — see `rating-server.ts` and README.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=/tmp/sxs
mkdir -p "$OUT/originals" "$OUT/slides" "$OUT/diffs"

TITLE="basics_$(date +%s)"
cd "$HERE"

echo "=== Convert + upload ==="
npx tsx convert-pptx.ts e2e/fixtures-basic --title "$TITLE" --out "$OUT/basics.pptx" 2>&1 | tee "$OUT/convert.log"
PRES_ID=$(grep -oE 'presentation/d/[A-Za-z0-9_-]+' "$OUT/convert.log" | head -1 | cut -d/ -f3)
echo "Presentation: $PRES_ID"
cat > "$OUT/meta.json" <<EOF
{ "htmlDir": "$HERE/e2e/fixtures-basic", "presentationId": "$PRES_ID" }
EOF

echo "=== Screenshot originals + export thumbs (parallel) ==="
npx tsx shot-originals.ts e2e/fixtures-basic "$OUT/originals" > "$OUT/shot.log" 2>&1 &
SHOT_PID=$!
npx tsx export-thumbs.ts "$PRES_ID" "$OUT/slides" > "$OUT/thumbs.log" 2>&1
wait $SHOT_PID

echo "=== Pixel-perfect goldens check ==="
npx tsx check-goldens.ts "$OUT/slides" "$OUT/diffs" --originals "$OUT/originals" || true

echo ""
echo "Thumbs:  $OUT/slides/"
echo "Diffs:   $OUT/diffs/ (diff_slide_NN.png for any regression)"
echo "Report:  $OUT/diffs/regression-report.json"
echo "Slides:  https://docs.google.com/presentation/d/$PRES_ID/edit"
