#!/usr/bin/env bash
# Démarre la passerelle (interface sur http://<IP-du-Mac>:8765/).
set -euo pipefail
cd "$(dirname "$0")"
[ -x build/couchcast-server ] || ./build.sh
exec build/couchcast-server -listen "${LISTEN:-:8765}" "$@"
