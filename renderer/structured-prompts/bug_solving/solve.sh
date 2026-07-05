#!/usr/bin/env bash
# solve.sh — build + launch the bug_solving cluster solver end-to-end.
# Run from the repo root:
#   npm run renderer:solver:run                                  fresh (defaults: --model opus --engine claude)
#   npm run renderer:solver:run -- --model sonnet                pick the solver model
#   npm run renderer:solver:run -- --engine codex                pick the engine
#   npm run renderer:solver:run -- --model haiku --engine codex  both
#   npm run renderer:solver:run -- --attempts 3                  retries per cluster before giving up
#   npm run renderer:solver:run -- --validation-model haiku      cheaper per-slide verdict model
#   npm run renderer:solver:run -- --clean | --continue          discard / resume persisted overlays
#   npm run renderer:solver:run -- --no-regen                   keep hand-edited clusters.ts
#
# --model    = opus | sonnet | haiku | fable   (unsupported → error)
# --engine   = claude | codex                  (unsupported → error)
# --validation-model = opus|sonnet|haiku|fable  (per-slide verdict; default = --model)
# --attempts = positive integer                (overrides per-cluster retry_budget)
#
# Regenerates clusters.ts from the reconciled ledgers on every fresh run (skip
# with --no-regen to keep hand edits; --continue never regenerates), then solves.
# Each fork solves in a JAILED, copy-free overlay sandbox; boots its own rating UI
# and BLOCKS for your good/bad; green forks go through the LLM merge + regression
# gate. Overlays PERSIST — on a re-run the engine makes you pick --clean/--continue.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
BUNDLE="structured-prompting/dist/main-scaffolding.mjs"   # build + launch the SAME path

# --- args: --model / --engine (validated), everything else passed through -------
MODEL="${BUG_SOLVING_MODEL:-opus}"
VALMODEL="${BUG_SOLVING_VALIDATION_MODEL:-}"   # per-slide verdict model; default = solver model
ENGINE="${BUG_SOLVING_ENGINE:-claude}"
ATTEMPTS="${BUG_SOLVING_RETRY_BUDGET:-5}"
REGEN=1          # fresh solve regenerates clusters.ts from the reconciled ledgers
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --model)     MODEL="${2:?--model needs a value}"; shift 2 ;;
    --model=*)    MODEL="${1#*=}"; shift ;;
    --validation-model)  VALMODEL="${2:?--validation-model needs a value}"; shift 2 ;;
    --validation-model=*) VALMODEL="${1#*=}"; shift ;;
    --engine)    ENGINE="${2:?--engine needs a value}"; shift 2 ;;
    --engine=*)   ENGINE="${1#*=}"; shift ;;
    --attempts)  ATTEMPTS="${2:?--attempts needs a value}"; shift 2 ;;
    --attempts=*) ATTEMPTS="${1#*=}"; shift ;;
    --no-regen)  REGEN=0; shift ;;          # keep hand-edited clusters.ts as-is
    --continue)  REGEN=0; PASS+=("$1"); shift ;;  # resume = same clusters, never regen
    *) PASS+=("$1"); shift ;;
  esac
done
[ -n "$VALMODEL" ] || VALMODEL="$MODEL"       # default: verdict uses the solver model
for m in "$MODEL:--model" "$VALMODEL:--validation-model"; do
  case "${m%%:*}" in
    opus|sonnet|haiku|fable) ;;
    *) echo "❌ unsupported ${m#*:} '${m%%:*}' — must be one of: opus | sonnet | haiku | fable" >&2; exit 2 ;;
  esac
done
case "$ENGINE" in
  claude|codex) ;;
  *) echo "❌ unsupported --engine '$ENGINE' — must be one of: claude | codex" >&2; exit 2 ;;
esac
case "$ATTEMPTS" in
  ''|*[!0-9]*) echo "❌ --attempts '$ATTEMPTS' must be a positive integer" >&2; exit 2 ;;
esac
[ "$ATTEMPTS" -ge 1 ] || { echo "❌ --attempts must be >= 1 (got $ATTEMPTS)" >&2; exit 2; }
echo "▶ model=$MODEL  validation-model=$VALMODEL  engine=$ENGINE  attempts=$ATTEMPTS  extra=[${PASS[*]:-}]"

# 0. Regenerate clusters.ts from the reconciled, checked ledgers (one cluster per
#    bad slide). Skipped on --continue (resume must solve the SAME clusters) and
#    --no-regen (preserve hand-enriched descriptions). Attempts are NOT baked in
#    here — --attempts above is the run-level knob.
if [ "$REGEN" = "1" ]; then
  echo "▶ regenerating clusters.ts from reconciled ledgers …"
  npx tsx renderer/structured-prompts/bug_solving/generate-clusters.ts --write
else
  echo "▶ keeping existing clusters.ts (no regen)"
fi

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
 BUG_SOLVING_VALIDATION_MODEL="$VALMODEL" \
BUG_SOLVING_RETRY_BUDGET="$ATTEMPTS" \
BUG_SOLVING_SXS_DIR="${BUG_SOLVING_SXS_DIR:-/tmp/sxs-complex}" \
BUG_SOLVING_RATINGS_JSON="${BUG_SOLVING_RATINGS_JSON:-/tmp/sxs-complex/ratings.json}" \
BUG_SOLVING_FIXTURES_DIR="${BUG_SOLVING_FIXTURES_DIR:-renderer/html2slides/e2e/fixtures}" \
  exec node "$BUNDLE" "--engine=$ENGINE" "${PASS[@]}"
