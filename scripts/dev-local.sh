#!/usr/bin/env bash
# Start Flask (5000) + game server (3001) for local multiplayer testing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GAME_PORT="${GAME_PORT:-3001}"
export PORT="${PORT:-5000}"

pick_python() {
  if [ -n "${PYTHON:-}" ] && command -v "$PYTHON" >/dev/null 2>&1; then
    echo "$PYTHON"
    return
  fi
  for candidate in \
    "$ROOT/.venv/bin/python" \
    "$ROOT/../.venv/bin/python" \
    "$(command -v python3 2>/dev/null || true)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  echo "python3"
}

PYTHON="$(pick_python)"

free_port() {
  local port="$1"
  local label="$2"
  local pids=""
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  echo "Stopping ${label} on port ${port} (pid ${pids//$'\n'/ })..."
  kill $pids 2>/dev/null || true
  sleep 0.4
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
    sleep 0.2
  fi
}

ensure_python_deps() {
  echo "Checking Python deps ($(basename "$PYTHON"))..."
  if ! "$PYTHON" -c "import nacl, base58" 2>/dev/null; then
    echo "Installing requirements.txt (PyNaCl, base58, etc.)..."
    "$PYTHON" -m pip install -r requirements.txt
  fi
  "$PYTHON" -c "import nacl, base58" 2>/dev/null || {
    echo "Missing Python packages. Run: $PYTHON -m pip install -r requirements.txt" >&2
    exit 1
  }
}

ensure_game_server_deps() {
  if [ ! -d game-server/node_modules ]; then
    echo "Installing game-server npm packages..."
    (cd game-server && npm ci)
  fi
}

echo "Flask:       http://127.0.0.1:${PORT}  (/?alice, /?bob, /?alive)"
echo "Game server: http://127.0.0.1:${GAME_PORT}"
echo "Press Ctrl+C to stop both."

free_port "$GAME_PORT" "game server"
free_port "$PORT" "Flask"
ensure_python_deps
ensure_game_server_deps

cleanup() {
  kill "$GAME_PID" "$FLASK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd game-server && npm run dev) &
GAME_PID=$!

for _ in $(seq 1 40); do
  if lsof -ti "tcp:${GAME_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! lsof -ti "tcp:${GAME_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Game server failed to start on port ${GAME_PORT}." >&2
  wait "$GAME_PID" 2>/dev/null || true
  exit 1
fi

"$PYTHON" app.py &
FLASK_PID=$!

wait "$FLASK_PID" "$GAME_PID"
