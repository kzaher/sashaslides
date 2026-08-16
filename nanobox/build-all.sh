#!/usr/bin/env bash
# Rebuild every artifact that is NOT in git (all reproducible; big blobs are gitignored):
#   engine            build-bochs.sh eh-nb --pack work/pack-out-nb/pack   (+ ref-nb --legacy for the identity gate)
#   imagemounter      build-imagemounter.sh                              (fixed MITM certs)
#   images            build-linux-base.sh, build-claude-npm.sh           (OCI layouts under public/c2w/images/)
#   guest shim        guest/nbnode/build.sh                              (-> guest/nbnode/nbnode, web/native/nbnode)
#   runtime.js        (cd web/native && npm ci && node build.mjs)         (Node-compat layer bundle)
#   JIT bundles       test/record-bundles.sh                             (build/eh-nb/jit/*.nbjb)
#   the served gzips  test/after-build.sh does gzip + gate + bundles after an engine build
# Prerequisites: docker (rootless: DOCKER_HOST=unix:///tmp/xdgrt-1000/docker.sock), the toolchains under
# work/toolchain (build-bochs.sh downloads them), Chrome on :9222 for the e2e tests.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
what="${1:-quick}"
case "$what" in
  quick)   # everything except the engine builds (minutes): shim, runtime bundle, images
    (cd guest/nbnode && ./build.sh)
    (cd web/native && npm ci --no-audit --no-fund && node build.mjs)
    ./build-linux-base.sh
    ;;
  images)  ./build-linux-base.sh; ./build-claude-npm.sh ;;
  engine)  ./build-bochs.sh eh-nb --pack work/pack-out-nb/pack && ./build-bochs.sh ref-nb --legacy --pack work/pack-out-nb/pack && ./test/after-build.sh ;;
  all)     "$0" quick; ./build-imagemounter.sh; "$0" engine ;;
  *) echo "usage: $0 [quick|images|engine|all]" >&2; exit 2 ;;
esac
