#!/usr/bin/env bash
# Start Flask (5000) + game server (3001) for local multiplayer testing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GAME_PORT="${GAME_PORT:-3001}"
export PORT="${PORT:-5000}"

echo "Flask:       http://127.0.0.1:${PORT}  (/?alice, /?bob, /?alive)"
echo "Game server: http://127.0.0.1:${GAME_PORT}"
echo "Press Ctrl+C to stop both."

cleanup() {
  kill "$GAME_PID" "$FLASK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd game-server && npm run dev) &
GAME_PID=$!
sleep 1
python3 app.py &
FLASK_PID=$!

wait "$FLASK_PID" "$GAME_PID"
