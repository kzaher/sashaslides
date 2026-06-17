#!/usr/bin/env bash
# Builds the Google Slides add-on (sidebar + bound Apps Script) from the shared
# html2slides conversion core. Emits a ready-to-push project under
# renderer/html2slides/addon/dist/. Run after any change to addon-main.ts,
# convert-core.ts, extract-dom.ts, or build-addon.ts.
#
# Deploy: see renderer/html2slides/addon/README.md (manual paste, or
#   cd renderer/html2slides/addon/dist && clasp create --type slides --parentId <PRES_ID> && clasp push
set -euo pipefail
cd "$(dirname "$0")/../.."

DIST="$PWD/renderer/html2slides/addon/dist"

npx tsx renderer/html2slides/browser/build-addon.ts

echo ""
echo "✓ Apps Script project ready:"
echo "    $DIST/{appsscript.json, Code.gs, Sidebar.html}"
echo "  Deploy instructions: renderer/html2slides/addon/README.md"
echo "  Quick clasp push:"
echo "    cd \"$DIST\" && clasp create --type slides --title html2slides --parentId <PRESENTATION_ID> && clasp push"
