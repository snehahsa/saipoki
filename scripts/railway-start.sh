#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Persistent SQLite when Railway volume is mounted at /data
if [ -d /data ] && [ -w /data ]; then
  export DB_PATH="${DB_PATH:-/data/users.db}"
  echo "Using persistent DB_PATH=${DB_PATH}"
fi

# Background worker: pays out pending $POKEQUEST withdrawals from treasury.
if command -v python3 >/dev/null 2>&1; then
  python3 scripts/wallet_withdraw_worker.py >>/tmp/wallet_withdraw_worker.log 2>&1 &
  echo "Started wallet withdraw worker (pid $!)"
fi

exec gunicorn --bind "0.0.0.0:${PORT:-5000}" --workers 1 --timeout 120 wsgi:app
