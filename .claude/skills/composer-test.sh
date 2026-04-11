#!/bin/bash
set -e
cd /workspaces/sashaslides/sashaslides/claude-composer
echo "=== Type checking ==="
npx tsc --noEmit
echo "=== Running tests ==="
npx vitest run
