#!/usr/bin/env bash
# record-pptx.sh — build one .pptx per slide fixture, in parallel, with no
# Google upload. Output files land at <out_dir>/<slide_id>.pptx.
#
# Usage:
#   record-pptx.sh --slides slide_04,slide_11,slide_14 --label before \
#                  --out /path/to/scratch/before
#
# `--label` is only used in the console output for readability; the actual
# output dir is controlled by --out. Failures propagate — this script uses
# `set -e` so any per-slide build that fails aborts the whole call.
set -euo pipefail

SLIDES=""
LABEL="pptx"
OUT=""
FIXTURES_DIR="renderer/html2slides/e2e/fixtures"
PARALLEL=4

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slides) SLIDES="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --fixtures) FIXTURES_DIR="$2"; shift 2;;
    --parallel) PARALLEL="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

[ -n "$SLIDES" ] || { echo "--slides required (comma-separated: slide_04,slide_11,...)" >&2; exit 1; }
[ -n "$OUT" ] || { echo "--out required" >&2; exit 1; }
[ -d "$FIXTURES_DIR" ] || { echo "fixtures dir not found: $FIXTURES_DIR" >&2; exit 1; }

mkdir -p "$OUT"
echo "record-pptx [$LABEL] → $OUT (parallel=$PARALLEL)"

# Convert `slide_04,slide_11` → `slide_04 slide_11`
IFS=',' read -ra SLIDE_ARR <<< "$SLIDES"

# Build one pptx per slide via xargs -P. `bash -c` keeps the per-slide logic
# simple and lets `set -e` propagate into each subshell. We pipe each slide
# name as its own argv to xargs.
printf '%s\n' "${SLIDE_ARR[@]}" | xargs -I{} -P"$PARALLEL" bash -c '
  set -e
  slide="$1"; out="$2"; fx="$3"
  html="${slide}.html"
  if [ ! -f "${fx}/${html}" ]; then
    echo "SKIP ${slide}: ${fx}/${html} not found" >&2
    exit 1
  fi
  echo "  [$$] building ${slide}..."
  npx tsx renderer/html2slides/convert-pptx.ts "$fx" \
    --only "$html" \
    --title "record-${slide}-$(date +%s)" \
    --out "${out}/${slide}.pptx" \
    --no-upload > "${out}/${slide}.log" 2>&1
  echo "  [$$] ${slide} done → ${out}/${slide}.pptx"
' _ {} "$OUT" "$FIXTURES_DIR"

echo "record-pptx [$LABEL] complete: $(ls -1 "$OUT"/*.pptx | wc -l) file(s)"
