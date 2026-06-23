#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec gunicorn --bind "0.0.0.0:${PORT:-5000}" --workers 2 --timeout 120 wsgi:app
