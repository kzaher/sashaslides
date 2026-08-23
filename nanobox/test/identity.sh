#!/usr/bin/env bash
# Memory-identity E2E: boot an agent image to its sign-in screen on the REFERENCE engine
# (upstream toolchain: wasi-sdk 19 + Asyncify, interpreter only — build/ref-nb) and on the OPTIMIZED
# engine (wasi-sdk 33 + native wasm EH + trace JIT — build/eh-nb), under the deterministic harness
# (frozen host clock, scripted console, netstub network, in-memory OCI rootfs), take a snapshot of
# all guest RAM the moment the sign-in text reaches the console and compare: ticks + RIP + SHA-256
# of every RAM block must match.
#
#   test/identity.sh [codex|agy|both] [--jit L:T] [--fresh]
#                    [--criteria ram|heap+syscalls|heap+syscalls-norm|heap+syscalls-normbij]
#   (default: both, --jit 2:2000, --criteria ram; the reference run is memoized per reference-engine
#   build under work/identity/ref-cache/)
#
# --criteria heap+syscalls is the SECOND oracle (work/prof/oracle.md): instead of ticks + a SHA-256
# of ALL guest RAM it asserts (a) every guest-physical page that is NOT a call-stack page has the
# same content, and (b) the ordered guest syscall trace -- number, args, return, and the bytes of
# write-like calls -- matches line for line. Stack pages are the ones the CPU itself resolved its
# stack window to (Bochs stackPrefetch), taken from the REFERENCE side only so the engine under test
# cannot excuse a difference by calling a page a stack. It needs the oracle-instrumented engines
# (build/oracle-ref-nowiz + build/oracle-eh-nowiz, built from work/j/oracle/bochs) and never memoizes
# the reference run, because the run has to produce the page hashes, the stack map and the trace.
#
# --criteria heap+syscalls-norm is the same oracle with the syscall half compared TICK-INSENSITIVELY:
# up to a consistent renaming of the addresses the guest derived from its own clock (mmap hints, ASLR
# bases, brk results), so an AOT-mode engine -- whose tick count legitimately differs -- can be
# compared at all. See harness/sysnorm.mjs and TASKS.md V.9. It is a strict addition: on a pair whose
# ticks match, no renaming is ever established and the result is identical to `heap+syscalls`.
# `-normbij` additionally lets two values inside the same renamed region bind 1:1 on first sight
# (it reaches further into an AOT trace and is measurably blunter -- V.9 has the numbers).
#
# claude is excluded on purpose: Claude Code's preflight needs a live https://api.anthropic.com
# (see README) so its sign-in screen is not reachable in a network-free deterministic run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE/harness"
WHICH="${1:-both}"; shift || true
JIT="2:2000"; FRESH=0; CRIT="ram"
while [ $# -gt 0 ]; do case "$1" in --jit) JIT="$2"; shift 2 ;; --fresh) FRESH=1; shift ;; --criteria) CRIT="$2"; shift 2 ;; *) echo "unknown arg $1"; exit 2 ;; esac; done
case "$CRIT" in ram|heap+syscalls|heap+syscalls-norm|heap+syscalls-normbij) ;;
  *) echo "unknown --criteria $CRIT (ram | heap+syscalls | heap+syscalls-norm | heap+syscalls-normbij)"; exit 2 ;; esac
NORM=()
case "$CRIT" in heap+syscalls-norm) NORM=(--normalise-addresses delta) ;; heap+syscalls-normbij) NORM=(--normalise-addresses bij) ;; esac
case "$CRIT" in heap+syscalls*) ORACLE_ENG=1 ;; *) ORACLE_ENG=0 ;; esac
if [ "$ORACLE_ENG" = 1 ]; then
  REF="${REF:-../build/oracle-ref-nowiz/out.wasm}"; OPT="${OPT:-../build/oracle-eh-nowiz/out.wasm}"
  FRESH=1                      # the reference run must produce the page hashes / stack map / trace
else
  REF="${REF:-../build/ref-nb/out.wasm}"; OPT="${OPT:-../build/eh-nb/out.wasm}"
fi
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
    ORACLE=()
    [ "$ORACLE_ENG" = 1 ] && ORACLE=(--page-hash "$OUT/$img-$side.ph" --stack-map "$OUT/$img-$side.smap" --syscall-trace "$OUT/$img-$side.sys")
    [ "$ORACLE_ENG" = 1 ] && rm -f "$OUT/$img-$side.ph"
    ( time node run.mjs "$E" --oci "$BASE/$img/" --spec "../web/images/$img/config.json" --cmd "${CMD[$img]}" \
        --reply "do you trust|trust the files=\r" ${EXPECT_KIND[$img]} "${EXPECT[$img]}" --quiet $J "${ORACLE[@]}" \
        > "$OUT/$img-$side.log" 2>&1 ) 2>&1 | grep real
    [ $side = ref ] && grep -q '"label":"expect"' "$OUT/$img-ref.log" && cp "$OUT/$img-ref.log" "$CACHE"
    grep -o '"label":"expect","wallMs":[0-9.]*,"icount":"[0-9]*","ticks":"[0-9]*","rip":"[0-9a-fx]*"' "$OUT/$img-$side.log" | head -1 || true
    grep -o '"jit":{[^}]*}' "$OUT/$img-$side.log" | tail -1 || true
  done
  if [ "$ORACLE_ENG" = 1 ]; then
    grep -o '"stackMap":{[^}]*}' "$OUT/$img-ref.log" | tail -1 || true
    node compare-heap.mjs --a "$OUT/$img-ref" --b "$OUT/$img-opt" "${NORM[@]}" --json "$OUT/$img-heap.json" || rc=1
  else
    node compare.mjs "$OUT/$img-ref.log" "$OUT/$img-opt.log" || rc=1
  fi
done
exit $rc
