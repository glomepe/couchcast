#!/usr/bin/env bash
# Compile la passerelle : pont C (lib chiaki-ng), serveur Go, interface React.
set -euo pipefail
cd "$(dirname "$0")"

# Dépendances Homebrew (sans effet si déjà installées).
brew list cmake go pkgconf protobuf miniupnpc libevent json-c opus openssl@4 curl >/dev/null 2>&1 \
  || brew install cmake go pkgconf protobuf miniupnpc libevent json-c opus openssl@4 curl

# Python isolé pour le générateur nanopb de chiaki.
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip -q install protobuf; }

# Sources chiaki-ng (version figée) + sous-modules nécessaires.
CHIAKI_REV=43728af2e639fecb8a7af1cd68c29820a40de973
if [ ! -d third_party/chiaki-ng/.git ]; then
  git clone https://github.com/streetpea/chiaki-ng third_party/chiaki-ng
  git -C third_party/chiaki-ng checkout -q "$CHIAKI_REV"
fi
git -C third_party/chiaki-ng submodule update --init --depth 1 third-party/nanopb third-party/jerasure third-party/gf-complete
# Patch « mode spectateur » (n'annonce pas de manette à la PS5), appliqué une seule fois.
if git -C third_party/chiaki-ng apply --check ../../patches/chiaki-spectator.patch 2>/dev/null; then
  git -C third_party/chiaki-ng apply ../../patches/chiaki-spectator.patch
fi

echo "==> pont C"
# Homebrew expose les en-têtes d'OpenSSL 4 dans /opt/homebrew/include : on lie la même version.
cmake -S bridge -B build/bridge -DCMAKE_BUILD_TYPE=Release -Wno-dev \
  -DPYTHON_EXECUTABLE="$PWD/.venv/bin/python" \
  -DOPENSSL_ROOT_DIR="$(brew --prefix openssl@4)" \
  -DCMAKE_PREFIX_PATH="$(brew --prefix curl);$(brew --prefix openssl@4)" >/dev/null
cmake --build build/bridge --target couchcast-bridge -j "$(sysctl -n hw.ncpu)"

echo "==> serveur Go"
(cd server && go build -o ../build/couchcast-server .)

echo "==> interface"
(cd web && { [ -d node_modules ] || npm ci; } && npm run build)

echo "OK : lancez ./run.sh"
