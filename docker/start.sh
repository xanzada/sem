#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data/shots

rm -f /app/data/profile/SingletonLock \
      /app/data/profile/SingletonSocket \
      /app/data/profile/SingletonCookie 2>/dev/null || true

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

if [[ "${NOVNC_ENABLED:-1}" == "1" ]]; then
  Xvfb :99 -screen 0 "${VNC_SCREEN:-1280x800x24}" &
  sleep 1
  x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet -noxdamage -wait 30 -defer 30 &
  websockify --web /usr/share/novnc 6080 localhost:5900 &
  export SEM_VNC_LOCAL=1
fi

exec node dist/index.js
