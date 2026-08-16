#!/usr/bin/env bash
# Build the guest /pack (kernel+grub iso, rootfs.bin, BIOS, bochsrc) exactly like nanobox's build.sh did.
set -euo pipefail
# Inputs: work/c2w-src (container2wasm v0.8.4 + patches, see tools/bootstrap.sh), this dir's
# c2w.patched.Dockerfile (upstream Dockerfile with a mknod tolerant of an existing /dev/null).
# Output: work/pack-out-nb/pack/{boot.iso,rootfs.bin,BIOS-bochs-latest,VGABIOS-lgpl-latest,bochsrc}
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$HERE/work"; mkdir -p dummy-ctx
docker buildx build --progress=plain \
  --build-arg TARGETARCH=amd64 --build-arg TARGETPLATFORM=linux/amd64 --platform=linux/amd64 \
  -f "$HERE/vm-build/pack/c2w.patched.Dockerfile" --build-context assets=./c2w-src \
  --target=vm-amd64-dev --output type=local,dest=./pack-out-nb \
  --build-arg OUTPUT_NAME=out.wasm --build-arg LINUX_LOGLEVEL=0 --build-arg INIT_DEBUG=false \
  --build-arg EXTERNAL_BUNDLE=true --build-arg VM_MEMORY_SIZE_MB=1024 \
  ./dummy-ctx
