#!/usr/bin/env bash
# Build the container2wasm assets nanobox serves at /c2w/.
#
#   ./vm-build/build.sh runtimes     # the two CPU-emulator runtimes (slow: ~25 min, needs Docker)
#   ./vm-build/build.sh images       # the guest images -> OCI layouts under public/c2w/images/
#   ./vm-build/build.sh browser      # the browser glue (webpack bundles + imagemounter.wasm)
#   ./vm-build/build.sh all
#
# Everything it writes under public/c2w/ is a build artifact and is gitignored; this script is the
# source of truth for how to get it back.
#
# Requires a working Docker daemon. Inside a devcontainer that usually means the rootless setup in
# ./start-docker.sh (plain dockerd cannot start containers there) — which also means the `vfs`
# storage driver, where every layer is a full copy: the runtime build can eat >100 GB of scratch.
# `docker system prune -af` between runs is safe; nothing here depends on the daemon's image store
# once the artifacts are under public/c2w/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOBOX="$(dirname "$HERE")"
OUT="$NANOBOX/public/c2w"
WORK="${C2W_WORK:-/tmp/nanobox-c2w}"
C2W_VERSION="${C2W_VERSION:-v0.8.4}"
# 1024 MB is not arbitrary: at 1792 MB this qemu-wasm build dies during boot with
# "TypeError: Cannot convert undefined to a BigInt" in TCI's ffi_call, whatever the core count.
VM_MEMORY_SIZE_MB="${VM_MEMORY_SIZE_MB:-1024}"
IMAGES="${IMAGES:-base claude codex agy}"

export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

mkdir -p "$WORK" "$OUT"

# --- sources ------------------------------------------------------------------------------------
fetch_sources() {
  if [ ! -x "$WORK/c2w/c2w" ]; then
    log "downloading c2w $C2W_VERSION"
    curl -sSL -o "$WORK/c2w.tgz" \
      "https://github.com/container2wasm/container2wasm/releases/download/$C2W_VERSION/container2wasm-${C2W_VERSION}-linux-amd64.tar.gz"
    mkdir -p "$WORK/c2w" && tar xzf "$WORK/c2w.tgz" -C "$WORK/c2w"
  fi
  if [ ! -d "$WORK/c2w-src" ]; then
    log "cloning container2wasm $C2W_VERSION (build assets + browser glue)"
    git clone -q --depth 1 -b "$C2W_VERSION" https://github.com/container2wasm/container2wasm "$WORK/c2w-src"
  fi
  # The shipped Dockerfile mknod()s /dev/null while building the VM's initrd. Rootless BuildKit has
  # no CAP_MKNOD, and the guest gets a real /dev from the kernel anyway, so fall back to a placeholder.
  if [ ! -f "$WORK/c2w.Dockerfile" ]; then
    "$WORK/c2w/c2w" --show-dockerfile > "$WORK/c2w.orig.Dockerfile"
    sed 's|mknod /rootfs/dev/null c 1 3|{ mknod /rootfs/dev/null c 1 3 \|\| touch /rootfs/dev/null ; }|g' \
      "$WORK/c2w.orig.Dockerfile" > "$WORK/c2w.Dockerfile"
  fi

  # NOTE: do not add `-cpu` to config/qemu/args-x86_64.json.template. It is tempting (the stock CPU
  # has no AES/PCLMUL/AVX2, which is why agy and claude SIGILL on the QEMU engine) but *any* explicit
  # -cpu, even a plain `-cpu qemu64`, makes this qemu-wasm build die inside TCI's helper dispatch:
  #   TypeError: Cannot convert undefined to a BigInt   at ffi_call / tcg_qemu_tb_exec_tci
  # The page can still override it per-boot via ?cpu=..., which is how that was established.
}

