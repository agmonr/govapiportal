#!/usr/bin/env bash
#
# Serves the site locally and opens it in a browser.
#
# Why a server at all: index.html and datagov.html load their code as ES
# modules (<script type="module">). Browsers block module scripts - and
# fetch() - from a file:// document, since file:// has no notion of
# same-origin. Serving over plain HTTP (even localhost) sidesteps that.
# This does not build or generate anything; it serves the existing static
# files as-is, the same as GitHub Pages does.
#
# (If you want a server-free copy instead - e.g. to email someone - see
#  dist/map.html / dist/datagov.html, built by tools/bundle.py.)
#
# Usage: ./run.sh [port]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8000}"
URL="http://localhost:$PORT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found - run ./install.sh first" >&2
  exit 1
fi

echo "Serving $ROOT at $URL (Ctrl+C to stop)"

python3 -m http.server "$PORT" --directory "$ROOT" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf "$URL" >/dev/null 2>&1 && break
  sleep 0.25
done

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
else
  echo "Open $URL in a browser."
fi

wait "$server"
