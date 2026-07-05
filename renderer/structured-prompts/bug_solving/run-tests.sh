#!/usr/bin/env bash
# run-tests.sh — run the bug_solving test suite. Invoked from the ROOT via:
#   npm run test:bug-solving     # all unit + integration + e2e tests
#   npm run test:e2e             # only the *e2e* tests (real overlay/git; nothing but recording+LLM mocked)
# Exits non-zero on the first failing file. Run from repo root (npm sets cwd there).
set -uo pipefail
DIR="renderer/structured-prompts/bug_solving"
mode="${1:-all}"
if [ "$mode" = "--e2e" ] || [ "$mode" = "e2e" ]; then
  mapfile -t files < <(ls "$DIR"/*e2e*.test.ts 2>/dev/null)
  echo "== bug_solving E2E tests =="
else
  mapfile -t files < <(ls "$DIR"/*.test.ts "$DIR"/scripts/*.test.ts 2>/dev/null)
  echo "== bug_solving full suite =="
fi
fail=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  printf '\n--- %s ---\n' "$f"
  if ! npx tsx "$f"; then fail=1; fi
done
echo
[ "$fail" -eq 0 ] && echo "ALL GREEN" || { echo "SOME FAILED"; exit 1; }
