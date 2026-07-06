#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pip install -r requirements.txt

# Copy vendored sprites/fonts when submodule checkout exists (optional).
if [ -d gather-clone/frontend/public/sprites ]; then
  mkdir -p static/sprites static/fonts
  rsync -a gather-clone/frontend/public/sprites/ static/sprites/
  rsync -a gather-clone/frontend/public/fonts/ static/fonts/ 2>/dev/null || true
fi

python3 -c "import sys; sys.path.insert(0, 'map-builder'); from sprite_catalog import publish_single_assets; published = publish_single_assets(); print(f'single sprites published: {len(published.get(\"sprites\") or [])}')"
if [ -d static/sprites/animations ]; then
  python3 -c "from animation_catalog import sync_manifest; found = sync_manifest(); print(f'animation manifest: {len(found)} entries')"
fi

# Gear attach configs live in static/ — sync manifest for game + map builder.
python3 -c "from gear_catalog import sync_items_manifest; sync_items_manifest(); print('gear items manifest synced from static/ configs')"

if [ -f gather-clone/frontend/utils/defaultmap.json ]; then
  mkdir -p data game-server/data
  cp gather-clone/frontend/utils/defaultmap.json data/defaultmap.json
  cp gather-clone/frontend/utils/defaultmap.json game-server/data/defaultmap.json
elif [ -f data/defaultmap.json ]; then
  mkdir -p game-server/data
  cp data/defaultmap.json game-server/data/defaultmap.json
fi

cd game-client
npm ci
npm run build
echo "game.js built: $(wc -c < ../static/game/game.js) bytes"
