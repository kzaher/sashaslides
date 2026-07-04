#!/usr/bin/env bash
# accept-solved-bugs.sh — accept GREEN bug_solving fixes ONE CLUSTER AT A TIME,
# with a HUMAN verifying that no UNRELATED slide regressed before a cluster is kept.
#
# KEY INSIGHT: a cluster's OWN targeted slides were already rated good (that is why
# it is green), so on accept only the RIPPLE (slides it changed that it did NOT
# target) needs fresh verification — the ripple slides are the potential regressions.
#
# You run this REPEATEDLY. Each run drives the loop until a cluster needs review:
#   run 1 : classify + walk green clusters. NO-ripple clusters auto-accept; the
#           first RIPPLED cluster renders + boots a rating UI FILTERED to the
#           ripple, then exits.  → rate every RIPPLED slide.
#   run 2+: finalize the reviewed cluster (KEEP if every rippled slide is good,
#           REVERT if any was bad/unrated), then walk the next clusters.
#   … until it prints "ACCEPT COMPLETE".
#
# Invariant: a cluster is kept only if it either changed no slides outside its own
# already-approved set, or you confirm no regression on every rippled slide —
# otherwise it is reverted and the accepted state is untouched. The human is the
# gate on rippled clusters (there is no --yes); no-ripple clusters auto-accept.
# In a NON-interactive shell (no TTY) rippled clusters are rejected by default.
# Operates on its OWN staging worktree + its OWN rating-UI ports; never touches
# the running scaffolding/monitor.
#
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh                 # drive the loop (default: merge+render+classify / keep-or-revert)
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --target main   # land accepted clusters onto main
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --reset         # drop staging worktree + state, re-classify
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --no-commit     # report-only: show the next step, change nothing
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --non-interactive  # reject rippled clusters by default (no rating UI)
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --only pseudo-glyph-center  # accept ONLY this cluster (accepts just slide_04)
#   bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --skip device-frame-ring    # exclude these cluster task_ids
# --only <task[,task...]> restricts eligibility to exactly these cluster task_ids (others are ignored
#   entirely — not even classified as pending); --skip <task[,task...]> excludes them. Both match the
#   cluster `task` slug (the bs-<task>-<ts> worktree name minus prefix/timestamp).
set -uo pipefail
REPO="${REPO:-/workspaces/sashaslides}"; cd "$REPO"
if ! curl -s --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "❌ Chrome not on :9222 (each step renders the deck). Start it first." >&2; exit 2
fi
exec npx tsx renderer/structured-prompts/bug_solving/scripts/accept-solved-bugs.ts --repo "$REPO" "$@"
