#!/usr/bin/env bash
# run-tests.sh — run the bug_solving test suite. Invoked from the ROOT via:
#   npm run renderer:solver:all-tests     # all unit + integration + e2e tests
#   npm run renderer:solver:e2e-tests             # only the *e2e* tests (real overlay/git; nothing but recording+LLM mocked)
# Exits non-zero on the first failing file. Run from repo root (npm sets cwd there).
set -uo pipefail
# The paths below are repo-relative. Run from anywhere else they matched nothing and the script
# printed ALL GREEN over zero tests (measured 2026-10-16), so it moves to the root itself.
cd "$(dirname "$0")/../../.." || exit 1
DIR="renderer/structured-prompts/bug_solving"
mode="${1:-all}"
if [ "$mode" = "--e2e" ] || [ "$mode" = "e2e" ]; then
  mapfile -t files < <(ls "$DIR"/*e2e*.test.ts 2>/dev/null)
  echo "== E2E tests (bug_solving) — real overlays; only recording+LLM mocked =="
else
  mapfile -t files < <(ls "$DIR"/*.test.ts "$DIR"/scripts/*.test.ts 2>/dev/null)
  echo "== full suite (bug_solving) =="
fi
# cow-workspace's OWN tests are not run here. They need vitest, Docker and its upstream
# /workspaces/scripts/elevation-guard.mjs, none of which this repository has (measured 2026-10-16:
# 7 of its 8 files failed on those alone). The e2e files above exercise the library the way
# bug_solving uses it; the package itself is tested with its own runner (cow-workspace/package.json).
echo "(cow-workspace's own tests: cd cow-workspace && npm test, in its upstream environment)"
[ "${#files[@]}" -gt 0 ] || { echo "❌ no test files found under $DIR"; exit 1; }
fail=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  printf '\n--- %s ---\n' "$f"
  if ! npx tsx "$f"; then fail=1; fi
done
echo
[ "$fail" -eq 0 ] && echo "ALL GREEN" || { echo "SOME FAILED"; exit 1; }
