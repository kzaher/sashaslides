#!/usr/bin/env bash
set -euo pipefail

# Parallel E2E pipeline for html2slides converter
# Usage: bash run-parallel.sh [--parallelism N] [--skip-convert]
#
# Pipeline:
#   1. Screenshot HTML fixtures (parallel)
#   2. Convert all → Google Slides API
#   3. Export thumbnails
#   4. Stream each slide to haiku for review (parallel)
#   5. Collect results → only bad slides get escalated
#   6. Launch rating server for human review

PARALLELISM=10
SKIP_CONVERT=false
PORT=3456

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallelism) PARALLELISM="$2"; shift 2;;
    --skip-convert) SKIP_CONVERT=true; shift;;
    --port) PORT="$2"; shift 2;;
    *) shift;;
  esac
done

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
H2S_DIR="$(dirname "$E2E_DIR")"
FIXTURES_DIR="$E2E_DIR/fixtures"
SNAPSHOTS_DIR="$E2E_DIR/snapshots"
RUNS_DIR="$E2E_DIR/runs"
EVAL_DIR="$E2E_DIR/eval-set"

TS=$(date -u +%Y-%m-%dT%H-%M-%S)
RUN_DIR="$RUNS_DIR/$TS"
ORIG_DIR="$RUN_DIR/originals"
THUMBS_DIR="$RUN_DIR/thumbs"
SXS_DIR="$RUN_DIR/sxs"
REVIEW_DIR="$RUN_DIR/reviews"

mkdir -p "$ORIG_DIR" "$THUMBS_DIR" "$SXS_DIR/originals" "$SXS_DIR/slides" "$REVIEW_DIR" "$SNAPSHOTS_DIR" "$EVAL_DIR"

SLIDE_COUNT=$(ls "$FIXTURES_DIR"/slide_*.html 2>/dev/null | wc -l)
echo "=== E2E Parallel Pipeline: $SLIDE_COUNT fixtures, parallelism=$PARALLELISM ==="

if [ "$SKIP_CONVERT" = true ]; then
  # Reuse latest run
  LATEST=$(ls -t "$RUNS_DIR" 2>/dev/null | head -1)
  if [ -z "$LATEST" ]; then echo "No previous runs"; exit 1; fi
  RUN_DIR="$RUNS_DIR/$LATEST"
  ORIG_DIR="$RUN_DIR/originals"
  THUMBS_DIR="$RUN_DIR/thumbs"
  SXS_DIR="$RUN_DIR/sxs"
  REVIEW_DIR="$RUN_DIR/reviews"
  mkdir -p "$REVIEW_DIR"
  echo "Reusing run: $LATEST"
else
  # Step 1: Screenshot HTML fixtures (already parallelized in the script)
  echo ""
  echo "--- Step 1: Screenshot fixtures ---"
  T0=$SECONDS
  cd "$H2S_DIR"
  npx tsx /workspaces/sashaslides/analysis/scripts/screenshot-html-slides.ts "$FIXTURES_DIR" "$ORIG_DIR" 2>&1 | tail -5
  echo "  Screenshots: $((SECONDS - T0))s"

  # Step 2: Convert via Slides API
  echo ""
  echo "--- Step 2: Convert HTML → Google Slides ---"
  T0=$SECONDS
  CONVERT_OUT=$(npx tsx convert-slides-api.ts "$FIXTURES_DIR" --title "E2E $TS" 2>&1)
  echo "$CONVERT_OUT" | tail -5
  PRES_ID=$(echo "$CONVERT_OUT" | grep "ID:" | head -1 | sed 's/.*ID: //')
  echo "  Presentation: $PRES_ID"
  echo "  Convert: $((SECONDS - T0))s"

  # Step 3: Export thumbnails
  echo ""
  echo "--- Step 3: Export thumbnails ---"
  T0=$SECONDS
  npx tsx export-thumbs.ts "$PRES_ID" "$THUMBS_DIR" 2>&1 | tail -3
  echo "  Thumbs: $((SECONDS - T0))s"

  # Save metadata
  echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"presentationId\":\"$PRES_ID\",\"url\":\"https://docs.google.com/presentation/d/$PRES_ID/edit\"}" > "$RUN_DIR/meta.json"

  # Copy to SxS dir
  cp "$ORIG_DIR"/slide_*.png "$SXS_DIR/originals/" 2>/dev/null || true
  cp "$THUMBS_DIR"/slide_*.png "$SXS_DIR/slides/" 2>/dev/null || true
fi

# Step 4: Parallel haiku review
echo ""
echo "--- Step 4: Parallel haiku review (parallelism=$PARALLELISM) ---"
T0=$SECONDS

