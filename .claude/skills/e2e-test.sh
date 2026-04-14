#!/usr/bin/env bash
set -euo pipefail
cd /workspaces/sashaslides/analysis/renderer/html2slides
exec npx tsx e2e/pipeline.ts "$@"
