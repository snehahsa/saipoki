#!/usr/bin/env bash
# Start Flask (5000) + game server (3001) for local multiplayer testing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GAME_PORT="${GAME_PORT:-3001}"
export PORT="${PORT:-5000}"

port_listener_pids() {
  lsof -ti "tcp:${1}" -sTCP:LISTEN 2>/dev/null || true
}

port_listener_comm() {
  lsof -i "tcp:${1}" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}'
}

is_port_listening() {
  [ -n "$(port_listener_pids "$1")" ]
}

# macOS AirPlay Receiver permanently owns :5000 — never fight it; use 5001.
pick_flask_port() {
  local port="${PORT:-5000}"
  if ! is_port_listening "$port"; then
    echo "$port"
    return
  fi
  local comm
  comm="$(port_listener_comm "$port")"
  if [ "$comm" = "ControlCe" ] || [ "$port" = "5000" ]; then
    echo "5001"
    return
  fi
  echo "$port"
}

PORT="$(pick_flask_port)"
export PORT

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

free_port "$GAME_PORT" "game server"

# Only stop our own Flask/Python on the chosen port — not macOS AirPlay on 5000.
if is_port_listening "$PORT"; then
  comm="$(port_listener_comm "$PORT")"
  case "$comm" in
    Python|python|Python3|python3)
      free_port "$PORT" "Flask"
      ;;
    *)
      echo "Port ${PORT} is in use by ${comm:-unknown} — set PORT= to another value." >&2
      exit 1
      ;;
  esac
fi

if is_port_listening "$PORT"; then
  echo "Could not bind Flask — port ${PORT} is still in use." >&2
  exit 1
fi

echo "Flask:       http://127.0.0.1:${PORT}  (/?alice, /?bob, /?alive)"
echo "Game server: http://127.0.0.1:${GAME_PORT}"
echo "Press Ctrl+C to stop both."
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

for _ in $(seq 1 40); do
  if is_port_listening "$PORT"; then
    break
  fi
  if ! kill -0 "$FLASK_PID" 2>/dev/null; then
    echo "Flask failed to start on port ${PORT}." >&2
    wait "$FLASK_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 0.25
done

if ! is_port_listening "$PORT"; then
  echo "Flask did not bind to port ${PORT}." >&2
  exit 1
fi

echo "Game ready → http://127.0.0.1:${PORT}/?alice"

wait "$FLASK_PID" "$GAME_PID"
