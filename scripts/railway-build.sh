#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pip install -r requirements.txt

# Copy vendored sprites/fonts when submodule checkout exists (optional).
if [ -d gather-clone/frontend/public/sprites ]; then
  mkdir -p static/sprites static/fonts
  # Keep committed gear attach JSON (map-builder rects) — gather-clone may lack or stale them.
  rsync -a gather-clone/frontend/public/sprites/ static/sprites/ \
    --exclude 'spritesheets/items/manifest.json' \
    --exclude 'spritesheets/items/fishing_rod.json' \
    --exclude 'spritesheets/items/hub_key.json'
  rsync -a gather-clone/frontend/public/fonts/ static/fonts/ 2>/dev/null || true
fi

python3 -c "
import sys
sys.path.insert(0, 'map-builder')
from sprite_catalog import publish_single_assets
published = publish_single_assets()
print(f'single sprites published: {len(published.get(\"sprites\") or [])}')
"
if [ -d static/sprites/animations ]; then
  python3 -c "from animation_catalog import sync_manifest; found = sync_manifest(); print(f'animation manifest: {len(found)} entries')"
fi

# Gear attach configs — restore missing JSON, refresh manifest (never fail the build).
python3 -c "from gear_catalog import ensure_gear_item_files; ensure_gear_item_files(); print('gear item files ensured')"

if [ -f gather-clone/frontend/utils/defaultmap.json ]; then
  mkdir -p data game-server/data
  cp gather-clone/frontend/utils/defaultmap.json data/defaultmap.json
  cp gather-clone/frontend/utils/defaultmap.json game-server/data/defaultmap.json
elif [ -f data/defaultmap.json ]; then
  mkdir -p game-server/data
  cp data/defaultmap.json game-server/data/defaultmap.json
fi

GAME_CLIENT_MARKER="gather-clone/frontend/utils/pixi/realmPreload.ts"
if command -v npm >/dev/null 2>&1 && [ -f "${GAME_CLIENT_MARKER}" ]; then
  cd game-client
  npm ci
  npm run build
  echo "game.js built: $(wc -c < ../static/game/game.js) bytes"
else
  if [ -f static/game/game.js ]; then
    if [ ! -f "${GAME_CLIENT_MARKER}" ]; then
      echo "gather-clone not checked out — using committed static/game/game.js ($(wc -c < static/game/game.js) bytes)"
    else
      echo "npm not available — using committed static/game/game.js ($(wc -c < static/game/game.js) bytes)"
    fi
  else
    echo "ERROR: cannot build game.js (need npm + gather-clone or committed static/game/game.js)" >&2
    exit 1
  fi
fi
