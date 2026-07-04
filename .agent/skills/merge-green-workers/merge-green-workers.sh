#!/usr/bin/env bash
# merge-green-workers.sh — run the pixel-perfect merge gate (and, with --rate,
# boot a FILTERED rating UI on the changed slides if the gate blocks).
#
# Usage:
#   bash .agent/skills/merge-green-workers/merge-green-workers.sh <intended-csv> [--rate] [--port N]
#
# <intended-csv> = the slides the merge is ALLOWED to change (the green clusters'
# slide ids). The gate BLOCKS (exit 1) if any other slide's render changed.
set -uo pipefail

REPO="${REPO:-/workspaces/sashaslides}"
cd "$REPO"

INTENDED="${1:-}"
if [ -z "$INTENDED" ] || [[ "$INTENDED" == --* ]]; then
  echo "usage: merge-green-workers.sh <intended-csv> [--rate] [--port N]" >&2
  echo "  e.g. merge-green-workers.sh slide_19,slide_21,slide_27,slide_30" >&2
  exit 2
fi
shift || true

RATE=0
PORT=4730
while [ $# -gt 0 ]; do
  case "$1" in
    --rate) RATE=1; shift;;
    --port) PORT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# Chrome preflight — the converter renders through CDP on :9222.
if ! curl -s --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "❌ Chrome not on :9222. Start it first:" >&2
  echo "   google-chrome-stable --headless=new --remote-debugging-port=9222 --no-sandbox --user-data-dir=/tmp/chrome-cdp &" >&2
  exit 2
fi

OUT=/tmp/merge-gate
npx tsx renderer/structured-prompts/bug_solving/scripts/merge-gate.ts \
  --intended "$INTENDED" --out "$OUT" --repo "$REPO"
GATE_RC=$?

if [ "$GATE_RC" -eq 0 ]; then
  echo "✅ merge gate PASSED — only intended slides changed. Safe to commit the merge."
  exit 0
fi

if [ "$GATE_RC" -ne 1 ]; then
  echo "merge gate errored (rc=$GATE_RC) — see output above." >&2
  exit "$GATE_RC"
fi

# BLOCKED. Optionally render the CHANGED slides to Slides and boot a filtered UI.
CHANGED=$(python3 -c "import json;print(','.join(json.load(open('$OUT/merge-gate.json'))['changed']))" 2>/dev/null)
echo "❌ merge gate BLOCKED — unexpected slide(s) changed. Changed set: ${CHANGED:-?}"
if [ "$RATE" -eq 1 ] && [ -n "$CHANGED" ]; then
  echo "[merge-green-workers] rendering ONLY the changed slides to Slides for review …"
  RDIR=/workspaces/sashaslides/.sxs-merge-anomaly
  rm -rf "$RDIR"; mkdir -p "$RDIR"
  ( cd renderer && npx tsx structured-prompts/bug_solving/scripts/record-rendering.ts \
      --mode full --fixtures "$REPO/renderer/html2slides/e2e/fixtures" \
      --slides "$CHANGED" --title "merge-anomaly" --out "$RDIR" ) || true
  lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null
  setsid npx tsx renderer/html2slides/rating-server.ts "$RDIR" \
    --port "$PORT" --filter-slides "$CHANGED" \
    --originals-dir "$RDIR/originals" --slides-dir "$RDIR/thumbs" \
    --history-dir "$REPO/.bug-solving-history" \
    > /tmp/sxs-merge-anomaly.log 2>&1 < /dev/null & disown
  for i in $(seq 1 30); do sleep 0.5; curl -s --max-time 1 "http://localhost:$PORT/" >/dev/null 2>&1 && break; done
  echo "   review the anomalous slides ONLY at http://localhost:$PORT  (do NOT merge until resolved)"
fi
exit 1
