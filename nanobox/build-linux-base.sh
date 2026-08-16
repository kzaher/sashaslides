#!/usr/bin/env bash
# Build the linux-base guest image (busybox + glibc + libstdc++ + CA certs, NO node and NO CLI baked in —
# both are installed at first run by web/native/installer.js; see guest/linux-base/Dockerfile) and
# publish it like the other images:
#   public/c2w/images/linux-base/    OCI layout (docker save, layers recompressed with gzip)
#   web/images/linux-base/config.json   runtime spec (what imagemounter's genspec would produce)
#   web/images/linux-base/imageconfig.json
#   web/images/linux-base/config-vm.json       + /dev/hvc1 (host channel) + PATH=/bundle/nb:... (the system-node
#                                              shim first in PATH; docs/system-node.md) + the persistent bind mounts
#   web/images/linux-base/config-persist.json  + the persistent bind mounts only (native CLIs in the guest)
#
#   ./build-linux-base.sh      log: work/build-linux-base.log
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/public/c2w/images/linux-base"
log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
log "docker build (linux-base)"
docker build --target nanobox-linux-base -t nanobox-linux-base "$HERE/guest/linux-base"
log "exporting OCI layout -> $OUT"
rm -rf "$OUT" && mkdir -p "$OUT"
docker save nanobox-linux-base | tar -x -C "$OUT"
rm -f "$OUT/manifest.json" "$OUT/repositories"
node "$HERE/../vm-build/oci-gzip.mjs" "$OUT"
du -sh "$OUT"
log "runtime spec -> web/images/linux-base/"
mkdir -p "$HERE/web/images/linux-base"
node "$HERE/tools/genspec.mjs" "$OUT" "$HERE/web/images/claude/config.json" "$HERE/web/images/linux-base"
# config-vm.json: + /dev/hvc1 + PATH=/bundle/nb:... (the node shim) + the persistent bind mounts (claude on the browser V8)
# config-persist.json: only the persistent bind mounts (codex / agy: native binaries in the guest, real node in PATH)
PERSIST=usr/local,root,home,var   # must match web/native/installer.js PERSIST_ROOTS
node "$HERE/tools/genspec-vm.mjs" "$HERE/web/images/linux-base/config.json" "$HERE/web/images/linux-base/config-vm.json" --shim --persist "$PERSIST"
node "$HERE/tools/genspec-vm.mjs" "$HERE/web/images/linux-base/config.json" "$HERE/web/images/linux-base/config-persist.json" --persist "$PERSIST"
ls -la "$HERE/web/images/linux-base"
log "layer sizes (compressed)"
node -e '
const fs=require("fs"),p=process.argv[1];const idx=JSON.parse(fs.readFileSync(p+"/index.json"));const man=JSON.parse(fs.readFileSync(p+"/blobs/sha256/"+idx.manifests[0].digest.slice(7)));
const cfg=JSON.parse(fs.readFileSync(p+"/blobs/sha256/"+man.config.digest.slice(7)));const hist=(cfg.history||[]).filter(h=>!h.empty_layer);
man.layers.forEach((l,i)=>console.log(String(l.size).padStart(10), (l.size/1e6).toFixed(1).padStart(6)+" MB", l.digest.slice(7,19), (hist[i]&&hist[i].created_by||"").slice(0,90)));
console.log(String(man.layers.reduce((s,l)=>s+l.size,0)).padStart(10), "total");' "$OUT"
echo BUILD-LINUX-BASE-DONE
