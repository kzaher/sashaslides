#!/usr/bin/env bash
# sasha-slides picker — TypeScript build.
#
#   src/background.ts  ->  background.js   (manifest.background.service_worker)
#   src/offscreen.ts   ->  offscreen.js    (offscreen.html <script src>)
#   src/content.ts     ->  content.js      (manifest.content_scripts.js; bundles React)
#
# The emitted .js is CHECKED IN on purpose: Chrome loads extension/ unpacked straight out of this
# repo, so a fresh clone must work with no build tools present. NOTHING hand-edits those files —
# every one carries a generated-file header, and this script overwrites them wholesale.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ROOT="$HERE/../../.."
TSC="$HERE/node_modules/.bin/tsc"; [ -x "$TSC" ] || TSC="$ROOT/node_modules/.bin/tsc"
ESBUILD="$HERE/node_modules/.bin/esbuild"; [ -x "$ESBUILD" ] || ESBUILD="$ROOT/node_modules/.bin/esbuild"
[ -x "$TSC" ] || { echo "build-extension.sh: no tsc — run 'npm install' here or at the repo root" >&2; exit 1; }
[ -x "$ESBUILD" ] || { echo "build-extension.sh: no esbuild — run 'npm install' at the repo root" >&2; exit 1; }

# 1. THE GATE, before anything is emitted. Two projects: the shipped sources (browser types only)
#    and the tests (which may also see @types/node). Both must be clean.
for project in tsconfig.json tsconfig.test.json; do
  echo "typecheck  $project"
  "$TSC" --noEmit -p "$project"
done

# 2. The worker-scope rule, which the compiler cannot state here: @types/chrome does not compile
#    against lib.webworker, so every context is checked against lib.dom and "a service worker has no
#    window/document" is enforced by this grep instead. Line comments are stripped first, because
#    background.ts talks ABOUT the offscreen document in prose.
WORKER_SCOPE_FORBIDDEN='(^|[^.[:alnum:]_$])(window|document)[[:space:]]*[.[]|typeof[[:space:]]+(window|document)[^[:alnum:]_$]'
if sed 's|//.*$||' src/background.ts | grep -nE "$WORKER_SCOPE_FORBIDDEN"; then
  echo "build-extension.sh: src/background.ts ships into a service worker and may not use window/document" >&2
  exit 1
fi

# 3. Emit. IIFE, not ESM: a content script cannot be a module, and one format for all three keeps
#    the manifest free of per-file "type" quirks.
emit() {  # emit <entry> <out>
  "$ESBUILD" "$1" \
    --bundle --format=iife --target=chrome116 --platform=browser \
    --jsx=automatic --jsx-import-source=react \
    --define:process.env.NODE_ENV='"production"' \
    --legal-comments=none --log-level=warning \
    --outfile="$2"
  header="// GENERATED FILE — do not edit. Compiled from extension/$1 by build-extension.sh
// (esbuild; 'npm run typecheck' in extension/ is the gate). Change the TypeScript source and rebuild."
  printf '%s\n%s' "$header" "$(cat "$2")" > "$2.stamped"
  mv "$2.stamped" "$2"
  echo "emit       $1 -> $2  ($(wc -c < "$2") bytes)"
}
emit src/background.ts background.js
emit src/offscreen.ts offscreen.js
emit src/content.ts content.js

echo "build-extension.sh: ok"
