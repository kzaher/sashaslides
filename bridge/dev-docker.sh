#!/usr/bin/env bash
# DEV-ONLY iteration helper — NOT the user-facing install flow (the sidebar's
# Docker commands are unchanged). It runs the bridge inside a long-lived container
# whose PID 1 is `sleep infinity`, so the bridge can be killed/restarted freely to
# pick up new code WITHOUT recreating the container. Claude Code + its auth live in
# named volumes, so even a full `up` keeps them.
#
#   ./bridge/dev-docker.sh up        # one-time: create the dev container (coturn +
#                                    #   bridge + skill), bridge running detached
#   ./bridge/dev-docker.sh refresh   # re-pull bridge code from the server & restart
#                                    #   it — KEEPS the container, coturn, Claude
#   ./bridge/dev-docker.sh claude    # shell in and launch Claude (installs once)
#   ./bridge/dev-docker.sh bash      # shell into the container
#   ./bridge/dev-docker.sh logs      # follow the bridge log
#
# Iteration loop:  (edit bridge code) -> npm run deploy -> ./bridge/dev-docker.sh
# refresh -> ./bridge/dev-docker.sh claude.  Sidebar (app.js) changes still need
# `npm run deploy` + a sidebar reload — refresh only updates the bridge half.
set -euo pipefail
NAME=sasha-slides-bridge
ORIGIN=${SASHA_ORIGIN:-https://sashaslides.com}

kill_bridge() {  # SIGTERM the bridge + coturn so coturn frees :3478; -i for the heredoc
  docker exec -i "$NAME" python3 - <<'PY' 2>/dev/null || true
import os, signal, glob
me = os.getpid()
for d in glob.glob('/proc/[0-9]*'):
    try:
        cmd = open(d + '/cmdline', 'rb').read().decode('utf-8', 'replace')
    except Exception:
        continue
    if 'wrapper.py' in cmd or 'turnserver' in cmd:
        pid = int(d.rsplit('/', 1)[1])
        if pid != me:
            try:
                os.kill(pid, signal.SIGTERM)
            except Exception:
                pass
PY
  sleep 3
}

start_bridge() {  # detached, so it outlives this exec and stays a child of PID 1
  docker exec -d "$NAME" bash -c \
    "cd /opt/sasha-bridge && SASHA_TURN=1 SASHA_DIR=/opt .venv/bin/python wrapper.py serve > /tmp/bridge.log 2>&1"
  sleep 2
  docker exec "$NAME" bash -c "tail -n 30 /tmp/bridge.log" 2>/dev/null || true
}

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      -p 8787:8787 -p 3478:3478/tcp \
      -e SASHA_TURN=1 -e SASHA_DIR=/opt \
      -v sasha-claude:/root/.claude -v sasha-local:/root/.local \
      python:3.14 sleep infinity >/dev/null
    echo "==> installing coturn + unzip ..."
    docker exec "$NAME" bash -c "apt-get update -qq && apt-get install -y -qq coturn unzip"
    echo "==> installing bridge + skill (install.sh, detached) ..."
    docker exec -d "$NAME" bash -c "SASHA_DIR=/opt SASHA_SKILL=claude curl -fsSL $ORIGIN/install.sh | sh > /tmp/bridge.log 2>&1"
    echo "==> waiting for the bridge to come up ..."
    for _ in $(seq 1 90); do
      docker exec "$NAME" grep -q "Sasha Slides bridge on" /tmp/bridge.log 2>/dev/null && break
      sleep 2
    done
    docker exec "$NAME" bash -c "tail -n 20 /tmp/bridge.log" 2>/dev/null || true
    echo "==> dev container ready. Edit code -> 'npm run deploy' -> '$0 refresh' -> '$0 claude'."
    ;;
  refresh)
    echo "==> re-pulling bridge code ($ORIGIN/sasha-bridge.zip) + restarting ..."
    kill_bridge
    docker exec "$NAME" bash -c "curl -fsSL $ORIGIN/sasha-bridge.zip -o /tmp/b.zip && unzip -o -q /tmp/b.zip -d /opt/sasha-bridge"
    start_bridge
    ;;
  claude)
    docker exec -it "$NAME" bash -lc \
      'command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash; exec "$HOME/.local/bin/claude"' ;;
  bash)
    docker exec -it "$NAME" bash ;;
  logs)
    docker exec "$NAME" tail -f /tmp/bridge.log ;;
  *)
    echo "usage: $0 {up|refresh|claude|bash|logs}"; exit 1 ;;
esac
