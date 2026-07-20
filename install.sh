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
