#!/usr/bin/env bash
# serve-sxs.sh — launch the UNIFIED SxS rating UI against an html2slides
# output dir (originals/, slides/, diffs/, meta.json — as produced by
# regen-basics.sh / regen-complex.sh).
#
# This is the single rating server for the project. It is the
# filtered-rating-server (renderer/structured-prompts/bug_solving/scripts/),
# which carries the full review toolset the old rating-server.ts lacked:
#   * 🔍 Magnifier (loupe) with a 2–8× zoom slider
#   * annotation canvas + per-annotation zoom-crops
#   * client-side diff overlay
#   * HTML-source + Google-Slides deep links (from meta.json)
#
# GOLDENS BLESS: clicking "Good" copies slides/<id>.png into the goldens
# dir derived from meta.json (sibling of htmlDir). Passing --goldens-dir is
# what puts the server in "goldens mode"; it is the ONLY sanctioned writer
# of e2e/goldens/ and only ever fires on the user's own "Good" click.
#
# Usage: ./serve-sxs.sh [sxs-dir=/tmp/sxs] [port=3456]
set -euo pipefail
SXS="${1:-/tmp/sxs}"
PORT="${2:-3456}"
H2S="$(cd "$(dirname "$0")" && pwd)"
FILTERED="$H2S/../structured-prompts/bug_solving/scripts/filtered-rating-server.ts"

[ -d "$SXS/originals" ] || { echo "❌ $SXS/originals missing — run regen-basics.sh first"; exit 1; }
[ -d "$SXS/slides" ]    || { echo "❌ $SXS/slides missing — run regen-basics.sh first"; exit 1; }
[ -f "$FILTERED" ]      || { echo "❌ filtered-rating-server.ts not found at $FILTERED"; exit 1; }
mkdir -p "$SXS/diffs"

# Derive htmlDir + presentationId from meta.json; goldensDir is the sibling
# `goldens/` of htmlDir (matching the retired rating-server.ts convention).
HTML_DIR="$(python3 -c "import json,sys; print(json.load(open('$SXS/meta.json')).get('htmlDir',''))" 2>/dev/null || true)"
HTML_DIR="${HTML_DIR:-$H2S/e2e/fixtures-basic}"
GOLDENS="$(dirname "$HTML_DIR")/goldens"

# slides list = basenames of originals/slide_*.png
SLIDES="$(ls "$SXS"/originals/slide_*.png 2>/dev/null | xargs -n1 basename | sed 's/\.png$//' | sort | paste -sd, -)"
[ -n "$SLIDES" ] || { echo "❌ no slide_*.png in $SXS/originals"; exit 1; }

# The filtered server requires --analysis; basics has no per-slide prose.
ANALYSIS="$SXS/analysis.md"
[ -f "$ANALYSIS" ] || echo "(html2slides SxS — no per-slide analysis)" > "$ANALYSIS"

# manifest.json gives the UI its Google-Slides deep links. Build it from
# meta.json (presentationId + slideIds = per-slide object ids).
python3 - "$SXS/meta.json" "$SXS/slides/manifest.json" "$SLIDES" <<'PY'
import json, sys
meta_path, out_path, slides_csv = sys.argv[1], sys.argv[2], sys.argv[3]
try: m = json.load(open(meta_path))
except Exception: m = {}
slides = slides_csv.split(",")
oids = m.get("slideIds") or []
man = {"presentation_id": m.get("presentationId", "")}
if oids and len(oids) >= len(slides):
    man["slides"] = slides
    man["slide_object_ids"] = oids[:len(slides)]
json.dump(man, open(out_path, "w"), indent=2)
PY

lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 0.3

echo "==> Unified SxS rating UI: http://localhost:$PORT   (🔍 magnifier + annotation + bless)"
echo "    originals=$SXS/originals  slides=$SXS/slides"
echo "    goldens (bless on Good)=$GOLDENS"
# No `exec`: keep this script as the parent process so background launchers
# (harness/setsid) can track the PID across the npx→tsx→node chain.
npx tsx "$FILTERED" \
  --port "$PORT" \
  --slides "$SLIDES" \
  --analysis "$ANALYSIS" \
  --diffs "$SXS/diffs" \
  --thumbnails "$SXS/slides" \
  --originals "$SXS/originals" \
  --goldens-dir "$GOLDENS" \
  --html-dir "$HTML_DIR" \
  --ratings-file "$SXS/ratings.json" \
  --task-title "html2slides SxS — $(basename "$HTML_DIR")"
