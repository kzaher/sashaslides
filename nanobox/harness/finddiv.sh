#!/usr/bin/env bash
# finddiv.sh <engine.wasm> "<jit args>" [cmd] — locate the first trace where a JIT run diverges from
# the interpreter run of the same engine (uses the fingerprint log; two passes: coarse then fine).
set -e
E="$1"; JIT="$2"; CMD="${3:-sh -c 'echo @@NANOBOX-DUMP:s0@@'}"
S=/tmp/claude-1000/-workspaces-sashaslides/6a72a994-eabe-47a6-9643-d8feb033a6a5/scratchpad
node run.mjs "$E" --no-stdin $EXTRA --cmd "$CMD" --quiet --dbg 1:${EVERY:-100000} --dbg-out $S/fd-ref.log --timeout 600 >/dev/null 2>&1
node run.mjs "$E" --no-stdin $EXTRA --cmd "$CMD" --quiet $JIT --dbg 1:${EVERY:-100000} --dbg-out $S/fd-jit.log --timeout 600 >/dev/null 2>&1
L=$(diff <(grep -v "^M" $S/fd-ref.log) <(grep -v "^M" $S/fd-jit.log) | grep -m1 '^[0-9]' | grep -o '^[0-9]*') || true
if [ -z "$L" ]; then echo "no divergence in coarse log"; exit 0; fi
BLK=$(grep -v "^M" $S/fd-ref.log | sed -n "${L}p" | awk '{print $2}')
FROM=$((BLK-${EVERY:-100000})); TO=$BLK
echo "coarse divergence in [$FROM,$TO)"
node run.mjs "$E" --no-stdin $EXTRA --cmd "$CMD" --quiet --dbg 2:0:$FROM:$TO --dbg-out $S/fd-ref2.log --timeout 600 >/dev/null 2>&1
node run.mjs "$E" --no-stdin $EXTRA --cmd "$CMD" --quiet $JIT --dbg 2:0:$FROM:$TO --dbg-out $S/fd-jit2.log --timeout 600 >/dev/null 2>&1
grep -v "^M" $S/fd-ref2.log > $S/fd-ref2t.log; grep -v "^M" $S/fd-jit2.log > $S/fd-jit2t.log
L2=$(diff <(cut -d' ' -f1,2,4- $S/fd-ref2t.log) <(cut -d' ' -f1,2,4- $S/fd-jit2t.log) | grep -m1 '^[0-9]' | grep -o '^[0-9]*') || true
echo "first divergent line: $L2"
echo "--- ref (2 before + diverging):"; sed -n "$((L2-2)),$((L2))p" $S/fd-ref2t.log | cut -c1-1200
echo "--- jit:"; sed -n "$((L2-2)),$((L2))p" $S/fd-jit2t.log | cut -c1-1200
