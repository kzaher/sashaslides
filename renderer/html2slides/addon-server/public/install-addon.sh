#!/bin/sh
# SashaSlides add-on — one-line installer for a SPECIFIC Google Slides deck or
# Google Doc:
#
#   curl -fsSL "__ORIGIN__/install.sh?doc=<doc-or-deck-id>" | bash
#
# What it does:
#   1. checks clasp auth persisted at ~/.clasprc.json — verifies it's STILL
#      VALID with a real API call; only re-runs `clasp login` when it isn't
#   2. binds an Apps Script project to your deck/doc (or, on re-install,
#      UPDATES the project it bound last time — registry in
#      ~/.sashaslides/installs.json — so you never get duplicates)
#   3. downloads the current add-on bundle from __ORIGIN__ and pushes it
#   4. tells you the one manual step left (open doc → SashaSlides → authorize)
#
# Requirements: node (npx), curl. Nothing is installed globally — clasp runs
# via npx, state lives in ~/.clasprc.json (clasp's own) + ~/.sashaslides/.
set -eu

ORIGIN="${SASHA_ORIGIN:-__ORIGIN__}"
DOC_ID="${SASHA_DOC:-__DOC_ID__}"
CLASP="npx --yes @google/clasp"
REG_DIR="$HOME/.sashaslides"
REG="$REG_DIR/installs.json"

say()  { printf '\033[1;35m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed."; }

# stdin is the piped script — read prompts from the terminal when there is one.
TTY=
if ( : >/dev/tty ) 2>/dev/null; then TTY=/dev/tty; fi
pause() { # pause "<prompt>" — waits for Enter when interactive, else sleeps
  if [ -n "$TTY" ]; then printf '%s' "$1" >"$TTY"; IFS= read -r _ <"$TTY" || true; else sleep 20; fi
}

need curl; need node; need npx

case "$DOC_ID" in
  __DOC*|"") fail "no document id. Use: curl -fsSL \"$ORIGIN/install.sh?doc=<id>\" | bash" ;;
esac
printf '%s' "$DOC_ID" | grep -Eq '^[A-Za-z0-9_-]{20,}$' || fail "'$DOC_ID' does not look like a Google doc id"

say "SashaSlides add-on installer"
note "target document : $DOC_ID"
note "server          : $ORIGIN"

# ── 1. auth: reuse the persisted token; re-login ONLY if it stopped working ──
if [ -f "$HOME/.clasprc.json" ]; then
  note "found persisted clasp auth — checking it still works…"
  if $CLASP show-authorized-user >/dev/null 2>&1 && $CLASP list-scripts >/dev/null 2>&1; then
    note "✓ auth valid ($($CLASP show-authorized-user 2>/dev/null | head -1))"
  else
    say "stored auth is stale/revoked — re-authorizing (browser will open)…"
    $CLASP login
  fi
else
  say "first run — authorizing clasp (browser will open)…"
  $CLASP login
fi

# ── 2. workspace: fresh temp dir; reuse the bound script on re-install ──────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sashaslides-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

mkdir -p "$REG_DIR"
[ -f "$REG" ] || printf '{}' > "$REG"
SCRIPT_ID="$(node -e "const r=require('$REG');process.stdout.write((r['$DOC_ID']||''))" 2>/dev/null || true)"

if [ -n "$SCRIPT_ID" ]; then
  say "re-install: updating the script bound on a previous run ($SCRIPT_ID)"
  node -e "require('fs').writeFileSync('.clasp.json', JSON.stringify({scriptId:'$SCRIPT_ID',rootDir:''}))"
else
  say "binding a new Apps Script project to $DOC_ID…"
  set +e
  OUT="$($CLASP create-script --title "SashaSlides" --parentId "$DOC_ID" 2>&1)"; RC=$?
  set -e
  if [ $RC -ne 0 ]; then
    if printf '%s' "$OUT" | grep -qi "not enabled"; then
      say "the Google Apps Script API is not enabled for your account (one-time toggle)."
      note "open  https://script.google.com/home/usersettings  and switch it ON."
      pause "then press Enter to retry… "
      OUT="$($CLASP create-script --title "SashaSlides" --parentId "$DOC_ID" 2>&1)" \
        || fail "still failing: $OUT"
    else
      fail "clasp create-script failed: $OUT"
    fi
  fi
  SCRIPT_ID="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.clasp.json','utf8')).scriptId||'')")"
  [ -n "$SCRIPT_ID" ] || fail "could not read scriptId from .clasp.json"
  node -e "const f='$REG',r=JSON.parse(require('fs').readFileSync(f,'utf8'));r['$DOC_ID']='$SCRIPT_ID';require('fs').writeFileSync(f,JSON.stringify(r,null,2))"
  note "✓ bound script $SCRIPT_ID (remembered in $REG)"
fi

# ── 3. fetch the current bundle from the server and push it ─────────────────
say "downloading the add-on bundle…"
for f in Code.gs appsscript.json Sidebar.html; do
  curl -fsSL "$ORIGIN/addon-bundle/$f" -o "$f" || fail "download failed: $ORIGIN/addon-bundle/$f"
done
note "✓ $(wc -c < Code.gs | tr -d ' ') bytes Code.gs, $(wc -c < Sidebar.html | tr -d ' ') bytes Sidebar.html"

say "pushing to Apps Script…"
$CLASP push -f >/dev/null || fail "clasp push failed"
note "✓ pushed"

# ── 4. done ──────────────────────────────────────────────────────────────────
say "✓ installed."
note "Open your document and reload it, then:"
note "  menu  SashaSlides → Open SashaSlides"
note "  (first open asks for authorization — approve it once)"
note ""
note "Re-running this installer updates the same script in place."
