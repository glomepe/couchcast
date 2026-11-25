#!/usr/bin/env bash
# Construit la version téléchargeable : serveur + pont (avec ses bibliothèques),
# ffmpeg/ffprobe et interface, embarqués dans l'app Electron.
#   macOS   : ffmpeg de Homebrew, copié avec ses bibliothèques (BUNDLE_FFMPEG=0 pour s'en passer).
#   Windows : ffmpeg.exe/ffprobe.exe pris dans $FFMPEG_DIR s'il est défini
#             (la CI y place les builds BtbN, référencés par ffmpeg.org).
# Sans ffmpeg embarqué, Couchcast utilise celui du PATH.
# Prérequis : ../gateway/build.sh déjà exécuté sur la même machine.
#   macOS   → dist/Couchcast-<version>-mac-arm64.dmg et .zip
#   Windows → dist/Couchcast-<version>-win-x64.exe (installateur) et .zip  (terminal MSYS2 UCRT64)
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  MINGW*|MSYS*|UCRT*|CLANG*) PLATFORM=windows ;;
  *) echo "Plateforme non prise en charge : $(uname -s)"; exit 1 ;;
esac

GW=../gateway
RES=resources
rm -rf "$RES" && mkdir -p "$RES/bin"
cp -R "$GW/web/dist" "$RES/web"

if [ "$PLATFORM" = macos ]; then
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
else
  cp "$GW/build/couchcast-server.exe" "$GW/build/bridge/couchcast-bridge.exe" "$RES/bin/"
  # DLL MSYS2 dont dépend le pont, résolues récursivement.
  copy_dlls() {
    local dll src
    for dll in $(objdump -p "$1" | awk '/DLL Name:/ {print $3}'); do
      src="$MINGW_PREFIX/bin/$dll"
      if [ -f "$src" ] && [ ! -f "$RES/bin/$dll" ]; then
        cp "$src" "$RES/bin/"
        copy_dlls "$src"
      fi
    done
  }
  copy_dlls "$RES/bin/couchcast-bridge.exe"
  if [ -n "${FFMPEG_DIR:-}" ]; then
    cp "$FFMPEG_DIR/ffmpeg.exe" "$FFMPEG_DIR/ffprobe.exe" "$RES/bin/"
  fi
  npx electron-builder --win nsis zip --x64 --publish never
fi

ls -lh dist/ | grep -E "\.(dmg|zip|exe)$" || true
