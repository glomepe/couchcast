#!/usr/bin/env bash
# Compile la passerelle puis construit l'app autonome. --install (macOS) : copie dans /Applications.
set -euo pipefail
cd "$(dirname "$0")"
../gateway/build.sh
[ -d node_modules ] || npm ci
./package.sh
if [ "${1:-}" = "--install" ] && [ "$(uname -s)" = Darwin ]; then
  osascript -e 'quit app "Couchcast"' 2>/dev/null || true
  sleep 2
  rm -rf /Applications/Couchcast.app
  cp -R dist/mac-arm64/Couchcast.app /Applications/
  echo "Installée dans /Applications"
fi
