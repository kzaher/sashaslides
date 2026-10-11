#!/usr/bin/env bash
# Everything that must follow an engine rebuild, unattended: wait for build/eh-nb.log to say
# BUILD-DONE, regenerate the served gzip, run the correctness gate (identity + bisect), re-record the
# pre-computed bundles, and time codex/agy in the harness. Report: work/gate/after-build.md (ends
# with AFTER-BUILD-DONE). Launch detached right after starting the build:
#   setsid ./test/after-build.sh > work/gate/after-build.log 2>&1 < /dev/null & disown
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HERE"
mkdir -p work/gate; REP=work/gate/after-build.md; : > "$REP"
say() { echo "$*" | tee -a "$REP"; }
until grep -q BUILD-DONE build/eh-nb.log 2>/dev/null; do sleep 5; done
say "# after-build $(date -u +%FT%TZ): $(tail -1 build/eh-nb.log)"
grep -q "rc=0" build/eh-nb.log || { say "build failed"; say "AFTER-BUILD-DONE rc=1"; exit 1; }
rm -f build/eh-nb/out.wasm.gz build/eh-nb/out.wasm.gzip; gzip -9 -k build/eh-nb/out.wasm && mv build/eh-nb/out.wasm.gz build/eh-nb/out.wasm.gzip   # -9: 36 MB vs 40 MB at -1
[ -f build/eh-nb/out-slim.wasm ] && { rm -f build/eh-nb/out-slim.wasm.gz build/eh-nb/out-slim.wasm.gzip; gzip -9 -k build/eh-nb/out-slim.wasm && mv build/eh-nb/out-slim.wasm.gz build/eh-nb/out-slim.wasm.gzip; }
say "engine $(sha256sum build/eh-nb/out.wasm | cut -c1-12), $(stat -c %s build/eh-nb/out.wasm) bytes; gzip regenerated"
say ""; say "## gate"; ./test/gate.sh > work/gate/gate-run.log 2>&1; grc=$?
grep -E "IDENTITY|BISECT|RESULT|no divergence|DIVERGENCE" work/gate/latest.md | cut -c1-200 | sed 's/^/    /' | tee -a "$REP"
say ""; say "## bundles"; ./test/record-bundles.sh > work/prof/record-bundles.log 2>&1; grep -E "^===|bundle written" work/prof/record-bundles.log | cut -c1-160 | sed 's/^/    /' | tee -a "$REP"
say ""; say "## harness timing (OCI cache, bundles, --jit 2:2000, 2 runs each)"
cd "$HERE/harness"; REP="$HERE/$REP"
for img in codex agy; do
  if [ $img = codex ]; then EX=(--expect "Press enter to continue"); else EX=(--expect-re "sign in|log in|google|authenticate|antigravity\.google|paste.*code"); fi
  for r in 1 2; do
    t=$(timeout 60 node run.mjs ../build/eh-nb/out.wasm --oci http://localhost:8093/c2w/images/$img/ --spec ../web/images/$img/config.json --oci-cache ../work/oci-cache --cmd /usr/local/bin/$img "${EX[@]}" --quiet --no-hash --jit 2:2000 --jit-bundle ../build/eh-nb/jit/kernel.nbjb --jit-bundle ../build/eh-nb/jit/$img.nbjb --timeout 55 2>&1 | grep -o '"label":"expect","wallMs":[0-9.]*' | head -1 | cut -d: -f3)
    say "    $img run $r: ${t:-FAILED} ms"
  done
done
cd "$HERE"; say ""; say "AFTER-BUILD-DONE rc=$grc"
