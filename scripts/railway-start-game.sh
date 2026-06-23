#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../game-server"
exec node dist/index.js
