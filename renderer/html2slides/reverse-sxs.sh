#!/usr/bin/env bash
# reverse-sxs.sh — run the REVERSE round trip (Google Slides -> Sasha import -> HTML -> screenshot)
# for the basic set, the complex set and the test deck, into /workspaces/sashaslides/.sxs-reverse.
#
# Usage: ./reverse-sxs.sh [reverse-roundtrip.ts arguments...]
#   ./reverse-sxs.sh                              all sets, reusing uploads/thumbnails already fetched
#   ./reverse-sxs.sh --sets deck                  one set
#   ./reverse-sxs.sh --fresh-upload               re-run the forward conversion + upload first
#   ./reverse-sxs.sh --presentation basic=<id>    measure an existing forward presentation
#
# The engine's renderer is .tsx with the automatic JSX runtime. tsx applies a tsconfig only to the
# files that tsconfig includes, so it runs with the ENGINE's own tsconfig: the engine's sources get
# exactly the settings they are built with, and these scripts (not included there) tsx's defaults.
# That is the only reason this wrapper exists. Typecheck: npx tsc -p reverse/tsconfig.json
# Rate the results with the SxS rating server pointed at .sxs-reverse/<set> (reverse) or
# .sxs-reverse/<set>/round-trip (whole trip). Goldens are written ONLY by the user's "Good" click.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
exec npx tsx --tsconfig ../../mcp/sasha-slides/engine/tsconfig.json reverse-roundtrip.ts "$@"
