#!/usr/bin/env bash
# Entrypoint for the sasha-slides skill: preconditions, the E2E harness, and its gates.
#
# The MCP tools themselves are called over MCP, not from here — this script covers the
# things a shell is better at: proving auth works before a proposal touches Drive, and
# running the harness that keeps the protocol honest.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
harness="$repo/mcp/sasha-slides/e2e/run-e2e.ts"
product="$repo/mcp/sasha-slides/e2e/product-e2e.ts"
check_auth="$repo/.auth/check-auth.ts"

usage() {
  cat <<'TXT'
usage: .agent/skills/sasha-slides/sasha-slides.sh <command> [args]

  check [--write]     Google auth precondition. --write also proves a Slides create +
                      Drive delete. Exit 0 means a proposal may touch real Drive.
  phases              list the E2E phases and every harness flag
  e2e [flags]         run the harness (default: --drive fake, every phase)
  e2e --drive real --only propose
                      one phase against real Drive, to stay inside a 30s command budget
  product [flags]     the FULL PRODUCT E2E against real Google: the real picker bundle in
                      Chrome :9223, a real proposal on real Drive, a real batchUpdate into
                      the deck. ONE STEP PER COMMAND (each must fit the 30s cap):
                        product --step host     start/await the local Sidebar.html host
                        product --step propose  stage 4 fixtures to real Drive
                        product --step open     mount the picker in Chrome :9223
                        product --step picker   4 numbered candidates, HTML pane, toggle
                        product --step pick     pick option 2 -> batchUpdate + PICK
                        product --step verify   presentations.get: native objects + geometry
                        product --step cleanup  delete the proposal, keep the deck
  selftest            prove the harness's assertions bite: one clean run that must pass,
                      plus one injected protocol violation per invariant that must fail
  typecheck           tsc --noEmit over the harness (tsx only strips types), including the
                      browser-side google.script.run shim the product E2E serves

Examples
  .agent/skills/sasha-slides/sasha-slides.sh check --write
  .agent/skills/sasha-slides/sasha-slides.sh e2e
  .agent/skills/sasha-slides/sasha-slides.sh e2e --drive real --only propose,layout
  .agent/skills/sasha-slides/sasha-slides.sh selftest
  .agent/skills/sasha-slides/sasha-slides.sh product --list
  .agent/skills/sasha-slides/sasha-slides.sh product --step host
TXT
}

command="${1:-}"
shift || true

case "$command" in
  check)
    exec npx tsx "$check_auth" "$@"
    ;;

  phases)
    exec npx tsx "$harness" --list
    ;;

  e2e)
    cd "$repo"
    exec npx tsx "$harness" "$@"
    ;;

  product)
    cd "$repo"
    exec npx tsx "$product" "$@"
    ;;

  typecheck)
    cd "$repo"
    npx tsc -p mcp/sasha-slides/e2e
    # The shim ships into a browser, so it has its own DOM-only project with no node types.
    exec npx tsc -p mcp/sasha-slides/e2e/product-shim
    ;;

  selftest)
    cd "$repo"
    work="$repo/mcp/sasha-slides/e2e/.work-selftest"
    failures=0

    echo "--- clean run must PASS ---"
    rm -rf "$work"
    if npx tsx "$harness" --work "$work" --only fixtures,propose,layout,pick,await,cleanup > /dev/null 2>&1; then
      echo "  ok   clean run exited 0"
    else
      echo "  FAIL clean run exited non-zero — re-run without the redirect to see why"
      failures=$((failures + 1))
    fi

    # Each injected violation must turn a phase red. A fault that still exits 0 means the
    # assertion for that invariant is not actually checking anything.
    for fault in ready-early drop-slide tamper-pick; do
      echo "--- --inject $fault must FAIL ---"
      rm -rf "$work"
      if npx tsx "$harness" --work "$work" --inject "$fault" \
          --only fixtures,propose,layout,pick,await > /dev/null 2>&1; then
        echo "  FAIL --inject $fault exited 0; the assertion for it is asleep"
        failures=$((failures + 1))
      else
        echo "  ok   --inject $fault exited non-zero"
      fi
    done

    rm -rf "$work"
    if [[ "$failures" -gt 0 ]]; then
      echo "selftest: $failures problem(s)"
      exit 1
    fi
    echo "selftest: the harness passes a correct run and rejects every injected violation"
    ;;

  ""|-h|--help|help)
    usage
    ;;

  *)
    echo "unknown command: $command" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
