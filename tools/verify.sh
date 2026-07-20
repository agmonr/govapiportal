#!/usr/bin/env bash
#
# Serves the site and drives it in a real browser.
# Fails on any console error, any failed request, or any broken assertion.
#
# Usage:  ./tools/verify.sh

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="$(dirname "$TOOLS_DIR")"
PORT="${PORT:-8123}"

export PATH="$HOME/.local/node/bin:$PATH"

if ! command -v node >/dev/null; then
  echo "node not found - run ./tools/setup.sh first" >&2
  exit 1
fi

# The offline copy is generated, so it can silently fall behind apis.json.
# Catch that here rather than shipping a stale map to anyone who downloads it.
"$TOOLS_DIR/bundle.py" --check

# fetch and ES modules are both blocked on file://, so this must go over HTTP.
python3 -m http.server "$PORT" --directory "$SITE_DIR" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/" >/dev/null && break
  sleep .25
done

node "$TOOLS_DIR/smoke.mjs" "http://localhost:$PORT"
