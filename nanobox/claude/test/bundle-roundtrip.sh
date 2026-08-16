#!/usr/bin/env bash
# JIT bundle round trip: boot codex to its sign-in screen on the optimized engine twice —
#   1. --jit 2:2000 --jit-bundle-out build/eh-nb/jit/codex.nbjb   (compile on the fly, dump every module)
#   2. --jit 2:2   --jit-bundle     build/eh-nb/jit/codex.nbjb    (preload; lookup answers from the bundle)
# and print both wall times, the bundle hit counts, and whether the two runs' [harness] DUMP lines
# (ticks + RIP + RAM SHA-256 at the sign-in snapshot) are identical (harness/compare.mjs) — a bundle
# must not change guest-visible behaviour. A third leg replays at the RECORDING threshold (same
# compile points -> every lookup should hit and nothing should be compiled).
#
#   test/bundle-roundtrip.sh [--engine build/eh-nb/out.wasm] [--out build/eh-nb/jit/codex.nbjb] [--jit1 2:2000] [--jit2 2:2] [--no-same]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
ENGINE="build/eh-nb/out.wasm"; OUT="build/eh-nb/jit/codex.nbjb"; JIT1="2:2000"; JIT2="2:2"; SAME=1
while [ $# -gt 0 ]; do case "$1" in
  --engine) ENGINE="$2"; shift 2 ;; --out) OUT="$2"; shift 2 ;; --jit1) JIT1="$2"; shift 2 ;; --jit2) JIT2="$2"; shift 2 ;; --no-same) SAME=0; shift ;;
  *) echo "unknown arg $1"; exit 2 ;; esac; done
LOGDIR="${LOGDIR:-work/bundle-roundtrip}"; mkdir -p "$LOGDIR" "$(dirname "$OUT")"
BASE="${IMAGE_BASE:-http://localhost:8093}"
# the image comes from serve.mjs (in-memory OCI unpack); start it if nobody did
if ! curl -sf -o /dev/null "$BASE/c2w/images/codex/index.json"; then
  echo "[roundtrip] starting serve.mjs on 8093"
  setsid node serve.mjs > /tmp/serve.log 2>&1 < /dev/null & disown
  for i in $(seq 1 50); do curl -sf -o /dev/null "$BASE/c2w/images/codex/index.json" && break; sleep 0.2; done
fi
run() { # name jit extra-args...
  local name="$1" jit="$2"; shift 2
  local t0 t1
  t0=$(date +%s%N)
  ( cd harness && node run.mjs "../$ENGINE" --oci "$BASE/c2w/images/codex/" --spec ../web/images/codex/config.json \
      --cmd /usr/local/bin/codex --expect "Press enter to continue" --quiet --jit "$jit" "$@" ) > "$LOGDIR/$name.log" 2>&1 || true
  t1=$(date +%s%N)
  WALL=$(( (t1 - t0) / 100000000 )); WALL="$((WALL / 10)).$((WALL % 10))"
  echo "--- $name: --jit $jit $* -> ${WALL}s process wall"
  grep -o '"label":"expect","wallMs":[0-9.]*,"icount":"[0-9]*","ticks":"[0-9]*","rip":"[0-9a-fx]*"' "$LOGDIR/$name.log" | head -1 || echo "  (no expect dump: see $LOGDIR/$name.log)"
  grep -o '"jit":{[^}]*}' "$LOGDIR/$name.log" | tail -1 || true
  grep '\[harness\] \(JIT bundle\|engine trapped\)' "$LOGDIR/$name.log" || true
}
echo "=== 1. record: --jit $JIT1 --jit-bundle-out $OUT"
run record "$JIT1" --jit-bundle-out "../$OUT"
[ -f "$OUT" ] || { echo "no bundle written"; exit 1; }
ls -la "$OUT"
echo "=== 2. replay: --jit $JIT2 --jit-bundle $OUT"
run replay "$JIT2" --jit-bundle "../$OUT"
echo "=== compare DUMP lines (record vs replay)"
rc=0; node harness/compare.mjs "$LOGDIR/record.log" "$LOGDIR/replay.log" || rc=1
if [ "$SAME" = 1 ]; then
  echo "=== 3. replay at the recording threshold: --jit $JIT1 --jit-bundle $OUT"
  run replay-same "$JIT1" --jit-bundle "../$OUT"
  echo "=== compare DUMP lines (record vs replay-same)"
  node harness/compare.mjs "$LOGDIR/record.log" "$LOGDIR/replay-same.log" || rc=1
fi
exit $rc
