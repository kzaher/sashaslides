#!/usr/bin/env bash
# The split view's guest-side mechanism, verified WITHOUT a browser (repeatable after any engine change).
#
#   test/split-shell-guest.sh [ENGINE] [--cols N] [--rows N]
#
# It boots the guest with a foreground program on the container console AND the nanobox shim started
# beside it as a background service (exactly what web/sandbox.html?shell=1 does for codex/agy), then
# drives the shim from the host: spawn /bin/sh -i on a pty, pin that pty to the SHELL PANE's geometry
# with CHILD_RESIZE, and assert that
#   * the shim's HELLO shows it is NOT holding the console's stdin (isatty bit0 clear),
#   * `stty size` inside the shell equals the pane geometry, not the console's,
#   * the shell can write and read a file in the same guest, and `ps` sees the other processes.
# (the foreground program loops forever: the guest clock runs many times wall time, so a plain
#  `sleep 120` ends the container mid-test.)
# Prints SHIM-BESIDE-OK / SHIM-BESIDE-FAIL; exit code 0 only on OK.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${1:-$HERE/build/eh-nb/out.wasm}"; [ "${1:-}" != "" ] && [ "${1:0:2}" != "--" ] && shift
COLS=137; ROWS=41
while [ $# -gt 0 ]; do case "$1" in --cols) COLS="$2"; shift 2;; --rows) ROWS="$2"; shift 2;; *) shift;; esac; done
OUT="$HERE/work/prof/split-shell"; mkdir -p "$OUT"
LOG="$OUT/shim-beside.log"
cd "$HERE/harness"
NBNODE_TEST_MODE=shell NB_SHELL_COLS="$COLS" NB_SHELL_ROWS="$ROWS" timeout 220 node run.mjs "$ENGINE" \
  --oci http://localhost:8093/c2w/images/codex/ --spec ../test/hc-test-spec.json --oci-cache ../work/oci-cache \
  --bundle-file nb/node=../guest/nbnode/nbnode \
  --cmd '/bin/sh -c "NBNODE_NO_STDIN=1 /bundle/nb/node </dev/null >/dev/null & echo CLI-IS-RUNNING; while true; do sleep 60; done"' \
  --nbnode-test --jit 2:2000 --expect "SHIM-BESIDE" --timeout 200 > "$LOG" 2>&1
grep -aE "CLI-IS-RUNNING|nbnode-test" "$LOG"
grep -aq "SHIM-BESIDE-OK" "$LOG" && { echo "SHIM-BESIDE-OK (log: $LOG)"; exit 0; }
echo "SHIM-BESIDE-FAIL (log: $LOG)"; exit 1
