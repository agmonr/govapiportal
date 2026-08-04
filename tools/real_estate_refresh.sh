#!/usr/bin/env bash
#
# Monthly real-estate data refresh: fetch -> rebuild -> rebundle -> commit -> push.
#
# GovMap's real-estate API only ever exposes a recent rolling window per
# settlement (see tools/real_estate_fetch.py's own docstring - this was
# confirmed by probing the live endpoint, not assumed) - so multi-year
# coverage is a property of running this every month for years and merging
# by dealId, never of any single run. This is the script meant to be on a
# cron job (see install.sh) doing exactly that, unattended, on whatever
# machine actually runs it - not this repo's CI, since the raw deal dump is
# gitignored and multi-GB, unsuited to a fresh checkout each time.
#
# Needs the same environment tools/real_estate_build.py already needs
# (osgeo/GDAL, shapely, pyproj, numpy - see its own imports) and a git
# remote already configured for push (this script does not set up auth).
#
# Usage: ./tools/real_estate_refresh.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/zip"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/real_estate_refresh.log"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }

log "=== starting monthly real-estate refresh ==="

if ! command -v python3 >/dev/null 2>&1; then
  log "ERROR: python3 not found"
  exit 1
fi

log "fetching new deals + CPI..."
python3 tools/real_estate_fetch.py >>"$LOG_FILE" 2>&1

log "rebuilding city/neighborhood/deal data..."
python3 tools/real_estate_build.py >>"$LOG_FILE" 2>&1

log "rebundling dist/ pages..."
python3 tools/bundle.py >>"$LOG_FILE" 2>&1

new_deals="$(python3 -c "import json; print(json.load(open('zip/real_estate_fetch_status.json')).get('newDeals', '?'))" 2>/dev/null || echo '?')"

git add \
  src/real-estate-cities.js \
  src/real-estate-neighborhoods.js \
  src/real-estate-streets.js \
  assets/deals/ \
  dist/

if git diff --cached --quiet; then
  log "nothing changed, skipping commit"
else
  git commit -q -m "Monthly real-estate data refresh (+${new_deals} new deals)

Automated: tools/real_estate_refresh.sh"
  log "committed (+${new_deals} new deals)"
  git push
  log "pushed"
fi

log "=== done ==="
