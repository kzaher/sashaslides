#!/usr/bin/env bash
# THE build: everything that is not in git, in dependency order, incrementally (a step runs only
# when its output is missing or older than its inputs; `--force` redoes everything; a single step:
# `./build-all.sh <step>`). `npm run build` = this; `npm start` = this + serve.
#
#   bootstrap    tools/bootstrap.sh: bochs clone+patch, c2w sources, toolchains, patched wizer/wasi-vfs, guest pack
#   shim         guest/nbnode/build.sh -> guest/nbnode/nbnode, web/native/nbnode          (docker alpine gcc)
#   runtime      web/native: npm ci + build.mjs -> web/native/runtime.js                    (esbuild)
#   vendor       @xterm/* from node_modules -> public/vm/vendor/
#   c2w          the ORIGINAL container2wasm runtime + codex/agy/claude images: vm-build/build.sh (docker, long) — only if missing
#   images       build-linux-base.sh (sandbox pages), build-claude-npm.sh                  (docker)
#   imagemounter build-imagemounter.sh -> build/imagemounter-nb.wasm.gzip                 (docker golang)
#   engine       build-bochs.sh eh-nb -> build/eh-nb/{out,out-slim}.wasm(.gzip)             (~6 min)
#   ref          build-bochs.sh ref-nb --legacy (reference engine for the identity tests)  (~6 min)
#   bundles      test/record-bundles.sh -> build/eh-nb/jit/*.nbjb (starts a temporary server if none) (~1 min)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE"
FORCE=0; STEPS=(); for a in "$@"; do case "$a" in --force) FORCE=1 ;; *) STEPS+=("$a") ;; esac; done
[ ${#STEPS[@]} -gt 0 ] || STEPS=(bootstrap shim runtime vendor c2w images imagemounter engine ref bundles)
log() { printf '\033[1;35m[build]\033[0m %s\n' "$*"; }
newer() { # newer OUT IN... : true when OUT exists and is not older than any IN
  [ "$FORCE" = 0 ] && [ -e "$1" ] || return 1; local out="$1"; shift
  for i in "$@"; do [ -e "$i" ] && [ "$i" -nt "$out" ] && return 1; done; return 0
}
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
for step in "${STEPS[@]}"; do case "$step" in
  bootstrap)
    if newer work/toolchain/wizer-eh && newer bochs/bochs/nanobox_jit.cc && newer work/pack-out-nb/pack/rootfs.bin && [ "$FORCE" = 0 ]; then log "bootstrap: up to date"; else ./tools/bootstrap.sh $([ "$FORCE" = 1 ] && echo --force); fi ;;
  shim)
    if newer web/native/nbnode guest/nbnode/nbnode.c guest/nbnode/build.sh; then log "shim: up to date"; else log "shim"; (cd guest/nbnode && ./build.sh); fi ;;
  runtime)
    if newer web/native/runtime.js web/native/src web/native/build.mjs web/native/package.json && [ -d web/native/node_modules ]; then log "runtime: up to date"; else log "runtime"; (cd web/native && npm ci --no-audit --no-fund >/dev/null && node build.mjs); fi ;;
  vendor)
    if newer public/vm/vendor/xterm.js node_modules/@xterm/xterm/lib/xterm.js; then log "vendor: up to date"; else log "vendor"; mkdir -p public/vm/vendor; cp node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css public/vm/vendor/; cp node_modules/@xterm/addon-fit/lib/addon-fit.js public/vm/vendor/; fi ;;
  c2w)
    if [ -f public/c2w/wasi/out.wasm.gzip ] && [ -d public/c2w/images/codex ] && [ "$FORCE" = 0 ]; then log "c2w runtime + images: present"; else log "c2w runtime + images (vm-build/build.sh, docker, long)"; ./vm-build/build.sh; fi ;;
  images)
    if newer public/c2w/images/linux-base/index.json guest/linux-base/Dockerfile build-linux-base.sh; then log "linux-base image: up to date"; else log "linux-base image"; ./build-linux-base.sh; fi
    if newer public/c2w/images/claude-npm/index.json guest/claude-npm/Dockerfile build-claude-npm.sh; then log "claude-npm image: up to date"; else log "claude-npm image"; ./build-claude-npm.sh; fi ;;
  imagemounter)
    if newer build/imagemounter-nb.wasm.gzip patches/c2w-imagemounter-notbefore.patch build-imagemounter.sh; then log "imagemounter: up to date"; else log "imagemounter"; ./build-imagemounter.sh; fi ;;
  engine)
    if newer build/eh-nb/out.wasm.gzip bochs/bochs/nanobox_jit.cc bochs/bochs/nanobox.cc bochs/bochs/wasm.cc bochs/bochs/wasm.h bochs/bochs/cpu/icache.h bochs/bochs/cpu/cpu.cc build-bochs.sh work/pack-out-nb/pack/rootfs.bin && [ -f build/eh-nb/out-slim.wasm.gzip ]; then log "engine: up to date"; else
      log "engine (build-bochs.sh eh-nb, ~6 min)"; ./tools/export-patches.sh; ./build-bochs.sh eh-nb --pack work/pack-out-nb/pack
      for v in out out-slim; do rm -f build/eh-nb/$v.wasm.gz build/eh-nb/$v.wasm.gzip; gzip -9 -k build/eh-nb/$v.wasm && mv build/eh-nb/$v.wasm.gz build/eh-nb/$v.wasm.gzip; done
      # a rebuilt engine invalidates the JIT bundles (engine tag) — record them again in the bundles step
      rm -f build/eh-nb/jit/*.nbjb
    fi ;;
  ref)
    if newer build/ref-nb/out.wasm bochs/bochs/nanobox_jit.cc bochs/bochs/nanobox.cc bochs/bochs/wasm.cc bochs/bochs/wasm.h bochs/bochs/cpu/icache.h bochs/bochs/cpu/cpu.cc build-bochs.sh work/pack-out-nb/pack/rootfs.bin; then log "reference engine: up to date"; else log "reference engine (build-bochs.sh ref-nb --legacy, ~6 min)"; ./build-bochs.sh ref-nb --legacy --pack work/pack-out-nb/pack; fi ;;
  bundles)
    if [ "$FORCE" = 0 ] && [ -f build/eh-nb/jit/kernel.nbjb ] && [ -f build/eh-nb/jit/codex.nbjb ]; then log "JIT bundles: present"; else
      log "JIT bundles (record-bundles.sh)"
      if curl -sf -o /dev/null http://localhost:8093/c2w/images/codex/index.json; then ./test/record-bundles.sh > work/prof/record-bundles.log 2>&1 || true
      else node serve.mjs --port 8097 > /dev/null 2>&1 & SP=$!; sleep 1; IMAGE_BASE=http://localhost:8097/c2w/images ./test/record-bundles.sh > work/prof/record-bundles.log 2>&1 || true; kill $SP 2>/dev/null || true; fi
      grep -E "bundle written" work/prof/record-bundles.log | cut -c1-120 || true
    fi ;;
  *) echo "unknown step: $step (bootstrap shim runtime vendor c2w images imagemounter engine ref bundles)" >&2; exit 2 ;;
esac; done
log "done"
