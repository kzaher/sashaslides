#!/usr/bin/env bash
# regen-basics.sh — Convert fixtures-basic/ → pptx → Slides → thumbs → goldens check.
#
# Usage:
#   ./regen-basics.sh          # regen + check against goldens, write diffs to /tmp/sxs/diffs
#
# NOTE: There is no --bless flag here. Goldens can only be written by the
# user via the SxS rating UI — see `serve-sxs.sh` and README.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# tablesFormat: native (default) | baked. Pass via TABLES_FORMAT=baked or $1.
# Non-default params write to a SEPARATE OUT + goldens path so the baked run
# never overwrites the native baseline.
TABLES_FORMAT="${TABLES_FORMAT:-${1:-native}}"
case "$TABLES_FORMAT" in native|baked) ;; *) echo "❌ TABLES_FORMAT must be native|baked, got: $TABLES_FORMAT" >&2; exit 2 ;; esac
if [ "$TABLES_FORMAT" = "native" ]; then
  OUT=/tmp/sxs
  GOLDENS="$HERE/e2e/goldens"
else
  OUT=/tmp/sxs-$TABLES_FORMAT
  GOLDENS="$HERE/e2e/goldens-basic-$TABLES_FORMAT"
fi
echo "tablesFormat=$TABLES_FORMAT  OUT=$OUT  goldens=$GOLDENS"
mkdir -p "$OUT/originals" "$OUT/slides" "$OUT/diffs"

TITLE="basics_$(date +%s)"
cd "$HERE"

fail() { echo "❌ FATAL: $*" >&2; exit 1; }

# Track newest thumbnail mtime so we can verify thumbnails were actually
# rewritten. Directory mtime only advances on entry add/remove, not when
# existing files are overwritten in place — so look at the files themselves.
SLIDES_BEFORE=$(stat -c %Y "$OUT/slides"/*.png 2>/dev/null | sort -n | tail -1) || true
SLIDES_BEFORE=${SLIDES_BEFORE:-0}

echo "=== Convert + upload ==="
# `| tee` captures output AND lets it stream to stdout. `set -o pipefail`
# causes the pipeline to exit non-zero if convert-pptx fails, but `set -e`
# then aborts silently. Use `if !` so we always reach an explicit fail()
# with a pointer to the log. PIPESTATUS[0] gives the underlying npx exit.
if ! npx tsx convert-pptx.ts e2e/fixtures-basic --title "$TITLE" --out "$OUT/basics.pptx" --tables-format "$TABLES_FORMAT" 2>&1 | tee "$OUT/convert.log"; then
  fail "convert-pptx.ts exited non-zero (${PIPESTATUS[0]:-?}). Tail of log:
$(tail -8 "$OUT/convert.log")"
fi

PRES_ID=$(grep -oE 'presentation/d/[A-Za-z0-9_-]+' "$OUT/convert.log" | head -1 | cut -d/ -f3 || true)
[ -n "${PRES_ID:-}" ] || fail "convert-pptx completed but no presentation URL was printed. Check $OUT/convert.log (auth failure? upload failure?)"
echo "Presentation: $PRES_ID"
cat > "$OUT/meta.json" <<EOF
{ "htmlDir": "$HERE/e2e/fixtures-basic", "goldensDir": "$GOLDENS", "presentationId": "$PRES_ID", "tablesFormat": "$TABLES_FORMAT", "renderParams": { "tablesFormat": "$TABLES_FORMAT" } }
EOF

echo "=== Screenshot originals + export thumbs (parallel) ==="
npx tsx shot-originals.ts e2e/fixtures-basic "$OUT/originals" > "$OUT/shot.log" 2>&1 &
SHOT_PID=$!
if ! npx tsx export-thumbs.ts "$PRES_ID" "$OUT/slides" > "$OUT/thumbs.log" 2>&1; then
  wait $SHOT_PID || true
  fail "export-thumbs.ts failed. Tail of log:
$(tail -8 "$OUT/thumbs.log")"
fi
if ! wait $SHOT_PID; then
  fail "shot-originals.ts failed. Tail of log:
$(tail -8 "$OUT/shot.log")"
fi

# Verify at least one thumbnail was actually regenerated (mtime advanced).
SLIDES_AFTER=$(stat -c %Y "$OUT/slides"/*.png 2>/dev/null | sort -n | tail -1)
SLIDES_AFTER=${SLIDES_AFTER:-0}
[ "$SLIDES_AFTER" -gt "$SLIDES_BEFORE" ] || fail "newest thumbnail mtime did not advance — thumbnails not updated. See $OUT/thumbs.log"

echo "=== Pixel-perfect goldens check ==="
# check-goldens intentionally exits non-zero when regressions are found so
# CI can gate on it; we `|| true` ONLY here because the goal is to print the
# summary + diffs, not to abort.
npx tsx check-goldens.ts "$OUT/slides" "$OUT/diffs" --goldens "$GOLDENS" --originals "$OUT/originals" || true

# Invalidate the GOOD rating of any slide that REGRESSED vs its blessed golden
# (a stale "good" no longer reflects the render) → flip it to BAD for re-review.
echo "=== Invalidate regressed goldens in ratings ==="
npx tsx invalidate-regressed.ts "$OUT/diffs/regression-report.json" "$OUT/ratings.json" || true

echo ""
echo "Thumbs:  $OUT/slides/"
echo "Diffs:   $OUT/diffs/ (diff_slide_NN.png for any regression)"
echo "Report:  $OUT/diffs/regression-report.json"
echo "Slides:  https://docs.google.com/presentation/d/$PRES_ID/edit"
