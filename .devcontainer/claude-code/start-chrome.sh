#!/bin/bash
# Starts Xvfb + Chrome with remote debugging and the Polybot extension loaded.
# Called automatically by devcontainer postStartCommand.

set -e

# Build extension first
cd /workspaces/polybot
npm run build 2>&1 || echo "Initial build failed - run 'npm run build' manually"

# Start virtual display if not already running
if ! pgrep -x Xvfb > /dev/null; then
  export DISPLAY=:99
  Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
  sleep 1
  echo "Xvfb started on :99"
else
  export DISPLAY=:99
  echo "Xvfb already running"
fi

# Start VNC server if not already running
if ! pgrep -x x11vnc > /dev/null; then
  # Unset WAYLAND_DISPLAY so x11vnc connects to Xvfb, not Wayland
  unset WAYLAND_DISPLAY
  x11vnc -display :99 -forever -nopw -rfbport 5900 -shared -bg
  echo "VNC server started on port 5900"
else
  echo "VNC server already running"
fi

# Start noVNC (web-based VNC client) if not already running
if ! pgrep -f websockify > /dev/null; then
  /opt/noVNC/utils/websockify/run --web /opt/noVNC 6080 localhost:5900 &
  echo "noVNC started on port 6080 — open http://localhost:6080/vnc_lite.html"
else
  echo "noVNC already running"
fi

# Kill any existing Chrome
pkill -f google-chrome-stable 2>/dev/null || true
sleep 1

# Launch Chrome
echo "Starting Chrome with remote debugging on port 9222..."
DISPLAY=:99 google-chrome-stable \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-hang-monitor \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/home/node/chrome-profile \
  --load-extension=/workspaces/polybot/dist \
  --window-size=1920,1080 \
  --disable-gpu \
  --no-sandbox \
  &

# Wait for Chrome to be ready
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "Chrome is ready on port 9222"
    exit 0
  fi
  sleep 1
done

echo "Warning: Chrome did not become ready in 30 seconds"
