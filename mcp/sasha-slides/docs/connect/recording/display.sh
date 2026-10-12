#!/usr/bin/env bash
# Starts the 1600x900 display the walkthroughs are recorded on, a VNC view of it, and Chrome.
#
#   bash mcp/sasha-slides/docs/connect/recording/display.sh
#
# Then open http://localhost:6080/vnc.html (from a Mac: ssh -L 6080:<container ip>:6080 <host>) to sign
# in to claude.ai or ChatGPT by hand. record.ts's wipe areas assume exactly this size, so keep it.
# Chrome keeps its sign-ins in ~/.chrome-sasha-profile and listens for CDP on :9223.
set -euo pipefail

display=":99"
if ! pgrep -x Xvfb >/dev/null; then
  setsid Xvfb "$display" -screen 0 1600x900x24 -ac >/dev/null 2>&1 < /dev/null &
  echo "Xvfb $display 1600x900 started"
fi
if ! pgrep -x x11vnc >/dev/null; then
  setsid x11vnc -display "$display" -forever -nopw -shared -rfbport 5900 -quiet >/dev/null 2>&1 < /dev/null &
  echo "x11vnc on :5900 started"
fi
if ! pgrep -f "websockify.*6080" >/dev/null; then
  setsid /opt/noVNC/utils/websockify/run --web /opt/noVNC 0.0.0.0:6080 localhost:5900 >/dev/null 2>&1 < /dev/null &
  echo "noVNC on http://localhost:6080/vnc.html started"
fi
if ! curl -s -m 2 http://127.0.0.1:9223/json/version >/dev/null; then
  DISPLAY="$display" setsid google-chrome --no-sandbox --no-first-run --user-data-dir="$HOME/.chrome-sasha-profile" \
    --remote-debugging-port=9223 --window-position=0,0 --window-size=1600,900 --start-maximized \
    https://claude.ai >/dev/null 2>&1 < /dev/null &
  echo "Chrome (CDP :9223, profile ~/.chrome-sasha-profile) started"
fi
echo "Ready: sign in through VNC, then run record.ts start <flow> with DISPLAY=$display"
