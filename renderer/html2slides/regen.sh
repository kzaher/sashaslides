#!/usr/bin/env bash
# regen.sh basic|complex [native|baked] — Convert a fixture set → pptx → Slides → thumbs → goldens check.
#
#   basic:   e2e/fixtures-basic → /tmp/sxs,         goldens e2e/goldens
#   complex: e2e/fixtures       → /tmp/sxs-complex, goldens e2e/goldens-complex, ratings mirrored to
#            e2e/.ratings-complex.json (git-ignored) because /tmp can be wiped between sessions.
#
# regen-basics.sh and regen-complex.sh are one-line wrappers kept for the npm scripts, docs and skills.
#
# tablesFormat: native (default; editable <a:tbl>, square corners) | baked (rasterised tables). Pass via
# TABLES_FORMAT=baked or as the second argument. A non-default format writes to a SEPARATE output,
# goldens and ratings-backup path, so it never collides with the native baseline. REGEN_OUT overrides
# the output directory.
#
# There is no --bless flag: goldens can only be written by the user via the SxS rating UI (serve-sxs.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SET="${1:-}"
TABLES_FORMAT="${TABLES_FORMAT:-${2:-native}}"
case "$TABLES_FORMAT" in native|baked) ;; *) echo "❌ TABLES_FORMAT must be native|baked, got: $TABLES_FORMAT" >&2; exit 2 ;; esac
SUFFIX=""; [ "$TABLES_FORMAT" = "native" ] || SUFFIX="-$TABLES_FORMAT"
case "$SET" in
  basic)
    FIXTURES=e2e/fixtures-basic; NAME=basics; BACKUP=""
    OUT=${REGEN_OUT:-/tmp/sxs$SUFFIX}
    if [ -z "$SUFFIX" ]; then GOLDENS="$HERE/e2e/goldens"; else GOLDENS="$HERE/e2e/goldens-basic$SUFFIX"; fi ;;
  complex)
    FIXTURES=e2e/fixtures; NAME=complex
    OUT=${REGEN_OUT:-/tmp/sxs-complex$SUFFIX}
    GOLDENS="$HERE/e2e/goldens-complex$SUFFIX"
    BACKUP="$HERE/e2e/.ratings-complex$SUFFIX.json" ;;
  *) echo "usage: regen.sh basic|complex [native|baked]" >&2; exit 2 ;;
esac
echo "set=$SET  tablesFormat=$TABLES_FORMAT  OUT=$OUT  goldens=$GOLDENS"
mkdir -p "$OUT/originals" "$OUT/slides" "$OUT/diffs"

# Seed a wiped /tmp from the ratings backup when the live copy is missing.
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ] && [ ! -f "$OUT/ratings.json" ]; then
  cp "$BACKUP" "$OUT/ratings.json"
  echo "Restored ratings from $BACKUP"
fi

TITLE="${NAME}_$(date +%s)"
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
# `| tee` captures output AND lets it stream to stdout. With `set -o pipefail`
# a convert-pptx failure makes the pipeline non-zero, but `set -e` then aborts
# silently. Use `if !` so we always reach an explicit fail() with a pointer to
# the log. PIPESTATUS[0] gives the underlying npx exit.
if ! npx tsx convert-pptx.ts "$FIXTURES" --title "$TITLE" --out "$OUT/$NAME.pptx" --tables-format "$TABLES_FORMAT" 2>&1 | tee "$OUT/convert.log"; then
  fail "convert-pptx.ts exited non-zero (${PIPESTATUS[0]:-?}). Tail of log:
$(tail -8 "$OUT/convert.log")"
fi

PRES_ID=$(grep -oE 'presentation/d/[A-Za-z0-9_-]+' "$OUT/convert.log" | head -1 | cut -d/ -f3 || true)
[ -n "${PRES_ID:-}" ] || fail "convert-pptx completed but no presentation URL was printed. Check $OUT/convert.log (auth failure? upload failure?)"
echo "Presentation: $PRES_ID"
BACKUP_FIELD=""; [ -z "$BACKUP" ] || BACKUP_FIELD=" \"ratingsBackup\": \"$BACKUP\","
cat > "$OUT/meta.json" <<JSON
{ "htmlDir": "$HERE/$FIXTURES", "goldensDir": "$GOLDENS",$BACKUP_FIELD "presentationId": "$PRES_ID", "tablesFormat": "$TABLES_FORMAT", "renderParams": { "tablesFormat": "$TABLES_FORMAT" } }
JSON

echo "=== Screenshot originals + export thumbs (parallel) ==="
npx tsx shot-originals.ts "$FIXTURES" "$OUT/originals" > "$OUT/shot.log" 2>&1 &
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

# Invalidate the GOOD rating of any slide whose current render REGRESSED vs its
# blessed golden — a stale "good" no longer reflects reality, so it flips to BAD
# (surfaced in the SxS + re-solvable). Writes ratings.json (+ the repo-mirrored
# backup for complex). Only currently-GOOD, genuinely-regressed slides are touched.
echo "=== Invalidate regressed goldens in ratings ==="
npx tsx invalidate-regressed.ts "$OUT/diffs/regression-report.json" "$OUT/ratings.json" ${BACKUP:+"$BACKUP"} || true

echo ""
echo "Thumbs:  $OUT/slides/"
echo "Diffs:   $OUT/diffs/ (diff_slide_NN.png for any regression)"
echo "Report:  $OUT/diffs/regression-report.json"
echo "Slides:  https://docs.google.com/presentation/d/$PRES_ID/edit"
