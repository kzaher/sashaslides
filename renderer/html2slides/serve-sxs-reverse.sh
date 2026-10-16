#!/usr/bin/env bash
# serve-sxs-reverse.sh — launch the SxS rating UI in REVERSE mode: Google Slides ->
# Sasha engine document -> Sasha HTML, against a reverse results directory.
#
# Why a separate launcher: the reverse UI reads a different pair (Google thumbnail
# vs Sasha HTML screenshot, plus the round trip from the original fixture), keeps
# its verdicts in ratings-reverse.json, and blesses into e2e/goldens-reverse/. A
# separate script (and port) keeps it from ever being started over a forward
# results directory by habit.
#
# Results layout (written by the reverse pipeline; see reverse-rating.ts):
#   originals/<id>.png   Google Slides thumbnail       slides/<id>.png   Sasha HTML screenshot
#   round-trip/originals/<id>.png  fixture screenshot  metrics.json      per-slide fidelity
#
# GOLDENS: only the user's own "Good" click writes e2e/goldens-reverse/<id>.png.
# This script never creates or fills that directory.
#
# Usage: ./serve-sxs-reverse.sh [results-dir=/workspaces/sashaslides/.sxs-reverse] [port=3458]
set -euo pipefail
HTML_TO_SLIDES="$(cd "$(dirname "$0")" && pwd)"
RESULTS="${1:-$HTML_TO_SLIDES/../../.sxs-reverse}"
PORT="${2:-3458}"

[ -d "$RESULTS" ] || { echo "❌ $RESULTS missing — run the reverse pipeline first"; exit 1; }
if [ ! -d "$RESULTS/originals" ] && ! ls -d "$RESULTS"/*/originals >/dev/null 2>&1; then
  echo "❌ no originals/ (Google thumbnails) under $RESULTS — run the reverse pipeline first"; exit 1
fi

lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true

echo "==> Reverse SxS rating UI: http://localhost:$PORT   (Google Slides vs Sasha HTML, round-trip toggle, metrics)"
echo "    results=$RESULTS   verdicts=$RESULTS/ratings-reverse.json"
echo "    reverse goldens (bless on Good)=$HTML_TO_SLIDES/e2e/goldens-reverse"
# No `exec`: keep this script as the parent so background launchers can track the PID.
npx tsx "$HTML_TO_SLIDES/rating-server.ts" "$RESULTS" \
  --direction reverse \
  --port "$PORT"
