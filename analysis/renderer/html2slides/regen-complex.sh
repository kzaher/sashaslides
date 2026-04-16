#!/usr/bin/env bash
# regen-complex.sh — Convert fixtures/ → pptx → Slides → thumbs → goldens check.
#
# Mirrors regen-basics.sh but points at the complex fixture set and uses a
# separate goldens dir (e2e/goldens-complex/) + output dir (/tmp/sxs-complex)
# so it doesn't collide with the basics pipeline.
#
# Goldens can only be written by the user via rating-server.ts — same rule.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=/tmp/sxs-cl45
BACKUP="$HERE/e2e/.ratings-complex.json"
mkdir -p "$OUT/originals" "$OUT/slides" "$OUT/diffs"

# Ratings persistence: /tmp can be wiped between devcontainer sessions, so
# mirror ratings.json into the repo (ignored by git via the .gitignore entry).
# On each run, seed /tmp from the backup if the backup is newer or the live
# copy is missing.
if [ -f "$BACKUP" ] && [ ! -f "$OUT/ratings.json" ]; then
  cp "$BACKUP" "$OUT/ratings.json"
  echo "Restored ratings from $BACKUP"
fi

TITLE="complex_$(date +%s)"
cd "$HERE"

echo "=== Convert + upload ==="
npx tsx convert-pptx.ts e2e/fixtures --title "$TITLE" --out "$OUT/complex.pptx" 2>&1 | tee "$OUT/convert.log"
PRES_ID=$(grep -oE 'presentation/d/[A-Za-z0-9_-]+' "$OUT/convert.log" | head -1 | cut -d/ -f3)
echo "Presentation: $PRES_ID"
cat > "$OUT/meta.json" <<EOF
{ "htmlDir": "$HERE/e2e/fixtures", "goldensDir": "$HERE/e2e/goldens-complex", "ratingsBackup": "$BACKUP", "presentationId": "$PRES_ID" }
EOF

echo "=== Screenshot originals + export thumbs (parallel) ==="
npx tsx shot-originals.ts e2e/fixtures "$OUT/originals" > "$OUT/shot.log" 2>&1 &
SHOT_PID=$!
npx tsx export-thumbs.ts "$PRES_ID" "$OUT/slides" > "$OUT/thumbs.log" 2>&1
wait $SHOT_PID

echo "=== Pixel-perfect goldens check ==="
npx tsx check-goldens.ts "$OUT/slides" "$OUT/diffs" --goldens "$HERE/e2e/goldens-complex" --originals "$OUT/originals" || true

echo ""
echo "Thumbs:  $OUT/slides/"
echo "Diffs:   $OUT/diffs/ (diff_slide_NN.png for any regression)"
echo "Report:  $OUT/diffs/regression-report.json"
echo "Slides:  https://docs.google.com/presentation/d/$PRES_ID/edit"
