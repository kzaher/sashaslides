#!/usr/bin/env bash
set -euo pipefail

ANALYSIS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTRACTED_DIR="${1:?Usage: analyze-slides.sh <extracted-dir> [candidate: 1|2|3|all] [output-file]}"
CANDIDATE="${2:-all}"
OUTPUT="${3:-}"

if [ ! -f "$EXTRACTED_DIR/structure.json" ]; then
  echo "Error: $EXTRACTED_DIR/structure.json not found. Run extract-slides first."
  exit 1
fi

run_candidate() {
  local num="$1"
  local prompt_file=""
  local out_file="${OUTPUT:-$EXTRACTED_DIR/analysis_candidate_${num}.md}"

  case "$num" in
    1) prompt_file="$ANALYSIS_DIR/prompts/candidate-1-decompose.md" ;;
    2) prompt_file="$ANALYSIS_DIR/prompts/candidate-2-persona.md" ;;
    3) prompt_file="$ANALYSIS_DIR/prompts/candidate-3-generative.md" ;;
    *) echo "Unknown candidate: $num"; exit 1 ;;
  esac

  echo "Running analysis candidate $num..."

  # Build the input: prompt + structure + storyline + screenshot references
  local input=""
  input+="$(cat "$prompt_file")"
  input+=$'\n\n---\n\n## Extracted Structure\n\n```json\n'
  input+="$(cat "$EXTRACTED_DIR/structure.json")"
  input+=$'\n```\n\n## Extracted Storyline\n\n'
  input+="$(cat "$EXTRACTED_DIR/storyline.md")"
  input+=$'\n\n## Screenshots\n\nScreenshots are available at:\n'

  for png in "$EXTRACTED_DIR"/slide_*.png; do
    [ -f "$png" ] && input+="- $(basename "$png")"$'\n'
  done

  # Run through claude with opus for best analysis quality
  echo "$input" | claude -p --model opus --dangerously-skip-permissions > "$out_file" 2>/dev/null

  echo "  → Saved to $out_file"
}

if [ "$CANDIDATE" = "all" ]; then
  run_candidate 1 &
  run_candidate 2 &
  run_candidate 3 &
  wait
  echo "All 3 candidates complete."
else
  run_candidate "$CANDIDATE"
fi
