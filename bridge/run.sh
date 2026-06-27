#!/usr/bin/env bash
# Self-contained launcher for the Sasha Slides bridge.
#
# Creates a LOCAL virtualenv (default: ./.venv next to this script), installs the
# dependencies INTO that venv, and starts the bridge. It never installs anything
# globally and never touches your system / --user site-packages.
#
#   ./run.sh                 # prompt for the venv location, then install + serve
#   ./run.sh --port 8800     # extra args pass through to `wrapper.py serve`
#   SASHA_VENV=/path ./run.sh # choose the venv non-interactively (no prompt)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
default_venv="$here/.venv"
venv="${SASHA_VENV:-$default_venv}"

# Ask where to put the venv (Enter = accept the default under this folder, or type
# another path). Skipped when non-interactive or when SASHA_VENV is set.
if [ -t 0 ] && [ -z "${SASHA_VENV:-}" ]; then
  printf 'Set up a self-contained venv at:\n  %s\nPress Enter to accept, or type another path: ' "$venv"
  read -r reply || true
  [ -n "${reply:-}" ] && venv="$reply"
fi

py="$(command -v python3 || command -v python || true)"
[ -n "$py" ] || { echo "✗ Python 3 not found. Install Python 3.9+ and re-run." >&2; exit 1; }

if [ ! -x "$venv/bin/python" ]; then
  echo "==> creating venv at $venv"
  if ! "$py" -m venv "$venv" 2>/tmp/sasha-venv-err; then
    echo "✗ could not create the venv:" >&2; cat /tmp/sasha-venv-err >&2
    echo "  On Debian/Ubuntu you may need:  sudo apt install python3-venv" >&2
    exit 1
  fi
fi
vpy="$venv/bin/python"

# Install deps into the venv only if they're not already present (keeps re-runs fast).
if ! "$vpy" - <<'PY' >/dev/null 2>&1
import aiohttp, aiortc, qrcode  # noqa
PY
then
  echo "==> installing dependencies into the venv (nothing global is changed)"
  "$vpy" -m pip install --quiet --upgrade pip
  "$vpy" -m pip install --quiet -r "$here/requirements.txt"
fi

echo "==> starting the bridge — open http://localhost:8787/ to pair"
exec "$vpy" "$here/wrapper.py" serve "$@"
