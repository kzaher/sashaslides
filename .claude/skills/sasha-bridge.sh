#!/usr/bin/env bash
# Thin entrypoint for the sasha-bridge skill: forwards args to the bridge wrapper.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate the bridge dir: explicit env override, then an installer-baked path
# (curl|sh substitutes __BRIDGE_DIR__), then the in-repo layout (.claude/skills/
# → ../../bridge). The repo keeps the literal placeholder, which fails the test
# below and falls through to the repo path.
bridge="${SASHA_BRIDGE_DIR:-__BRIDGE_DIR__}"
if [[ ! -f "$bridge/wrapper.py" ]]; then
  bridge="$(cd "$here/../.." 2>/dev/null && pwd)/bridge"
fi
if [[ ! -f "$bridge/wrapper.py" ]]; then
  echo '{"ok": false, "error": "bridge not found — set SASHA_BRIDGE_DIR to the sasha-bridge folder"}' >&2
  exit 1
fi

# Prefer the self-contained venv (created by run.sh / install.sh) so nothing
# global is used. Client subcommands only need stdlib, but stay consistent.
py="python3"
for cand in "${SASHA_VENV:-}/bin/python" "$bridge/.venv/bin/python"; do
  [[ -n "$cand" && -x "$cand" ]] && { py="$cand"; break; }
done

exec "$py" "$bridge/wrapper.py" "$@"
