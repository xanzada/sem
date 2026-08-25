#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data/shots

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

if [[ "${NOVNC_ENABLED:-1}" == "1" ]]; then
  Xvfb :99 -screen 0 "${VNC_SCREEN:-1366x900x24}" &
  sleep 1
  x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet &
  websockify --web /usr/share/novnc 6080 localhost:5900 &
fi

exec node dist/index.js
