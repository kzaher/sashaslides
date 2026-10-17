#!/usr/bin/env bash
# serve-sxs.sh — launch the SxS rating UI (rating-server.ts) against an
# html2slides output dir (originals/, slides/, diffs/, meta.json — as produced by
# regen-basics.sh / regen-complex.sh).
#
# rating-server.ts is the single rating UI: 🔍 magnifier, annotation canvas +
# per-annotation zoom-crops, client-side diff overlay, HTML-source + Google-Slides
# deep links (from meta.json).
#
# GOLDENS BLESS: clicking "Good" copies slides/<id>.png into --goldens-dir. It is
# the ONLY sanctioned writer of e2e/goldens*/ and only ever fires on the user's
# own "Good" click.
#
# Usage: ./serve-sxs.sh [sxs-dir=/tmp/sxs] [port=3456] [goldens-dir]
set -euo pipefail
SXS="${1:-/tmp/sxs}"
PORT="${2:-3456}"
GOLDENS_ARGUMENT="${3:-}"
H2S="$(cd "$(dirname "$0")" && pwd)"

[ -d "$SXS/originals" ] || { echo "❌ $SXS/originals missing — run regen-basics.sh first"; exit 1; }
[ -d "$SXS/slides" ]    || { echo "❌ $SXS/slides missing — run regen-basics.sh first"; exit 1; }

# htmlDir from meta.json; the goldens default to the sibling `goldens/` of htmlDir.
HTML_DIR="$(python3 -c "import json,sys; print(json.load(open('$SXS/meta.json')).get('htmlDir',''))" 2>/dev/null || true)"
HTML_DIR="${HTML_DIR:-$H2S/e2e/fixtures-basic}"
# The complex set's goldens are e2e/goldens-complex (regen-complex.sh), NOT the sibling goldens/ of
# e2e/fixtures: deriving the sibling sent a complex "Good" into the BASIC goldens (caught 2026-10-16
# before any click). An explicit third argument always wins.
case "$HTML_DIR" in
  */e2e/fixtures|*/e2e/fixtures/) GOLDENS="$(dirname "$HTML_DIR")/goldens-complex" ;;
  *) GOLDENS="$(dirname "$HTML_DIR")/goldens" ;;
esac
GOLDENS="${GOLDENS_ARGUMENT:-$GOLDENS}"

lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 0.3

echo "==> SxS rating UI: http://localhost:$PORT   (🔍 magnifier + annotation + bless)"
echo "    originals=$SXS/originals  slides=$SXS/slides"
echo "    goldens (bless on Good)=$GOLDENS"
# No `exec`: keep this script as the parent process so background launchers
# (harness/setsid) can track the PID across the npx→tsx→node chain.
npx tsx "$H2S/rating-server.ts" "$SXS" \
  --port "$PORT" \
  --goldens-dir "$GOLDENS" \
  --html-dir "$HTML_DIR" \
  --ratings-file "$SXS/ratings.json" \
  --task-title "html2slides SxS — $(basename "$HTML_DIR")"
