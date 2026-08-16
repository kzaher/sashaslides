#!/usr/bin/env bash
# Rebuild container2wasm's imagemounter.wasm (in-browser network stack + TLS MITM proxy + 9p image
# server) from work/c2w-src with nanobox's fix applied (patches/c2w-imagemounter-notbefore.patch:
# the proxy's CA and per-host certificates get a NotBefore — upstream leaves Go's zero time, year 1,
# which webpki/rustls clients such as codex reject with "error sending request" on every HTTPS call
# while OpenSSL/BoringSSL clients accept it). Output: build/imagemounter-nb.wasm.gzip, served by
# serve.mjs at /engine/imagemounter.wasm.gzip (vm.html uses it for both engines).
# Needs docker (rootless: DOCKER_HOST=unix:///tmp/xdgrt-1000/docker.sock). ~3-5 min; run detached.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/work/c2w-src"
[ -f "$SRC/extras/imagemounter/main.go" ] || { echo "missing $SRC (clone container2wasm v0.8.4 there and apply patches/)"; exit 1; }
grep -q "NotBefore" "$SRC/extras/imagemounter/main.go" || (cd "$SRC" && patch -p1 < "$HERE/patches/c2w-imagemounter-notbefore.patch")
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
docker run --rm -v "$SRC:/src" -w /src/extras/imagemounter -e GOFLAGS=-mod=mod -e GOCACHE=/src/.gocache -e GOMODCACHE=/src/.gomodcache \
  -e GOOS=wasip1 -e GOARCH=wasm golang:1.26-bookworm go build -trimpath -ldflags "-s -w" -o /src/imagemounter-nb.wasm .
mkdir -p "$HERE/build"
gzip -9 -c "$SRC/imagemounter-nb.wasm" > "$HERE/build/imagemounter-nb.wasm.gzip"
ls -la "$HERE/build/imagemounter-nb.wasm.gzip"
