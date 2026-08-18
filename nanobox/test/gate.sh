#!/usr/bin/env bash
# The unattended correctness gate for the optimized engine. One command, no interaction: it runs
#   1. test/identity.sh (codex + agy: reference engine vs optimized+JIT, ticks + RAM SHA-256),
#   2. harness/bisect.mjs on codex, interpreter (A) vs JIT (B, --jit 2:200 by default = many more
#      compiled traces than the production 2:2000), chained state fingerprints every 100 K traces
#      and, on the first differing block, per-trace detail down to the diverging instruction,
# and writes one report to work/gate/latest.md (+ the raw logs next to it). Meant to be launched
# detached after every engine build; read the report when it says GATE-DONE.
#
#   test/gate.sh [--jit L:T] [--bisect-jit L:T] [--run-timeout S] [--skip-bisect] [--skip-identity]
#   env: NANOBOX_JIT_MERGE=1 etc. are inherited by every run (identity + both bisect sides).
#
# Exit code: 0 = identity identical AND no divergence; 1 otherwise. The report always exists.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JIT="2:2000"; BJIT="2:200"; RT="${RUN_TIMEOUT:-120}"; DO_B=1; DO_I=1
while [ $# -gt 0 ]; do case "$1" in
  --jit) JIT="$2"; shift 2 ;; --bisect-jit) BJIT="$2"; shift 2 ;; --run-timeout) RT="$2"; shift 2 ;;
  --skip-bisect) DO_B=0; shift ;; --skip-identity) DO_I=0; shift ;; *) echo "unknown arg $1"; exit 2 ;; esac; done
OUT="$HERE/work/gate"; mkdir -p "$OUT"
REP="$OUT/latest.md"; : > "$REP"
OPT="${OPT:-$HERE/build/eh-nb/out.wasm}"
say() { echo "$*" | tee -a "$REP"; }
say "# gate $(date -u +%FT%TZ) — engine $(sha256sum "$OPT" | cut -c1-12) (jit $JIT, bisect B --jit $BJIT, run-timeout ${RT}s)"
say "env: NANOBOX_JIT_MERGE=${NANOBOX_JIT_MERGE:-} NANOBOX_JIT_EAGER=${NANOBOX_JIT_EAGER:-}"
rc=0
if [ $DO_I = 1 ]; then
  say ""; say "## identity (reference vs optimized+JIT)"
  # The identity leg compares the reference interpreter build against the optimized+JIT build. Both
  # normally carry a wizer pre-init snapshot, and the two wizer versions (v3 for the legacy build, the
  # EH fork for the optimized one) feed slightly different host inputs during that pre-init: on the
  # no-codegen kernel image the snapshots landed 715 k instructions apart and everything downstream
  # differed in interrupt phase — while the same two engines built WITHOUT the snapshot were IDENTICAL
  # from a cold boot (2026-08-18). So when no-wizer builds exist, identity uses them; the bisect below
  # (interpreter vs JIT inside the SAME snapshot build) is unaffected either way.
  IREF="${IREF:-$HERE/build/ref-nowiz/out.wasm}"; IOPT="${IOPT:-$HERE/build/eh-nowiz/out.wasm}"
  if [ -f "$IREF" ] && [ -f "$IOPT" ]; then say "identity engines: cold-boot builds (no wizer snapshot)"; else IREF="$HERE/build/ref-nb/out.wasm"; IOPT="$OPT"; fi
  if REF="$IREF" OPT="$IOPT" "$HERE/test/identity.sh" both --jit "$JIT" > "$OUT/identity.log" 2>&1; then say "IDENTITY: identical (codex + agy)"; else say "IDENTITY: **DIFFERENT** — see work/gate/identity.log"; rc=1; fi
  grep -E '^===|IDENTICAL|DIFFER|"label":"expect"' "$OUT/identity.log" | sed 's/^/    /' | tee -a "$REP"
fi
if [ $DO_B = 1 ]; then
  say ""; say "## bisect codex: interpreter vs --jit $BJIT (every 100 K traces)"
  ( cd "$HERE/harness" && node bisect.mjs "$OPT" "$OPT" --b-args "--jit $BJIT" --ignore-icount --run-timeout "$RT" -- \
      --oci http://localhost:8093/c2w/images/codex/ --spec ../web/images/codex/config.json --oci-cache ../work/oci-cache \
      --cmd /usr/local/bin/codex --expect "Press enter to continue" --quiet ) > "$OUT/bisect.log" 2>&1
  brc=$?
  if [ $brc = 0 ]; then say "BISECT: no divergence"; else say "BISECT: **DIVERGENCE** (rc=$brc) — see work/gate/bisect.log"; rc=1; fi
  grep -E 'no divergence|A-chain|B-chain|first differing|DIVERGENCE|differs in|culprit|last identical' "$OUT/bisect.log" | cut -c1-400 | sed 's/^/    /' | tee -a "$REP"
fi
say ""; say "GATE-DONE rc=$rc"
exit $rc
