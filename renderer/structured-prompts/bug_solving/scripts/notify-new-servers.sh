#!/usr/bin/env bash
# notify-new-servers.sh — streaming notifier for bug_solving filtered
# rating servers. Polls a port range every N seconds and prints ONE LINE
# per port that transitioned from "nothing listening" to "listening".
#
# Designed to be consumed by the harness Monitor tool:
#   Monitor({
#     command: "bash renderer/structured-prompts/bug_solving/scripts/notify-new-servers.sh",
#     persistent: true,
#     description: "bug_solving SxS servers",
#   })
# Each emitted line becomes a notification in the chat so the user sees
# newly-launched SxS servers the moment they come up.
#
# Output line format (one per event):
#   NEW http://localhost:<port> — <html <title>> (pid=<pid>, slides=<csv>)
#
# When a port disappears it is silently dropped from internal state so
# that a re-launched server on the same port gets re-announced.
#
# Usage:
#   notify-new-servers.sh [--port-range 4720-4800] [--interval 3]

set -u

PORT_FROM=4720
PORT_TO=4800
INTERVAL=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port-range)
      IFS='-' read -r PORT_FROM PORT_TO <<< "$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# STATE: newline-delimited set of ports we've already announced. Kept
# in-memory; when a port stops listening we drop it so a re-launch
# announces again.
STATE=""

# Announce our own startup on stderr so Monitor's log file shows it (but
# does NOT trigger a notification — only stdout does).
echo "[notify-new-servers] polling ports ${PORT_FROM}-${PORT_TO} every ${INTERVAL}s" >&2

while :; do
  # 1. Enumerate active listeners in the range.
  active=""
  for p in $(seq "$PORT_FROM" "$PORT_TO"); do
    if lsof -ti tcp:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      active+="$p"$'\n'
    fi
  done

  # 2. Emit one stdout line per newly-seen port.
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if ! grep -qxF "$p" <<< "$STATE"; then
      pid="$(lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null | head -1)"
      # Short timeout: if the server is slow to respond we'll retry on
      # the next poll and re-announce then.
      page="$(curl -fsS -m 2 "http://localhost:$p/" 2>/dev/null || echo "")"
      title=""
      slides=""
      if [[ -n "$page" ]]; then
        title="$(echo "$page" | grep -oE '<title>[^<]*</title>' | head -1 | sed -E 's#</?title>##g')"
        # Our filtered-rating-server renders "slide_04, slide_11, ..." in
        # the subtitle line; extract them as a hint of scope.
        slides="$(echo "$page" | grep -oE 'slides: [^<·]+' | head -1 | sed 's/^slides: //;s/ *$//')"
      fi
      [[ -z "$title" ]] && title="(no title)"
      [[ -z "$slides" ]] && slides="?"
      printf 'NEW http://localhost:%s — %s (pid=%s, slides=%s)\n' \
        "$p" "$title" "${pid:-?}" "$slides"
      STATE+="$p"$'\n'
    fi
  done <<< "$active"

  # 3. Drop ports from STATE that no longer have a listener, so a
  #    re-launch can be re-announced.
  new_state=""
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if grep -qxF "$p" <<< "$active"; then
      new_state+="$p"$'\n'
    fi
  done <<< "$STATE"
  STATE="$new_state"

  sleep "$INTERVAL"
done
