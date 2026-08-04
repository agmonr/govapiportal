#!/usr/bin/env bash
#
# Checks for what's needed to run the site locally.
#
# The site is static (no build step, no dependencies) and ships to GitHub
# Pages as-is. The only reason to run anything locally at all is that
# browsers refuse to load ES module scripts and fetch() from a file://
# document - so index.html and datagov.html need to be served over plain
# HTTP. python3's built-in http.server does that; nothing else is required.
#
# This installs nothing by itself - there is nothing to install for a
# dependency-free static site. It just verifies python3 is on PATH and
# points at run.sh.
#
# (Separate from tools/setup.sh, which installs Node + Playwright + Chromium
#  for the browser-based verification suite in tools/verify.sh - that's a
#  different, optional toolchain for checking the site, not for running it.)
#
# Usage: ./install.sh

set -euo pipefail

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

say "Checking requirements"

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -V | cut -d' ' -f2)"
else
  fail "python3 not found"
  echo "  Install it via your system package manager (e.g. apt install python3, brew install python3)." >&2
  exit 1
fi

say "Ready"
echo "  Nothing else to install - the site has no dependencies."
echo "  Start it with:"
echo "      ./run.sh"

# --- Monthly real-estate data refresh (tools/real_estate_refresh.sh) -------
#
# Separate from everything above: this doesn't run the site, it keeps the
# real-estate deals dataset current. GovMap's API only ever exposes a recent
# rolling window per settlement (see tools/real_estate_fetch.py), so
# multi-year coverage only comes from running this every month for years and
# accumulating - a cron job, not a one-off. Needs tools/real_estate_build.py's
# own heavier deps (GDAL/osgeo, shapely, pyproj, numpy) already on this
# machine, and a git remote already configured for push - neither is checked
# here, this only registers the schedule.
say "Real-estate data refresh (monthly cron)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFRESH_SCRIPT="$ROOT/tools/real_estate_refresh.sh"
CRON_LINE="0 3 1 * * $REFRESH_SCRIPT >> $ROOT/zip/real_estate_refresh.cron.log 2>&1"

if ! command -v crontab >/dev/null 2>&1; then
  fail "crontab not found - add this manually to whatever scheduler this machine uses:"
  echo "      $REFRESH_SCRIPT"
elif crontab -l 2>/dev/null | grep -qF "$REFRESH_SCRIPT"; then
  ok "monthly cron job already installed"
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  ok "installed: runs on the 1st of every month at 03:00"
  echo "      $CRON_LINE"
fi
