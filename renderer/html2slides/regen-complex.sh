#!/usr/bin/env bash
# regen-complex.sh — Convert fixtures/ → pptx → Slides → thumbs → goldens check.
#
# Mirrors regen-basics.sh but points at the complex fixture set and uses a
# separate goldens dir (e2e/goldens-complex/) + output dir (/tmp/sxs-complex)
# so it doesn't collide with the basics pipeline.
#
# Goldens can only be written by the user via the SxS rating UI (serve-sxs.sh) — same rule.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# --- Rendering parameters -------------------------------------------------
# tablesFormat: native (default; editable <a:tbl>, square corners) | baked
#   (rasterised tables — rounded corners + full fidelity). Pass via
#   TABLES_FORMAT=baked or as $1. NON-DEFAULT params write to a SEPARATE path
#   (/tmp/sxs-complex-<fmt>, goldens-complex-<fmt>, ratings backup suffix) so
#   they never collide with the default-native baseline.
TABLES_FORMAT="${TABLES_FORMAT:-${1:-native}}"
case "$TABLES_FORMAT" in native|baked) ;; *) echo "❌ TABLES_FORMAT must be native|baked, got: $TABLES_FORMAT" >&2; exit 2 ;; esac

if [ "$TABLES_FORMAT" = "native" ]; then
  OUT=${REGEN_OUT:-/tmp/sxs-complex}
  GOLDENS="$HERE/e2e/goldens-complex"
  BACKUP="$HERE/e2e/.ratings-complex.json"
else
  OUT=${REGEN_OUT:-/tmp/sxs-complex-$TABLES_FORMAT}
  GOLDENS="$HERE/e2e/goldens-complex-$TABLES_FORMAT"
  BACKUP="$HERE/e2e/.ratings-complex-$TABLES_FORMAT.json"
fi
echo "tablesFormat=$TABLES_FORMAT  OUT=$OUT  goldens=$GOLDENS"
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

fail() { echo "❌ FATAL: $*" >&2; exit 1; }

# Track newest thumbnail mtime so we can verify thumbnails were actually
# rewritten. Directory mtime only advances on entry add/remove, not when
# existing files are overwritten in place — so look at the files themselves.
# `|| true` because a fresh OUT has no *.png and `stat` exits non-zero under
# `set -o pipefail`, which would silently kill the whole script.
SLIDES_BEFORE=$(stat -c %Y "$OUT/slides"/*.png 2>/dev/null | sort -n | tail -1) || true
SLIDES_BEFORE=${SLIDES_BEFORE:-0}

echo "=== Convert + upload ==="
# `| tee` captures output AND lets it stream to stdout. With `set -o
# pipefail`, a convert-pptx failure makes the pipeline non-zero, but
# `set -e` then aborts silently. Use `if !` so we always reach an explicit
# fail() with a pointer to the log.
if ! npx tsx convert-pptx.ts e2e/fixtures --title "$TITLE" --out "$OUT/complex.pptx" --tables-format "$TABLES_FORMAT" 2>&1 | tee "$OUT/convert.log"; then
  fail "convert-pptx.ts exited non-zero (${PIPESTATUS[0]:-?}). Tail of log:
$(tail -8 "$OUT/convert.log")"
fi

PRES_ID=$(grep -oE 'presentation/d/[A-Za-z0-9_-]+' "$OUT/convert.log" | head -1 | cut -d/ -f3 || true)
[ -n "${PRES_ID:-}" ] || fail "convert-pptx completed but no presentation URL was printed — upload may have failed. See $OUT/convert.log"
echo "Presentation: $PRES_ID"
cat > "$OUT/meta.json" <<EOF
{ "htmlDir": "$HERE/e2e/fixtures", "goldensDir": "$GOLDENS", "ratingsBackup": "$BACKUP", "presentationId": "$PRES_ID", "tablesFormat": "$TABLES_FORMAT", "renderParams": { "tablesFormat": "$TABLES_FORMAT" } }
EOF

echo "=== Screenshot originals + export thumbs (parallel) ==="
npx tsx shot-originals.ts e2e/fixtures "$OUT/originals" > "$OUT/shot.log" 2>&1 &
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
SLIDES_AFTER=$(stat -c %Y "$OUT/slides"/*.png 2>/dev/null | sort -n | tail -1) || true
SLIDES_AFTER=${SLIDES_AFTER:-0}
[ "$SLIDES_AFTER" -gt "$SLIDES_BEFORE" ] || fail "newest thumbnail mtime did not advance — thumbnails not updated. See $OUT/thumbs.log"

echo "=== Pixel-perfect goldens check ==="
# check-goldens intentionally exits non-zero when regressions are found so
# CI can gate on it; we `|| true` ONLY here because the goal is to print the
# summary + diffs, not to abort.
npx tsx check-goldens.ts "$OUT/slides" "$OUT/diffs" --goldens "$GOLDENS" --originals "$OUT/originals" || true

echo ""
echo "Thumbs:  $OUT/slides/"
echo "Diffs:   $OUT/diffs/ (diff_slide_NN.png for any regression)"
echo "Report:  $OUT/diffs/regression-report.json"
echo "Slides:  https://docs.google.com/presentation/d/$PRES_ID/edit"
