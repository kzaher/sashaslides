#!/usr/bin/env bash
# nanobox — the incremental build `npm start` / `npm run build` runs before serving.
#
# HISTORY, so nobody goes looking: this script used to drive the whole engine pipeline
# (bootstrap -> shim -> runtime -> vendor -> c2w -> images -> imagemounter -> engine -> ref ->
# bundles). It was committed EMPTY in 313d51b and has been a no-op since; the individual stages
# still exist as build-bochs.sh / build-guest.sh / build-linux-base.sh / build-claude-npm.sh /
# build-imagemounter.sh and are run on their own. This file is not an attempt to restore that —
# it only owns the one stage that must never be skipped, because a stale artifact here is a
# wrong-code bug rather than a missing file.
#
#   ./build-all.sh            typecheck + compile the proxy bridge's TypeScript, bundle web/native/runtime.js
#   ./build-all.sh vendor     unchanged no-op (npm postinstall -> build:vendor), see below
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `npm install` runs this through postinstall, where node_modules may not be populated yet and a
# missing tsc would fail the install. It has been a no-op since 313d51b; left exactly that.
if [ "${1-}" = "vendor" ]; then
  exit 0
fi

"$HERE/build-proxy-extension.sh"

# web/native/src/*.js -> web/native/runtime.js (esbuild). Same reason as the stage above: runtime.js is
# the classic worker script sandbox.html loads, and a stale one is a wrong-code bug, not a missing file.
# It silently froze for six weeks once (runtime.js 2026-08-23 vs. src/worker.js 2026-10-03) because
# nothing in `npm run build` regenerated it and `node web/native/build.mjs` happened to be broken.
echo "bundle     web/native/src/worker.js -> web/native/runtime.js"
node "$HERE/web/native/build.mjs"
