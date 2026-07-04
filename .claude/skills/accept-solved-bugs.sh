#!/usr/bin/env bash
# accept-solved-bugs.sh — auto-accept GREEN bug_solving fixes via an intermediate
# worktree that is promoted to the target branch ONLY if no unrelated slide
# regresses; otherwise the whole worktree is discarded.
#   bash .claude/skills/accept-solved-bugs.sh            # dry run: classify + gate, promote nothing
#   bash .claude/skills/accept-solved-bugs.sh --yes      # actually promote-or-discard
#   bash .claude/skills/accept-solved-bugs.sh --yes --target main --rerecord --discard-red
set -uo pipefail
REPO="${REPO:-/workspaces/sashaslides}"; cd "$REPO"
if ! curl -s --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "❌ Chrome not on :9222 (the gate renders the deck). Start it first." >&2; exit 2
fi
exec npx tsx renderer/structured-prompts/bug_solving/scripts/accept-solved-bugs.ts --repo "$REPO" "$@"
