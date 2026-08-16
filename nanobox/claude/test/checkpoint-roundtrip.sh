#!/usr/bin/env bash
# Checkpoint round trip: boot codex on the optimized engine three times —
#   1. record:   JIT off, `--cmd "sh -c 'echo @@NANOBOX-DUMP:s1@@ && exec /usr/local/bin/codex'"`,
#                --checkpoint-out FILE --checkpoint-at s1   (memory + JS state captured at the s1 marker)
#   2. restore:  --checkpoint FILE --jit 2:2000             (resume there, JIT on)
#   3. straight: --jit 2:2000                               (the reference: same command, no checkpoint)
# and require the [harness] DUMP lines of 2 and 3 to be identical (harness/compare.mjs: label, ticks,
# RIP, RAM SHA-256, block map — a restored run must be indistinguishable from an uninterrupted one),
# printing the wall times so the saving is visible. Both use --oci-cache (the decompressed-layer cache).
#
#   test/checkpoint-roundtrip.sh [--engine build/eh-nb/out.wasm] [--out work/checkpoints/codex-s1.nbck] [--jit 2:2000] [--gz]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
ENGINE="build/eh-nb/out.wasm"; OUT="work/checkpoints/codex-s1.nbck"; JIT="2:2000"; GZ=""
while [ $# -gt 0 ]; do case "$1" in
  --engine) ENGINE="$2"; shift 2 ;; --out) OUT="$2"; shift 2 ;; --jit) JIT="$2"; shift 2 ;; --gz) GZ="--checkpoint-gz"; shift ;;
  *) echo "unknown arg $1"; exit 2 ;; esac; done
LOGDIR="${LOGDIR:-work/checkpoint-roundtrip}"; mkdir -p "$LOGDIR" "$(dirname "$OUT")"
OCI_CACHE="${OCI_CACHE:-work/oci-cache}"
BASE="${IMAGE_BASE:-http://localhost:8093}"
# the image comes from serve.mjs (in-memory OCI unpack); start it if nobody did
if ! curl -sf -o /dev/null "$BASE/c2w/images/codex/index.json"; then
  echo "[roundtrip] starting serve.mjs on 8093"
  setsid node serve.mjs > /tmp/serve.log 2>&1 < /dev/null & disown
  for i in $(seq 1 50); do curl -sf -o /dev/null "$BASE/c2w/images/codex/index.json" && break; sleep 0.2; done
fi
CMD="sh -c 'echo @@NANOBOX-DUMP:s1@@ && exec /usr/local/bin/codex'"
run() { # name extra-args...
  local name="$1"; shift
  local t0 t1
  t0=$(date +%s%N)
  ( cd harness && node run.mjs "../$ENGINE" --oci "$BASE/c2w/images/codex/" --oci-cache "../$OCI_CACHE" --spec ../web/images/codex/config.json \
      --cmd "$CMD" --expect "Press enter to continue" --quiet "$@" ) > "$LOGDIR/$name.log" 2>&1 || true
  t1=$(date +%s%N)
  WALL=$(( (t1 - t0) / 100000000 )); WALL="$((WALL / 10)).$((WALL % 10))"
  echo "--- $name: $* -> ${WALL}s process wall"
  grep -o '\[harness\] OCI image[^;]*' "$LOGDIR/$name.log" | sed 's/^/  /' || true
  grep '\[harness\] \(CHECKPOINT\|RESTORE\|EXPECT\|engine trapped\)' "$LOGDIR/$name.log" | sed 's/^/  /' || echo "  (no expect: see $LOGDIR/$name.log)"
  grep -o '"jit":{[^}]*}' "$LOGDIR/$name.log" | tail -1 | sed 's/^/  /' || true
}
echo "=== 1. record (JIT off): --checkpoint-out $OUT --checkpoint-at s1 $GZ"
run record --checkpoint-out "../$OUT" --checkpoint-at s1 $GZ
[ -f "$OUT" ] || { echo "no checkpoint written"; exit 1; }
ls -la "$OUT"
echo "=== 2. restore: --checkpoint $OUT --jit $JIT"
run restore --checkpoint "../$OUT" --jit "$JIT"
echo "=== 3. straight: --jit $JIT"
run straight --jit "$JIT"
echo "=== compare DUMP lines (restore vs straight)"
rc=0; node harness/compare.mjs "$LOGDIR/restore.log" "$LOGDIR/straight.log" || rc=1
echo "=== compare DUMP lines (record vs straight: JIT off vs on, sanity)"
node harness/compare.mjs "$LOGDIR/record.log" "$LOGDIR/straight.log" || rc=1
exit $rc
