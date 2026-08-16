#!/usr/bin/env bash
# Build the tier-1 test guest: compile guest/tests/*.c (static, haswell), bake them into a busybox
# image, and turn that image into a container2wasm /pack (kernel + initramfs + rootfs.bin) with the
# same Dockerfile/kernel/config the production engine uses — only the container image and the
# bochsrc knobs differ.
#
#   ./build-guest.sh [--mem MB] [--time0 EPOCH]      -> work/pack-test/pack
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEM=1024; TIME0=1700000000
while [ $# -gt 0 ]; do case "$1" in --mem) MEM="$2"; shift;; --time0) TIME0="$2"; shift;; *) echo "bad arg $1" >&2; exit 2;; esac; shift; done
log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

log "compiling guest tests"
mkdir -p "$HERE/guest/tests/bin"
for c in "$HERE"/guest/tests/*.c; do
  n="$(basename "$c" .c)"
  gcc -O2 -static -march=haswell -maes -mpclmul -o "$HERE/guest/tests/bin/$n" "$c" -lm 2>&1 | grep -v -i warning || true
  [ -x "$HERE/guest/tests/bin/$n" ]
done

log "building + saving OCI image nanobox-claude-testguest"
( cd "$HERE/guest" && docker build -q -t nanobox-claude-testguest . )
OCI="$HERE/work/testguest-oci"; rm -rf "$OCI"; mkdir -p "$OCI"
docker save nanobox-claude-testguest | tar -x -C "$OCI"
# same trick as c2w: bump mtimes so buildkit prefers these over cached copies
find "$OCI" -exec touch {} +

log "building /pack via the c2w Dockerfile (target vm-amd64-dev, embedded bundle)"
OUT="$HERE/work/pack-test"; rm -rf "$OUT"; mkdir -p "$OUT"
docker buildx build --progress=plain \
  --build-arg TARGETARCH=amd64 --build-arg TARGETPLATFORM=linux/amd64 --platform=linux/amd64 \
  -f "$HERE/work/c2w.patched.Dockerfile" --build-context assets="$HERE/work/c2w-src" \
  --target=vm-amd64-dev --output type=local,dest="$OUT" \
  --build-arg OUTPUT_NAME=out.wasm --build-arg LINUX_LOGLEVEL=0 --build-arg INIT_DEBUG=false \
  --build-arg VM_MEMORY_SIZE_MB="$MEM" \
  "$OCI" > "$HERE/work/build-guest.log" 2>&1 || { tail -30 "$HERE/work/build-guest.log"; exit 1; }
# deterministic clock: a fixed CMOS start time instead of the build machine's wall clock
sed -i "s/time0=local/time0=$TIME0/" "$OUT/pack/bochsrc"
cat "$OUT/pack/bochsrc"
ls -la "$OUT/pack"
