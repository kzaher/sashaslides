#!/usr/bin/env bash
set -euo pipefail

cd /workspaces/sashaslides/analysis

MODE="${1:-eval}"
shift 2>/dev/null || true

case "$MODE" in
  eval)
    echo "Running layout matching eval..."
    npx tsx scripts/run-layout-eval.ts "$@"
    ;;
  describe)
    SLIDE="$1"; shift
    echo "Describing slide layout: $SLIDE"
    npx tsx -e "
      import { describeSlide } from './scripts/layout-matching.ts';
      const c = parseInt('${1:-2}'.replace('--candidate','').trim()) || 2;
      describeSlide('$SLIDE', c).then(d => console.log(JSON.stringify(d, null, 2)));
    "
    ;;
  match)
    SLIDE="$1"; shift
    TEMPLATE_DIR="$1"; shift
    echo "Matching slide against templates in: $TEMPLATE_DIR"
    npx tsx scripts/run-layout-eval.ts --target-deck "$(basename "$(dirname "$SLIDE")")" --max-targets 1 "$@"
    ;;
  *)
    echo "Usage: layout-match-slides.sh [eval|describe|match] [args...]"
    echo "  eval [--candidate N] [--step describe|match|score] [--model MODEL]"
    echo "  describe <slide.png> [--candidate N]"
    echo "  match <slide.png> <template-dir> [--candidate N]"
    exit 1
    ;;
esac
