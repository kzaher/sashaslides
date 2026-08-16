#!/usr/bin/env bash
# Build the claude-npm guest image (Claude Code via `npm install -g` on system Node.js — see
# guest/claude-npm/Dockerfile) and publish it like the other images:
#   ../public/c2w/images/claude-npm/   OCI layout (docker save, layers recompressed with gzip)
#   web/images/claude-npm/config.json  runtime spec (what imagemounter's genspec would produce)
#   web/images/claude-npm/imageconfig.json
#
#   ./build-claude-npm.sh [claude-code version, default latest]      log: work/build-claude-npm.log
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 2.1.112 = the LAST npm release that ships cli.js (JS run by node); from 2.1.113 on the npm package only
# wraps the platform-native Bun executable (optionalDependencies @anthropic-ai/claude-code-linux-x64 ...)
VER="${1:-2.1.112}"
OUT="$HERE/../public/c2w/images/claude-npm"
log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
log "docker build (claude-code@$VER)"
docker build --build-arg "CLAUDE_CODE_VERSION=$VER" --target nanobox-claude-npm -t nanobox-claude-npm "$HERE/guest/claude-npm"
log "exporting OCI layout -> $OUT"
rm -rf "$OUT" && mkdir -p "$OUT"
docker save nanobox-claude-npm | tar -x -C "$OUT"
rm -f "$OUT/manifest.json" "$OUT/repositories"
node "$HERE/../vm-build/oci-gzip.mjs" "$OUT"
du -sh "$OUT"
log "runtime spec -> web/images/claude-npm/"
mkdir -p "$HERE/web/images/claude-npm"
node "$HERE/tools/genspec.mjs" "$OUT" "$HERE/web/images/claude/config.json" "$HERE/web/images/claude-npm"
ls -la "$HERE/web/images/claude-npm"
echo BUILD-CLAUDE-NPM-DONE
