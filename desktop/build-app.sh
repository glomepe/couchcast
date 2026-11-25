#!/usr/bin/env bash
# Compile la passerelle puis l'application macOS. --install : copie dans /Applications.
set -euo pipefail
cd "$(dirname "$0")"
../gateway/build.sh
[ -d node_modules ] || npm ci
npm run dist
APP="dist/mac-arm64/Couchcast.app"
echo "Application : $PWD/$APP"
if [ "${1:-}" = "--install" ]; then
  osascript -e 'quit app "Couchcast"' 2>/dev/null || true
  sleep 2
  rm -rf "/Applications/Couchcast.app"
  cp -R "$APP" /Applications/
  echo "Installée dans /Applications"
fi
