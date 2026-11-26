#!/usr/bin/env bash
# Construit la version téléchargeable (macOS, Apple Silicon) : serveur + pont (avec ses
# bibliothèques Homebrew), ffmpeg/ffprobe et interface, embarqués dans l'app Electron.
# ffmpeg vient de Homebrew (BUNDLE_FFMPEG=0 pour s'en passer : Couchcast utilise alors celui du PATH).
# Prérequis : ../gateway/build.sh déjà exécuté.  →  dist/Couchcast-mac-arm64.dmg et .zip
set -euo pipefail
cd "$(dirname "$0")"

[ "$(uname -s)" = Darwin ] || { echo "Couchcast ne se package que sur macOS."; exit 1; }

GW=../gateway
RES=resources
rm -rf "$RES" && mkdir -p "$RES/bin"
cp -R "$GW/web/dist" "$RES/web"

cp "$GW/build/couchcast-server" "$GW/build/bridge/couchcast-bridge" "$RES/bin/"
# Bibliothèques Homebrew du pont copiées à côté de lui (l'utilisateur n'a pas Homebrew).
command -v dylibbundler >/dev/null || brew install dylibbundler
BUNDLE=(-x "$RES/bin/couchcast-bridge")
if [ "${BUNDLE_FFMPEG:-1}" = 1 ]; then
  command -v ffmpeg >/dev/null || brew install ffmpeg
  for tool in ffmpeg ffprobe; do
    cp "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v $tool)")" "$RES/bin/$tool"
    chmod u+w "$RES/bin/$tool"
    BUNDLE+=(-x "$RES/bin/$tool")
  done
fi
# Une seule copie des bibliothèques partagées par le pont et ffmpeg.
dylibbundler -of -b -cd "${BUNDLE[@]}" -d "$RES/bin/libs" -p @executable_path/libs/ >/dev/null
npx electron-builder --mac dmg zip --arm64 --publish never

ls -lh dist/ | grep -E "\.(dmg|zip)$" || true
