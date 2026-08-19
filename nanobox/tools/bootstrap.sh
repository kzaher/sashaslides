#!/usr/bin/env bash
# One-time setup of everything gitignored that the engine build needs (idempotent: every step is
# skipped when its output exists; `--force` redoes all). Called by build-all.sh; run alone to just
# prepare. Needs: git, curl, tar, xz, docker (rootless: DOCKER_HOST, see vm-build/start-docker.sh),
# and either cargo or network access for rustup (the patched wizer and wasi-vfs are built from source).
#
#   bochs/                     ktock/Bochs @ a88d1f6 + patches/bochs-nanobox.patch (the engine)
#   work/c2w-src/              container2wasm v0.8.4 + patches/c2w-*.patch (guest init, imagemounter, genspec)
#   work/toolchain/wasi-sdk-33.0-x86_64-linux, binaryen-version_132, wasmtime-v47.0.3-x86_64-linux
#   work/toolchain/wizer-eh (+ wizer11-include/wizer.h)   wizer v11.0.3 + patches/wizer-v11-wasm-exceptions.patch
#   work/toolchain/wasi-vfs-0.6.3/wasi-vfs (+ wasi-vfs-0.6.3-nanobox/libwasi_vfs.a)   wasi-vfs 0.6.3 (+ prestat patch for the lib)
#   legacy (reference engine, --legacy): wasi-sdk-19.0, binaryen-version_114, wizer-v3.0.1-x86_64-linux, wasi-vfs (0.3.0), wizer-include/wizer.h
#   work/pack-out-nb/pack      guest pack (kernel+init rootfs.bin+BIOS+bochsrc), vm-build/pack/build-pack.sh (docker, ~10 min)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HERE"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
TC="$HERE/work/toolchain"; mkdir -p "$TC" work
log() { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
have() { [ "$FORCE" = 0 ] && [ -e "$1" ]; }
dl() { # url dest
  [ -e "$2" ] && [ "$FORCE" = 0 ] && return 0
  log "download $(basename "$2")"; curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}
untar() { # archive dir-to-check
  have "$2" || { log "unpack $(basename "$1")"; tar -C "$TC" -xf "$1"; }
}

# ---- sources ------------------------------------------------------------------------------------
if ! have bochs/bochs/nanobox_jit.cc; then
  [ -d bochs/.git ] || { log "clone ktock/Bochs"; git clone -q https://github.com/ktock/Bochs bochs; }
  (cd bochs && git checkout -q a88d1f687 && git apply "$HERE/patches/bochs-nanobox.patch") && log "bochs patched"
fi
if ! have work/c2w-src/extras/imagemounter/genspec/main.go; then
  [ -d work/c2w-src/.git ] || { log "clone container2wasm v0.8.4"; git clone -q --branch v0.8.4 --depth 1 https://github.com/container2wasm/container2wasm work/c2w-src; }
  (cd work/c2w-src && for p in c2w-init-virtio-bundle c2w-imagemounter-genspec c2w-imagemounter-notbefore c2w-runcontainer-stream; do git apply "$HERE/patches/$p.patch" || true; done) && log "c2w patched"
fi

# ---- prebuilt toolchains -------------------------------------------------------------------------
dl https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz "$TC/wasi-sdk-33.0-x86_64-linux.tar.gz"; untar "$TC/wasi-sdk-33.0-x86_64-linux.tar.gz" "$TC/wasi-sdk-33.0-x86_64-linux"
dl https://github.com/WebAssembly/binaryen/releases/download/version_132/binaryen-version_132-x86_64-linux.tar.gz "$TC/binaryen-version_132.tar.gz"; untar "$TC/binaryen-version_132.tar.gz" "$TC/binaryen-version_132"
dl https://github.com/bytecodealliance/wasmtime/releases/download/v47.0.3/wasmtime-v47.0.3-x86_64-linux.tar.xz "$TC/wasmtime-v47.0.3-x86_64-linux.tar.xz"; untar "$TC/wasmtime-v47.0.3-x86_64-linux.tar.xz" "$TC/wasmtime-v47.0.3-x86_64-linux"
# legacy toolchain (reference engine)
dl https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-19/wasi-sdk-19.0-linux.tar.gz "$TC/wasi-sdk-19.0-linux.tar.gz"; untar "$TC/wasi-sdk-19.0-linux.tar.gz" "$TC/wasi-sdk-19.0"
dl https://github.com/WebAssembly/binaryen/releases/download/version_114/binaryen-version_114-x86_64-linux.tar.gz "$TC/binaryen-version_114.tar.gz"; untar "$TC/binaryen-version_114.tar.gz" "$TC/binaryen-version_114"
dl https://github.com/bytecodealliance/wizer/releases/download/v3.0.1/wizer-v3.0.1-x86_64-linux.tar.xz "$TC/wizer-v3.0.1-x86_64-linux.tar.xz"; untar "$TC/wizer-v3.0.1-x86_64-linux.tar.xz" "$TC/wizer-v3.0.1-x86_64-linux"
if ! have "$TC/wasi-vfs/wasi-vfs"; then
  mkdir -p "$TC/wasi-vfs"
  dl https://github.com/kateinoigakukun/wasi-vfs/releases/download/v0.3.0/wasi-vfs-cli-x86_64-unknown-linux-gnu.zip "$TC/wasi-vfs-cli-0.3.0.zip"
  dl https://github.com/kateinoigakukun/wasi-vfs/releases/download/v0.3.0/libwasi_vfs-wasm32-unknown-unknown.zip "$TC/libwasi_vfs-0.3.0.zip"
  (cd "$TC/wasi-vfs" && unzip -qo ../wasi-vfs-cli-0.3.0.zip && unzip -qo ../libwasi_vfs-0.3.0.zip) && log "wasi-vfs 0.3.0 (legacy)"
fi
have "$TC/wizer-include/wizer.h" || { mkdir -p "$TC/wizer-include"; dl https://raw.githubusercontent.com/bytecodealliance/wizer/v3.0.1/include/wizer.h "$TC/wizer-include/wizer.h"; }

# ---- from source: wizer (wasm-EH aware) and wasi-vfs 0.6.3 (patched prestat scan) --------------------
need_cargo() { command -v cargo >/dev/null 2>&1 && return 0; [ -x "$HOME/.cargo/bin/cargo" ] && { export PATH="$HOME/.cargo/bin:$PATH"; return 0; }
  log "installing rust (rustup)"; curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal >/dev/null; export PATH="$HOME/.cargo/bin:$PATH"; }
if ! have "$TC/wizer-eh"; then
  need_cargo
  [ -d work/wizer-src/.git ] || { log "clone wizer v11.0.3"; git clone -q --branch v11.0.3 --depth 1 https://github.com/bytecodealliance/wizer work/wizer-src; }
  (cd work/wizer-src && git apply "$HERE/patches/wizer-v11-wasm-exceptions.patch" 2>/dev/null || true; log "cargo build wizer (minutes)"; cargo build -q --release --features env_logger 2>&1 | tail -3 || cargo build -q --release 2>&1 | tail -3)
  cp work/wizer-src/target/release/wizer "$TC/wizer-eh"; mkdir -p "$TC/wizer11-include"; cp work/wizer-src/include/wizer.h "$TC/wizer11-include/wizer.h"
fi
if ! have "$TC/wasi-vfs-0.6.3-nanobox/libwasi_vfs.a"; then
  need_cargo; rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
  [ -d work/wasi-vfs-src/.git ] || { log "clone wasi-vfs v0.6.3"; git clone -q --branch v0.6.3 --depth 1 https://github.com/kateinoigakukun/wasi-vfs work/wasi-vfs-src; }
  (cd work/wasi-vfs-src && log "cargo build wasi-vfs cli"; cargo build -q --release -p wasi-vfs-cli 2>&1 | tail -3
   mkdir -p "$TC/wasi-vfs-0.6.3"; cp target/release/wasi-vfs "$TC/wasi-vfs-0.6.3/wasi-vfs"
   git apply "$HERE/patches/wasi-vfs-0.6.3-skip-nondir-prestat.patch" 2>/dev/null || true
   log "cargo build libwasi_vfs (patched, wasm32)"; cargo build -q --release --target wasm32-unknown-unknown -p wasi-vfs 2>&1 | tail -3
   mkdir -p "$TC/wasi-vfs-0.6.3-nanobox"; cp target/wasm32-unknown-unknown/release/libwasi_vfs.a "$TC/wasi-vfs-0.6.3-nanobox/libwasi_vfs.a")
fi

# ---- guest pack (kernel + patched init) --------------------------------------------------------------
if ! have work/pack-out-nb/pack/rootfs.bin; then
  log "building the guest pack with docker (kernel + init rootfs, ~10 min)"
  ./vm-build/pack/build-pack.sh
fi
log "done: $(ls "$TC" | tr '\n' ' ')"
