#!/usr/bin/env bash
# Compile la passerelle (macOS, dépendances via Homebrew) : pont C (lib chiaki-ng),
# serveur Go, interface React.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(uname -s)" = Darwin ] || { echo "Couchcast ne se compile que sur macOS."; exit 1; }
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

CMAKE_ARGS=(-DCMAKE_BUILD_TYPE=Release -Wno-dev)
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

# Sources chiaki-ng (version figée) + sous-modules nécessaires.
CHIAKI_REV=43728af2e639fecb8a7af1cd68c29820a40de973
if [ ! -d third_party/chiaki-ng/.git ]; then
  git -c core.autocrlf=false clone https://github.com/streetpea/chiaki-ng third_party/chiaki-ng
  git -C third_party/chiaki-ng -c core.autocrlf=false checkout -q "$CHIAKI_REV"
fi
git -C third_party/chiaki-ng -c core.autocrlf=false submodule update --init --depth 1 third-party/nanopb third-party/jerasure third-party/gf-complete
# Patch chiaki « mode spectateur » (n'annonce pas de manette à la PS5), appliqué une seule fois.
PATCH=../../patches/chiaki-spectator.patch
if git -C third_party/chiaki-ng apply --check "$PATCH" 2>/dev/null; then
  git -C third_party/chiaki-ng apply "$PATCH"
elif ! git -C third_party/chiaki-ng apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "Le patch chiaki-spectator ne s'applique pas sur third_party/chiaki-ng." >&2
  git -C third_party/chiaki-ng apply --check -v "$PATCH" >&2 || true
  exit 1
fi

echo "==> pont C"
cmake -S bridge -B build/bridge "${CMAKE_ARGS[@]}" >/dev/null
cmake --build build/bridge --target couchcast-bridge -j "$JOBS"

echo "==> serveur Go"
(cd server && go build -trimpath -ldflags "-s -w" -o ../build/couchcast-server .)

echo "==> interface"
(cd web && { [ -d node_modules ] || npm ci; } && npm run build)

echo "OK : lancez ./run.sh"
