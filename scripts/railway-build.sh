#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pip install -r requirements.txt

# Railway does not clone git submodules — vendor sprites/fonts into static/
if [ -d gather-clone/frontend/public/sprites ]; then
  mkdir -p static/sprites static/fonts
  rsync -a gather-clone/frontend/public/sprites/ static/sprites/
  rsync -a gather-clone/frontend/public/fonts/ static/fonts/ 2>/dev/null || true
fi

cd game-client
npm ci
npm run build
