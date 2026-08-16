#!/usr/bin/env bash
# Memory-identity E2E: boot an agent image to its sign-in screen on the REFERENCE engine
# (upstream toolchain: wasi-sdk 19 + Asyncify, interpreter only — build/ref-nb) and on the OPTIMIZED
# engine (wasi-sdk 33 + native wasm EH + trace JIT — build/eh-nb), under the deterministic harness
# (frozen host clock, scripted console, netstub network, in-memory OCI rootfs), take a snapshot of
# all guest RAM the moment the sign-in text reaches the console and compare: ticks + RIP + SHA-256
# of every RAM block must match.
#
#   test/identity.sh [codex|agy|both] [--jit L:T] [--fresh]   (default: both, --jit 2:2000; the
#   reference run is memoized per reference-engine build under work/identity/ref-cache/)
#
# claude is excluded on purpose: Claude Code's preflight needs a live https://api.anthropic.com
# (see README) so its sign-in screen is not reachable in a network-free deterministic run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE/harness"
WHICH="${1:-both}"; shift || true
JIT="2:2000"; FRESH=0
while [ $# -gt 0 ]; do case "$1" in --jit) JIT="$2"; shift 2 ;; --fresh) FRESH=1; shift ;; *) echo "unknown arg $1"; exit 2 ;; esac; done
REF="${REF:-../build/ref-nb/out.wasm}"; OPT="${OPT:-../build/eh-nb/out.wasm}"
OUT="${OUT:-../work/identity}"; mkdir -p "$OUT"
BASE="${IMAGE_BASE:-http://localhost:8093/c2w/images}"
declare -A CMD=( [codex]="/usr/local/bin/codex" [agy]="/usr/local/bin/agy" )
declare -A EXPECT=( [codex]="Press enter to continue" [agy]="sign in|log in|google|authenticate|antigravity\.google|paste.*code" )
declare -A EXPECT_KIND=( [codex]="--expect" [agy]="--expect-re" )
# The reference run is memoized: its DUMP lines only depend on the reference engine build, the
# image and the command, so cache them under work/identity/ref-cache/<image>-<engine sha>.log and
# skip the (slow, Asyncify) reference boot on later runs. `--fresh` re-records.
REFHASH=$(sha256sum "$REF" | cut -c1-16)
mkdir -p "$OUT/ref-cache"
rc=0
for img in $( [ "$WHICH" = both ] && echo codex agy || echo "$WHICH" ); do
  echo "=== $img"
  for side in ref opt; do
    E="$REF"; J=""; [ $side = opt ] && { E="$OPT"; J="--jit $JIT"; }
    CACHE="$OUT/ref-cache/$img-$REFHASH.log"
    if [ $side = ref ] && [ $FRESH = 0 ] && [ -s "$CACHE" ]; then
      echo "--- ref: memoized ($CACHE)"; cp "$CACHE" "$OUT/$img-ref.log"
      grep -o '"label":"expect","wallMs":[0-9.]*,"icount":"[0-9]*","ticks":"[0-9]*","rip":"[0-9a-fx]*"' "$OUT/$img-$side.log" | head -1 || true
      continue
    fi
    echo "--- $side: $(basename $(dirname $E)) $J"
    ( time node run.mjs "$E" --oci "$BASE/$img/" --spec "../web/images/$img/config.json" --cmd "${CMD[$img]}" \
        --reply "do you trust|trust the files=\r" ${EXPECT_KIND[$img]} "${EXPECT[$img]}" --quiet $J \
        > "$OUT/$img-$side.log" 2>&1 ) 2>&1 | grep real
    [ $side = ref ] && grep -q '"label":"expect"' "$OUT/$img-ref.log" && cp "$OUT/$img-ref.log" "$CACHE"
    grep -o '"label":"expect","wallMs":[0-9.]*,"icount":"[0-9]*","ticks":"[0-9]*","rip":"[0-9a-fx]*"' "$OUT/$img-$side.log" | head -1 || true
    grep -o '"jit":{[^}]*}' "$OUT/$img-$side.log" | tail -1 || true
  done
  node compare.mjs "$OUT/$img-ref.log" "$OUT/$img-opt.log" || rc=1
done
exit $rc