review_slide() {
  local SLIDE_NUM="$1"
  local ORIG="$SXS_DIR/originals/slide_${SLIDE_NUM}.png"
  local THUMB="$SXS_DIR/slides/slide_${SLIDE_NUM}.png"
  local OUT="$REVIEW_DIR/slide_${SLIDE_NUM}.txt"

  if [ ! -f "$ORIG" ] || [ ! -f "$THUMB" ]; then
    echo "SKIP" > "$OUT"
    return
  fi

  # Use claude with haiku for fast review
  local PROMPT="Compare these two slide images. The first is the original HTML rendering, the second is Google Slides API output.
List ONLY specific visual differences (wrong colors, missing elements, mispositioned text, wrong shapes, missing borders, etc).
Rate: GOOD (nearly identical), ACCEPTABLE (minor differences), or BAD (major differences).
Format: one line per issue, then RATING: GOOD/ACCEPTABLE/BAD on the last line.
Be brief - max 5 issues."

  # Encode images as base64 for the prompt
  local ORIG_B64=$(base64 -w0 "$ORIG")
  local THUMB_B64=$(base64 -w0 "$THUMB")

  claude -p --model haiku --output-format text \
    "Original slide image (base64 PNG): data:image/png;base64,${ORIG_B64:0:100000}

Slides API output (base64 PNG): data:image/png;base64,${THUMB_B64:0:100000}

$PROMPT" > "$OUT" 2>/dev/null || echo "RATING: ERROR" > "$OUT"
}

export -f review_slide
export SXS_DIR REVIEW_DIR

# Run reviews in parallel
SLIDES=($(ls "$SXS_DIR/slides"/slide_*.png 2>/dev/null | sed 's/.*slide_//' | sed 's/.png//' | sort))
printf '%s\n' "${SLIDES[@]}" | xargs -P "$PARALLELISM" -I{} bash -c 'review_slide "{}"'

echo "  Reviews: $((SECONDS - T0))s"

# Step 5: Collect results
echo ""
echo "--- Step 5: Results ---"
GOOD=0; ACCEPTABLE=0; BAD=0; ERROR=0
declare -A RATINGS
for f in "$REVIEW_DIR"/slide_*.txt; do
  SLIDE=$(basename "$f" .txt)
  RATING=$(grep -i "^RATING:" "$f" 2>/dev/null | tail -1 | sed 's/RATING:\s*//' | tr '[:lower:]' '[:upper:]' | xargs)
  case "$RATING" in
    GOOD*) GOOD=$((GOOD+1)); RATINGS[$SLIDE]="good";;
    ACCEPTABLE*) ACCEPTABLE=$((ACCEPTABLE+1)); RATINGS[$SLIDE]="acceptable";;
    BAD*) BAD=$((BAD+1)); RATINGS[$SLIDE]="bad";;
    *) ERROR=$((ERROR+1)); RATINGS[$SLIDE]="error";;
  esac
done

echo "  GOOD: $GOOD | ACCEPTABLE: $ACCEPTABLE | BAD: $BAD | ERROR: $ERROR"
echo ""

# Show bad slides
if [ $BAD -gt 0 ] || [ $ERROR -gt 0 ]; then
  echo "  BAD/ERROR slides:"
  for f in "$REVIEW_DIR"/slide_*.txt; do
    SLIDE=$(basename "$f" .txt)
    RATING="${RATINGS[$SLIDE]:-unknown}"
    if [ "$RATING" = "bad" ] || [ "$RATING" = "error" ]; then
      echo "    $SLIDE: $(head -5 "$f" | tr '\n' ' | ')"
    fi
  done
fi

# Write ratings.json for the SxS server
python3 -c "
import json, os
ratings = {}
for f in sorted(os.listdir('$REVIEW_DIR')):
    if not f.endswith('.txt'): continue
    slide = f.replace('.txt','')
    content = open(os.path.join('$REVIEW_DIR', f)).read()
    rating_line = [l for l in content.split('\n') if l.upper().startswith('RATING:')]
    rating = rating_line[-1].split(':',1)[1].strip().lower() if rating_line else 'error'
    if rating.startswith('good'): status = 'good'
    elif rating.startswith('acceptable'): status = 'acceptable'
    elif rating.startswith('bad'): status = 'bad'
    else: status = 'error'
    ratings[slide] = {'status': 'pending', 'haiku_rating': status, 'haiku_review': content.strip()}
json.dump(ratings, open(os.path.join('$SXS_DIR', 'ratings.json'), 'w'), indent=2)
"

# Step 6: Launch rating server
echo ""
echo "--- Step 6: Rating server ---"
lsof -ti:$PORT 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 0.5

echo "  Run: $RUN_DIR"
echo "  Presentation: $(cat "$RUN_DIR/meta.json" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("url","N/A"))' 2>/dev/null || echo 'N/A')"
echo ""

cd "$H2S_DIR"
exec npx tsx rating-server.ts "$SXS_DIR" --port "$PORT"
