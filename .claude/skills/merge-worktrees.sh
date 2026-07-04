#!/usr/bin/env bash
# merge-worktrees.sh — thin wrapper for merge-worktrees.ts.
# Name the worktrees (path or task name); it extracts each one's converter diff,
# applies them (3-way, resolving overlaps), derives the intended slide set from
# each worktree's before/pptx, typechecks, and runs the pixel-perfect gate.
#   bash .claude/skills/merge-worktrees.sh device-frame-ring metric-pill-center-wrap colored-native-bullets [--commit] [--rate] [--clean]
set -uo pipefail
REPO="${REPO:-/workspaces/sashaslides}"; cd "$REPO"
if [ "$#" -eq 0 ]; then
  echo "usage: merge-worktrees.sh <worktree|taskname> [more...] [--base R --clean --commit --rate --port N --no-gate]" >&2; exit 2
fi
if ! curl -s --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "❌ Chrome not on :9222 (needed for the render gate). Start it, or pass --no-gate." >&2; exit 2
fi
exec npx tsx renderer/structured-prompts/bug_solving/scripts/merge-worktrees.ts --repo "$REPO" "$@"
