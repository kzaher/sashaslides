#!/usr/bin/env bash
# Build a tier-1 /pack from the production `nanobox-base` image (the 3.9 MB glibc Ubuntu the agent
# images are built on): the harness then mounts the real agent binaries via 9p and runs them.
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG="${1:-base}"; MEM="${MEM:-1024}"; TIME0="${TIME0:-1700000000}"
SRC="$HERE/../public/c2w/images/$IMG"
OUT="$HERE/work/pack-$IMG"; rm -rf "$OUT"; mkdir -p "$OUT"
docker buildx build --progress=plain \
  --build-arg TARGETARCH=amd64 --build-arg TARGETPLATFORM=linux/amd64 --platform=linux/amd64 \
  -f "$HERE/work/c2w.patched.Dockerfile" --build-context assets="$HERE/work/c2w-src" \
  --target=vm-amd64-dev --output type=local,dest="$OUT" \
  --build-arg OUTPUT_NAME=out.wasm --build-arg LINUX_LOGLEVEL=0 --build-arg INIT_DEBUG=false \
  --build-arg VM_MEMORY_SIZE_MB="$MEM" \
  "$SRC" > "$HERE/work/build-guest-$IMG.log" 2>&1 || { tail -30 "$HERE/work/build-guest-$IMG.log"; exit 1; }
sed -i "s/time0=local/time0=$TIME0/" "$OUT/pack/bochsrc"
ls -la "$OUT/pack"
