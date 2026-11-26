#!/usr/bin/env bash
# Compile la passerelle : pont C (lib chiaki-ng), serveur Go, interface React.
#   macOS   : dépendances via Homebrew.
#   Windows : à lancer dans un terminal MSYS2 « UCRT64 » (dépendances via pacman),
#             avec Go et Node.js installés côté Windows et visibles dans le PATH.
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  MINGW*|MSYS*|UCRT*|CLANG*) PLATFORM=windows ;;
  *) echo "Plateforme non prise en charge : $(uname -s) (macOS ou Windows/MSYS2)"; exit 1 ;;
esac
EXE=""; [ "$PLATFORM" = windows ] && EXE=".exe"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

CMAKE_ARGS=(-DCMAKE_BUILD_TYPE=Release -Wno-dev)
if [ "$PLATFORM" = macos ]; then
  brew list cmake go pkgconf protobuf miniupnpc libevent json-c opus curl >/dev/null 2>&1 \
    || brew install cmake go pkgconf protobuf miniupnpc libevent json-c opus curl
  # Il faut lier la version d'OpenSSL dont les en-têtes sont exposés dans $(brew --prefix)/include.
  OPENSSL=openssl@3
  if grep -qsE 'OPENSSL_VERSION_MAJOR +4' "$(brew --prefix)/include/openssl/opensslv.h"; then OPENSSL=openssl@4; fi
  brew list "$OPENSSL" >/dev/null 2>&1 || brew install "$OPENSSL"
  # Python isolé pour le générateur nanopb de chiaki.
  [ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip -q install protobuf; }
  CMAKE_ARGS+=(-DPYTHON_EXECUTABLE="$PWD/.venv/bin/python"
    -DOPENSSL_ROOT_DIR="$(brew --prefix "$OPENSSL")"
    -DCMAKE_PREFIX_PATH="$(brew --prefix curl);$(brew --prefix "$OPENSSL")")
else
  P="${MINGW_PACKAGE_PREFIX:-mingw-w64-ucrt-x86_64}"
  pacman -S --needed --noconfirm git "$P-cc" "$P-cmake" "$P-ninja" "$P-pkgconf" "$P-curl" "$P-json-c" \
    "$P-libevent" "$P-miniupnpc" "$P-openssl" "$P-opus" "$P-protobuf" "$P-python" "$P-python-protobuf" >/dev/null
  CMAKE_ARGS+=(-G Ninja -DPYTHON_EXECUTABLE="$(command -v python)")
fi

# Sources chiaki-ng (version figée) + sous-modules nécessaires.
CHIAKI_REV=43728af2e639fecb8a7af1cd68c29820a40de973
if [ ! -d third_party/chiaki-ng/.git ]; then
  # Sans conversion des fins de ligne (sinon le patch ne s'applique pas sous Windows).
  git -c core.autocrlf=false clone https://github.com/streetpea/chiaki-ng third_party/chiaki-ng
  git -C third_party/chiaki-ng -c core.autocrlf=false checkout -q "$CHIAKI_REV"
fi
git -C third_party/chiaki-ng -c core.autocrlf=false submodule update --init --depth 1 third-party/nanopb third-party/jerasure third-party/gf-complete
# Patch chiaki : mode spectateur (n'annonce pas de manette à la PS5) et son demandé en
# stéréo (en 5.1, la PS5 renvoie un mixage replié qui sonne creux). Appliqué une seule fois.
PATCH=../../patches/chiaki-spectator.patch
if git -C third_party/chiaki-ng apply --check "$PATCH" 2>/dev/null; then
  git -C third_party/chiaki-ng apply "$PATCH"
elif ! git -C third_party/chiaki-ng apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "Le patch chiaki-spectator ne s'applique pas sur third_party/chiaki-ng." >&2
  git -C third_party/chiaki-ng apply --check -v "$PATCH" >&2 || true
  exit 1
fi

echo "==> pont C ($PLATFORM)"
cmake -S bridge -B build/bridge "${CMAKE_ARGS[@]}" >/dev/null
cmake --build build/bridge --target couchcast-bridge -j "$JOBS"

echo "==> serveur Go"
(cd server && go build -trimpath -ldflags "-s -w" -o "../build/couchcast-server$EXE" .)

echo "==> interface"
(cd web && { [ -d node_modules ] || npm ci; } && npm run build)

echo "OK : lancez ./run.sh"
