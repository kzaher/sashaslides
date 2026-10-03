#!/usr/bin/env bash
# nanobox proxy bridge — TypeScript build (MIT License, see extension/README.md).
#
# Sources:  extension/src/*.ts  ->  extension/*.js   (the files manifest.json / importScripts /
#                                                     offscreen.html / new Worker() name)
#           web/src/proxyext.ts ->  web/proxyext.js  (the file vm.html / sandbox.html <script> name)
#
# The emitted .js is CHECKED IN on purpose: the extension is loaded unpacked straight out of this
# repo (test/e2e-proxyext.mjs, Extensions.loadUnpacked) and web/*.js is served statically by
# serve.mjs, so a fresh clone and the packed dist/ must both work with no build tools present.
# Nothing hand-edits those files — every one of them carries a generated-file header.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

TSC="$HERE/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC="$HERE/../node_modules/.bin/tsc"
[ -x "$TSC" ] || { echo "build-proxy-extension.sh: no tsc — run 'npm install' in nanobox/" >&2; exit 1; }

PROJECTS=(extension web)

# 1. THE GATE, and it runs before anything is emitted. A transpiler is not a type checker: tsc
#    without --noEmit would still write files for a program that has errors, so the check is a
#    separate, failing step and a broken tree never reaches extension/*.js.
for project in "${PROJECTS[@]}"; do
  echo "typecheck  $project/tsconfig.json"
  "$TSC" --noEmit -p "$project/tsconfig.json"
done

# 2. The worker-scope rule, which the compiler cannot state here. @types/chrome does not compile
#    against lib.webworker (it names HTMLElement / ShadowRoot / MediaStream), so every context is
#    checked against lib.dom — see the note in tsconfig.json. These three sources are loaded into a
#    scope that HAS no window and no document (the MV3 service worker, and the codec Worker), so
#    touching either is caught here instead. Line comments are stripped first: the files talk ABOUT
#    window.postMessage in their prose. What is looked for is a USE — `window.x`, `window[x]`,
#    `typeof document` — so that the word inside a message string ("the offscreen document") is not
#    a false positive.
WORKER_SCOPE_SOURCES=(extension/src/wire.ts extension/src/background.ts extension/src/offscreen-codec.ts)
WORKER_SCOPE_FORBIDDEN='(^|[^.[:alnum:]_$])(window|document)[[:space:]]*[.[]|typeof[[:space:]]+(window|document)[^[:alnum:]_$]'
for source in "${WORKER_SCOPE_SOURCES[@]}"; do
  if sed 's|//.*$||' "$source" | grep -nE "$WORKER_SCOPE_FORBIDDEN"; then
    echo "build-proxy-extension.sh: $source ships into a worker scope and may not use window/document" >&2
    exit 1
  fi
done

# 3. Emit.
for project in "${PROJECTS[@]}"; do
  echo "emit       $project/tsconfig.json"
  "$TSC" -p "$project/tsconfig.json"
done

# 4. The generated-file header, prepended after emit because tsc has no banner option.
stamp() {   # stamp <emitted .js> <source .ts> <tsconfig>
  local emitted="$1" source="$2" project="$3"
  local header
  header="// GENERATED FILE — do not edit. Compiled from $source by build-proxy-extension.sh
// (tsc -p $project). Change the TypeScript source and rebuild; 'npm run typecheck' is the gate."
  printf '%s\n%s' "$header" "$(cat "$emitted")" > "$emitted.stamped"
  mv "$emitted.stamped" "$emitted"
}
for name in wire background content offscreen offscreen-codec; do
  stamp "extension/$name.js" "extension/src/$name.ts" "extension/tsconfig.json"
done
stamp web/proxyext.js web/src/proxyext.ts web/tsconfig.json

echo "build-proxy-extension.sh: ok"
