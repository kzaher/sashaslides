#!/usr/bin/env bash
# solve.sh — build + launch the bug_solving cluster solver end-to-end.
# Run from the repo root:
#   npm run solve                                  fresh (defaults: --model opus --engine claude)
#   npm run solve -- --model sonnet                pick the solver model
#   npm run solve -- --engine codex                pick the engine
#   npm run solve -- --model haiku --engine codex  both
#   npm run solve -- --clean | --continue          discard / resume persisted overlays
#
# --model  = opus | sonnet | haiku | fable   (unsupported → error)
# --engine = claude | codex                  (unsupported → error)
#
# Solves the clusters in clusters.ts (regenerate with `npm run solve:clusters`).
# Each fork solves in a JAILED, copy-free overlay sandbox; boots its own rating UI
# and BLOCKS for your good/bad; green forks go through the LLM merge + regression
# gate. Overlays PERSIST — on a re-run the engine makes you pick --clean/--continue.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
BUNDLE="structured-prompting/dist/main-scaffolding.mjs"   # build + launch the SAME path

# --- args: --model / --engine (validated), everything else passed through -------
MODEL="${BUG_SOLVING_MODEL:-opus}"
ENGINE="${BUG_SOLVING_ENGINE:-claude}"
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --model)   MODEL="${2:?--model needs a value}"; shift 2 ;;
    --model=*)  MODEL="${1#*=}"; shift ;;
    --engine)  ENGINE="${2:?--engine needs a value}"; shift 2 ;;
    --engine=*) ENGINE="${1#*=}"; shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done
case "$MODEL" in
  opus|sonnet|haiku|fable) ;;
  *) echo "❌ unsupported --model '$MODEL' — must be one of: opus | sonnet | haiku | fable" >&2; exit 2 ;;
esac
case "$ENGINE" in
  claude|codex) ;;
  *) echo "❌ unsupported --engine '$ENGINE' — must be one of: claude | codex" >&2; exit 2 ;;
esac
echo "▶ model=$MODEL  engine=$ENGINE  extra=[${PASS[*]:-}]"

# 1. Chrome on :9222 (rendering needs it) — start if absent.
if ! curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "▶ starting headless Chrome on :9222 …"
  setsid google-chrome-stable --headless=new --remote-debugging-port=9222 --no-sandbox \
    --user-data-dir=/tmp/chrome-cdp >/tmp/chrome.log 2>&1 < /dev/null & disown
  for i in $(seq 1 25); do curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 1; done
fi
curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 || { echo "❌ Chrome not on :9222"; exit 1; }

# 2. Build the bundle (into structured-prompting/dist, where preact + the workspace lib resolve).
echo "▶ building $BUNDLE …"
npx tsx structured-prompting/build.ts renderer/structured-prompts/bug_solving/main-scaffolding.ts "$BUNDLE"

# 3. Show the clusters actually baked into the bundle (catch a stale build).
echo "▶ clusters in bundle:"
grep -oE 'slide-[0-9]+-[a-z-]+' "$BUNDLE" | sort -u | sed 's/^/    /' || true

# 4. Launch (foreground so you see the monitor + rating URLs; Ctrl-C to stop).
#    --model → BUG_SOLVING_MODEL, --engine → the scaffolding --engine flag; the
#    fixture/SxS/ratings dirs default to the complex set (override by exporting).
echo "▶ launching solver (Ctrl-C to stop) …"
BUG_SOLVING_MODEL="$MODEL" \
BUG_SOLVING_SXS_DIR="${BUG_SOLVING_SXS_DIR:-/tmp/sxs-complex}" \
BUG_SOLVING_RATINGS_JSON="${BUG_SOLVING_RATINGS_JSON:-/tmp/sxs-complex/ratings.json}" \
BUG_SOLVING_FIXTURES_DIR="${BUG_SOLVING_FIXTURES_DIR:-renderer/html2slides/e2e/fixtures}" \
  exec node "$BUNDLE" "--engine=$ENGINE" "${PASS[@]}"
