#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR/scripts"

# Install deps if needed
if [ ! -d node_modules ]; then
  npm install
fi

npx tsx extract-slides.ts "$@"