# --- the two runtimes ---------------------------------------------------------------------------
# Both are built with --external-bundle: the container image is NOT baked into the wasm, it is
# fetched over HTTP at boot and mounted into the VM over 9p. One runtime, any number of images.
build_runtimes() {
  fetch_sources
  log "building QEMU->wasm runtime (emscripten, JIT) — this is the slow one"
  mkdir -p "$OUT/qemu"
  "$WORK/c2w/c2w" --assets "$WORK/c2w-src" --dockerfile "$WORK/c2w.Dockerfile" \
    --external-bundle --to-js --build-arg "VM_MEMORY_SIZE_MB=$VM_MEMORY_SIZE_MB" "$OUT/qemu/"

  log "building WASI runtime (Bochs, single .wasm)"
  mkdir -p "$WORK/wasi"
  "$WORK/c2w/c2w" --assets "$WORK/c2w-src" --dockerfile "$WORK/c2w.Dockerfile" \
    --external-bundle --build-arg "VM_MEMORY_SIZE_MB=$VM_MEMORY_SIZE_MB" "$WORK/wasi/out.wasm"
  # the WASI loader fetches a gzipped module
  gzip -kf9 "$WORK/wasi/out.wasm" && mkdir -p "$OUT/wasi" && mv -f "$WORK/wasi/out.wasm.gz" "$OUT/wasi/out.wasm.gzip"
}

# --- browser glue -------------------------------------------------------------------------------
build_browser() {
  fetch_sources
  log "building runcontainer.js / stack-worker.js / worker-util.js"
  ( cd "$WORK/c2w-src/extras/runcontainerjs" && npm install --silent --no-audit --no-fund && npx webpack )
  mkdir -p "$OUT/dist" && cp -f "$WORK/c2w-src/extras/runcontainerjs/dist/"*.js "$OUT/dist/"

  log "building imagemounter.wasm (pulls the OCI image into the browser, serves it over 9p)"
  mkdir -p "$WORK/c2w-src/out"
  docker run --rm -v "$WORK/c2w-src:/src" -w /src/extras/imagemounter golang:1.26-bookworm \
    sh -c 'GOOS=wasip1 GOARCH=wasm go build -o /src/out/imagemounter.wasm .'
  gzip -kf9 "$WORK/c2w-src/out/imagemounter.wasm"
  mv -f "$WORK/c2w-src/out/imagemounter.wasm.gz" "$OUT/imagemounter.wasm.gzip"

  # xterm + xterm-pty are vendored rather than pulled from a CDN: the page is cross-origin isolated
  # (COEP require-corp), which is exactly the setting where third-party CDN scripts get blocked.
  log "vendoring xterm + xterm-pty"
  mkdir -p "$OUT/vendor"
  curl -sSL -o "$OUT/vendor/xterm.js"       https://unpkg.com/xterm@5.3.0/lib/xterm.js
  curl -sSL -o "$OUT/vendor/xterm.css"      https://unpkg.com/xterm@5.3.0/css/xterm.css
  curl -sSL -o "$OUT/vendor/xterm-pty.js"   https://unpkg.com/xterm-pty@0.9.4/index.js
  curl -sSL -o "$OUT/vendor/workerTools.js" https://unpkg.com/xterm-pty@0.9.4/workerTools.js
  curl -sSL -o "$OUT/vendor/addon-fit.js"   https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js
}

# --- guest images -------------------------------------------------------------------------------
# `docker save` already emits an OCI Image Layout, which is what the browser-side imagemounter wants
# — except that its layers are uncompressed, and the mounter's gzip path is the only one that works
# in the browser (see oci-gzip.mjs), so each layout gets recompressed on the way out.
build_images() {
  log "building guest images: $IMAGES"
  for i in $IMAGES; do
    ( cd "$HERE" && docker build --target "nanobox-$i" -t "nanobox-$i" . )
    rm -rf "$OUT/images/$i" && mkdir -p "$OUT/images/$i"
    docker save "nanobox-$i" | tar -x -C "$OUT/images/$i"
    # docker's extra bookkeeping files confuse nothing, but the layout only needs these:
    rm -f "$OUT/images/$i/manifest.json" "$OUT/images/$i/repositories"
    node "$HERE/oci-gzip.mjs" "$OUT/images/$i"
    printf '  %-8s %s\n' "$i" "$(du -sh "$OUT/images/$i" | cut -f1)"
  done
}

case "${1:-all}" in
  runtimes) build_runtimes ;;
  browser)  build_browser ;;
  images)   build_images ;;
  all)      build_runtimes; build_browser; build_images ;;
  *) echo "usage: $0 [runtimes|browser|images|all]" >&2; exit 2 ;;
esac

log "done. artifacts in $OUT"
du -sh "$OUT"/* 2>/dev/null || true
