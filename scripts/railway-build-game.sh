#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../game-server"

# Keep game-server map in sync when building from full repo (webp root)
if [ -f ../data/defaultmap.json ]; then
  mkdir -p data
  cp ../data/defaultmap.json data/defaultmap.json
fi

npm ci
npm run build
