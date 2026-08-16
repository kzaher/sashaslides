#!/usr/bin/env bash
# Re-record the pre-computed JIT bundles for the current optimized engine build (they are keyed by
# an engine tag = length + sha256(head/tail MiB) and are rejected after any engine rebuild):
#   kernel.nbjb  — the boot up to a trivial /bin/true (shared by every image: same kernel)
#   <image>.nbjb — codex, agy, claude to their sign-in screens
# All recordings use the page-eager sweep (NANOBOX_JIT_EAGER=1: compile every trace reachable in a
# page once one trace in it is hot) so the bundle covers whole pages. Sequential (each run pins one
# core; claude ≈ 60 s), meant to be launched detached:
#   setsid ./test/record-bundles.sh [all|"kernel codex"] > work/prof/record-bundles.log 2>&1 &
# Progress/report: work/prof/record-bundles.log ends with RECORD-DONE.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE/harness"
ENGINE="${ENGINE:-../build/eh-nb/out.wasm}"; JITDIR="${JITDIR:-../build/eh-nb/jit}"; mkdir -p "$JITDIR"
BASE="${IMAGE_BASE:-http://localhost:8093/c2w/images}"
COMMON=(--oci-cache ../work/oci-cache --quiet --no-hash)
# onboarding prompts that stand between boot and the sign-in screen (claude only; codex's sign-in
# screen itself says "Press enter to continue" — answering it would record traces past the sign-in)
CLAUDE_REPLIES=(--reply "do you trust|trust the files=\r" --reply "choose the text style|dark mode|light mode=\r" --reply "press enter to continue|continue\?=\r")
rec() { # name image jit args...
  local name=$1 img=$2 jit=$3; shift 3
  echo "=== $name ($img, --jit $jit eager) $(date -u +%T)"
  NANOBOX_JIT_EAGER=1 timeout 300 node run.mjs "$ENGINE" --oci "$BASE/$img/" --spec "../web/images/$img/config.json" "${COMMON[@]}" \
      --jit "$jit" --jit-bundle-out "$JITDIR/$name.nbjb" "$@" 2>&1 | grep -E "bundle written|\"label\":\"expect\"|SUMMARY|error|Error" | cut -c1-300
}
ONLY="${1:-all}"
want() { [ "$ONLY" = all ] || [[ " $ONLY " == *" $1 "* ]]; }
want kernel && rec kernel codex 2:500 --cmd /bin/true --timeout 280
want codex && rec codex  codex 2:2000 --cmd /usr/local/bin/codex --expect "Press enter to continue" --timeout 280
want agy && rec agy    agy   2:2000 --cmd /usr/local/bin/agy --expect-re "sign in|log in|google|authenticate|antigravity\.google|paste.*code" --timeout 280
want claude && rec claude claude 2:1000 "${CLAUDE_REPLIES[@]}" --cmd "/bin/env NODE_EXTRA_CA_CERTS=/.wasmenv/proxy.crt /usr/local/bin/claude" \
    --expect-re "sign in|log in|claude\.ai/oauth|authenticate|subscription|api key|browser didn't open" --timeout 280
ls -la "$JITDIR"
echo "RECORD-DONE"
