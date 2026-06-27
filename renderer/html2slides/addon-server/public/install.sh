#!/bin/sh
# Sasha Slides bridge — one-line installer:
#
#   curl -fsSL __ORIGIN__/install.sh | sh
#
# Self-contained: downloads the bridge, asks where to put it, builds a PRIVATE
# Python venv (nothing is ever installed globally / --user), installs the skill
# into Claude Code or Codex (auto-detected, or you pick), and starts the bridge.
set -eu

ORIGIN="${SASHA_ORIGIN:-__ORIGIN__}"

# stdin is the piped script, so read prompts straight from the terminal. Detect
# the tty by actually opening it for WRITING — `[ -r /dev/tty ]` lies on some
# sandboxes (the node exists but can't be opened), which would blank the prompts.
TTY=
# Probe in a SUBSHELL: `:` is a special built-in, so a redirection failure on it
# under `set -e` would exit the whole script — the subshell contains that.
if ( : >/dev/tty ) 2>/dev/null; then TTY=/dev/tty; fi
say()  { printf '\033[1;35m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ '$1' is required but not installed." >&2; exit 1; }; }
ask()  { # ask "<prompt>" "<default>"  -> echoes the answer (default if non-interactive)
  _ans=""
  if [ -n "$TTY" ]; then
    printf '%s' "$1" >"$TTY" 2>/dev/null || true
    IFS= read -r _ans <"$TTY" 2>/dev/null || true
  fi
  [ -n "$_ans" ] && printf '%s' "$_ans" || printf '%s' "$2"
}
expand() { case "$1" in "~"|"~/"*) printf '%s' "$HOME${1#\~}";; *) printf '%s' "$1";; esac; }

need curl; need python3; need unzip

say "Sasha Slides bridge installer"

# ── 1. where to install ──────────────────────────────────────────────────────
# SASHA_DIR set => use it with no prompt (fully non-interactive, e.g. Docker).
if [ -n "${SASHA_DIR:-}" ]; then
  DEST="$(expand "$SASHA_DIR")"
else
  DEST="$(expand "$(ask "Install location [~/.sasha-bridge]: " "$HOME/.sasha-bridge")")"
fi
APP="$DEST/sasha-bridge"

say "↓ downloading the bridge → $APP"
mkdir -p "$DEST"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$ORIGIN/sasha-bridge.zip" -o "$tmp/bridge.zip"
unzip -oq "$tmp/bridge.zip" -d "$tmp"
rm -rf "$APP"; mv "$tmp/sasha-bridge" "$APP"
chmod +x "$APP/run.sh" "$APP/skill/sasha-bridge.sh" 2>/dev/null || true

# ── 2. install the skill (auto-detect Claude Code / Codex, else ask) ──────────
say "Installing the agent skill"
CLAUDE_DIR="$HOME/.claude/skills"
CODEX_DIR="$HOME/.codex/prompts"
have_claude=0; [ -d "$HOME/.claude" ] && have_claude=1
have_codex=0;  [ -d "$HOME/.codex" ]  && have_codex=1

target=""; kind="claude"   # kind: claude => <dir>/sasha-bridge/SKILL.md ; codex => flat prompt .md
# SASHA_SKILL set => no prompt: skip | claude | codex | <a path>.
if [ -n "${SASHA_SKILL:-}" ]; then
  case "$SASHA_SKILL" in
    skip|none) target=""; note "skipping skill install (SASHA_SKILL=skip)" ;;
    claude)    target="$CLAUDE_DIR"; kind="claude" ;;
    codex)     target="$CODEX_DIR";  kind="codex" ;;
    *)         target="$(expand "$SASHA_SKILL")"; kind="claude" ;;
  esac
elif [ "$have_claude" = 1 ] && [ "$have_codex" = 0 ]; then
  target="$CLAUDE_DIR"; kind="claude"; note "detected Claude Code → $target"
elif [ "$have_codex" = 1 ] && [ "$have_claude" = 0 ]; then
  target="$CODEX_DIR";  kind="codex";  note "detected Codex → $target"
else
  # both or neither detected → ask
  { echo "  Where should the skill go?"
    echo "    1) Claude Code  ($CLAUDE_DIR)$([ "$have_claude" = 1 ] && echo '   [detected]')"
    echo "    2) Codex        ($CODEX_DIR)$([ "$have_codex" = 1 ] && echo '   [detected]')"
    echo "    3) Custom path"
    echo "    4) Skip"; } >"${TTY:-/dev/stderr}"
  case "$(ask "  choose [1]: " "1")" in
    2) target="$CODEX_DIR"; kind="codex" ;;
    3) target="$(expand "$(ask "  skill directory: " "$CLAUDE_DIR")")"; kind="claude" ;;
    4) target="" ;;
    *) target="$CLAUDE_DIR"; kind="claude" ;;
  esac
fi
if [ -n "$target" ]; then
  if [ "$kind" = "claude" ]; then
    # Claude Code discovers skills as <skills>/<name>/SKILL.md (a folder + SKILL.md
    # with YAML frontmatter) — NOT loose .md files.
    dir="$target/sasha-bridge"; mkdir -p "$dir"
    sh_path="$dir/sasha-bridge.sh"
    sed "s#__BRIDGE_DIR__#$APP#g" "$APP/skill/sasha-bridge.sh" >"$sh_path"
    sed "s#\.claude/skills/sasha-bridge\.sh#$sh_path#g" "$APP/skill/sasha-bridge.md" >"$dir/SKILL.md"
    chmod +x "$sh_path" 2>/dev/null || true
    note "✓ skill installed → $dir/SKILL.md (overwrote any previous copy)"
  else
    # Codex uses flat prompt files in ~/.codex/prompts/
    mkdir -p "$target"; sh_path="$target/sasha-bridge.sh"
    sed "s#__BRIDGE_DIR__#$APP#g" "$APP/skill/sasha-bridge.sh" >"$sh_path"
    sed "s#\.claude/skills/sasha-bridge\.sh#$sh_path#g" "$APP/skill/sasha-bridge.md" >"$target/sasha-bridge.md"
    chmod +x "$sh_path" 2>/dev/null || true
    note "✓ skill installed → $target/sasha-bridge.md (overwrote any previous copy)"
  fi
  # remove the old loose-file layout from a previous installer, if present
  rm -f "$CLAUDE_DIR/sasha-bridge.md" "$CLAUDE_DIR/sasha-bridge.sh" 2>/dev/null || true
else
  note "skipped skill install — point your agent at $APP/skill/ yourself"
fi

# ── 3. private venv + start (run.sh does venv + deps + serve) ─────────────────
say "Building a private venv and starting the bridge (nothing global is touched)"
note "open http://localhost:8787/ to pair  ·  Ctrl-C to stop"
SASHA_VENV="$APP/.venv" exec "$APP/run.sh"
