#!/usr/bin/env bash
# solve-bug-clusters.sh — Run the html2slides bug_solving structured-prompt
# pipeline against the clusters declared in
# renderer/structured-prompts/bug_solving/clusters.ts.
#
# Scope: html2slides converter only. Workers fix
#   renderer/html2slides/extract-dom.ts and convert-pptx.ts so the bad-rated
#   slides from the html2slides complex e2e set re-render correctly.
#
# IMPORTANT: clusters.ts is per-wave input and MUST be hand-regenerated
# from the latest /tmp/sxs-complex/ratings.json (the SxS rating output of
# renderer/html2slides/regen-complex.sh) before this is invoked. See the
# .md skill description for the workflow.
set -euo pipefail

cd /workspaces/sashaslides

RATINGS="${BUG_SOLVING_RATINGS_JSON:-/tmp/sxs-complex/ratings.json}"
if [ ! -f "$RATINGS" ]; then
  echo "❌ No ratings file at $RATINGS — run regen-complex.sh and rate first." >&2
  exit 2
fi

# Sanity: warn if clusters.ts hasn't been touched since ratings.json's last write.
RATINGS_MT=$(stat -c %Y "$RATINGS")
CLUSTERS_MT=$(stat -c %Y renderer/structured-prompts/bug_solving/clusters.ts 2>/dev/null || echo 0)
if [ "$CLUSTERS_MT" -lt "$RATINGS_MT" ]; then
  cat >&2 <<EOF
⚠ clusters.ts is OLDER than $RATINGS.

The ratings file has been updated since clusters.ts was last edited, which
strongly suggests new bad-rated slides exist that aren't covered by the
current cluster definitions. Hand-regenerate clusters.ts from the bad
ratings before running this skill, or set
BUG_SOLVING_FORCE_STALE_CLUSTERS=1 to override.
EOF
  if [ -z "${BUG_SOLVING_FORCE_STALE_CLUSTERS:-}" ]; then
    exit 3
  fi
fi

# Build the bundle from inside structured-prompting/ (where build.ts lives
# and where node_modules is rooted) but run it from the repo root, because
# workspace-setup.ts resolves the fixtures dir relative to process.cwd().
( cd structured-prompting && npx tsx build.ts ../renderer/structured-prompts/bug_solving/main-scaffolding.ts )
exec node structured-prompting/dist/main-scaffolding.mjs
