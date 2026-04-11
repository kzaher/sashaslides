#!/bin/bash
set -e
cd /workspaces/sashaslides/sashaslides/claude-composer
echo "=== Installing dependencies ==="
npm install
echo "=== Building ==="
npx tsc
echo "=== Done — output in dist/ ==="
