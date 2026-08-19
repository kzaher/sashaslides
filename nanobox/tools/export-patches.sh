#!/usr/bin/env bash
# Regenerate patches/*.patch from the working trees (bochs/, work/c2w-src, work/wizer-src,
# work/wasi-vfs-src) so that tools/bootstrap.sh can recreate them from upstream. Run after every
# engine/init change (build-all.sh's engine step does).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HERE"
if [ -d bochs/.git ]; then
  (cd bochs && { git diff; git ls-files --others --exclude-standard | grep -v "\.o$\|^bochs/bochs$\|\.wasm$\|config\.\(log\|status\|h\)$\|Makefile$\|ltdlconf\|\.a$\|\.log$\|\.nanobox-mode$\|^build/" | while read f; do git diff --no-index /dev/null "$f" || true; done; }) > patches/bochs-nanobox.patch 2>/dev/null
  echo "patches/bochs-nanobox.patch: $(grep -c '^diff --git' patches/bochs-nanobox.patch) files"
fi
if [ -d work/c2w-src/.git ]; then
  (cd work/c2w-src && git diff -- cmd/init/main.go) > patches/c2w-init-virtio-bundle.patch
  (cd work/c2w-src && git diff -- extras/imagemounter/main.go extras/c2w-net-proxy/main.go) > patches/c2w-imagemounter-notbefore.patch
  (cd work/c2w-src && git diff -- extras/runcontainerjs/src/web/runcontainer.js) > patches/c2w-runcontainer-stream.patch
  (cd work/c2w-src && { git diff -- extras/imagemounter/genspec; git ls-files --others --exclude-standard extras/imagemounter/genspec | while read f; do git diff --no-index /dev/null "$f" || true; done; }) > patches/c2w-imagemounter-genspec.patch 2>/dev/null
  echo "c2w patches regenerated"
fi
[ -d work/wizer-src/.git ] && (cd work/wizer-src && git diff) > patches/wizer-v11-wasm-exceptions.patch && echo "wizer patch regenerated"
[ -d work/wasi-vfs-src/.git ] && (cd work/wasi-vfs-src && git diff) > patches/wasi-vfs-0.6.3-skip-nondir-prestat.patch && echo "wasi-vfs patch regenerated"
