#!/usr/bin/env bash
# Build the node-base guest image (small Linux + official Node.js 22 + its npm, NO CLI baked in — the
# CLIs are installed at first run by web/native/installer.js; see guest/node-base/Dockerfile) and
# publish it like the other images:
#   ../public/c2w/images/node-base/    OCI layout (docker save, layers recompressed with gzip)
#   web/images/node-base/config.json   runtime spec (what imagemounter's genspec would produce)
#   web/images/node-base/imageconfig.json
#   web/images/node-base/config-vm.json  the same spec + /dev/hvc1 (host channel) + PATH=/bundle/nb:...
#                                        (the system-node shim first in PATH; see docs/system-node.md)
#
#   ./build-node-base.sh      log: work/build-node-base.log
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/c2w/images/node-base"
log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
log "docker build (node-base)"
docker build --target nanobox-node-base -t nanobox-node-base "$HERE/guest/node-base"
log "exporting OCI layout -> $OUT"
rm -rf "$OUT" && mkdir -p "$OUT"
docker save nanobox-node-base | tar -x -C "$OUT"
rm -f "$OUT/manifest.json" "$OUT/repositories"
node "$HERE/../vm-build/oci-gzip.mjs" "$OUT"
du -sh "$OUT"
log "runtime spec -> web/images/node-base/"
mkdir -p "$HERE/web/images/node-base"
node "$HERE/tools/genspec.mjs" "$OUT" "$HERE/web/images/claude/config.json" "$HERE/web/images/node-base"
node "$HERE/tools/genspec-vm.mjs" "$HERE/web/images/node-base/config.json" "$HERE/web/images/node-base/config-vm.json"
ls -la "$HERE/web/images/node-base"
log "layer sizes (compressed)"
node -e '
const fs=require("fs"),p=process.argv[1];const idx=JSON.parse(fs.readFileSync(p+"/index.json"));const man=JSON.parse(fs.readFileSync(p+"/blobs/sha256/"+idx.manifests[0].digest.slice(7)));
const cfg=JSON.parse(fs.readFileSync(p+"/blobs/sha256/"+man.config.digest.slice(7)));const hist=(cfg.history||[]).filter(h=>!h.empty_layer);
man.layers.forEach((l,i)=>console.log(String(l.size).padStart(10), (l.size/1e6).toFixed(1).padStart(6)+" MB", l.digest.slice(7,19), (hist[i]&&hist[i].created_by||"").slice(0,90)));
console.log(String(man.layers.reduce((s,l)=>s+l.size,0)).padStart(10), "total");' "$OUT"
echo BUILD-NODE-BASE-DONE
