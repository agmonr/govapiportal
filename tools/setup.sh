#!/usr/bin/env bash
#
# Local verification toolchain for the API map.
#
# The site itself needs none of this - it is static ES modules and ships as-is
# to GitHub Pages. This installs what is needed to *check* it in a real browser,
# because "it parses" and "it runs" are different claims and this repo has been
# burned by the gap.
#
# Everything lands under $HOME. No root, no sudo, nothing touched outside:
#   ~/.local/node             Node runtime (prebuilt tarball)
#   ~/.cache/ms-playwright    Chromium headless shell
#   tools/node_modules        Playwright package
#
# Usage:  ./tools/setup.sh          install
#         ./tools/setup.sh --check  report what is present, install nothing

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.17.0}"
NODE_DIR="$HOME/.local/node"
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# --check exits non-zero if anything is missing, so CI can gate on it.
if [[ "${1:-}" == "--check" ]]; then
  missing=0
  say "Toolchain status"
  if [[ -x "$NODE_DIR/bin/node" ]]; then ok "node $("$NODE_DIR/bin/node" -v)"
  else warn "node not installed"; missing=1; fi
  if [[ -d "$TOOLS_DIR/node_modules/playwright" ]]; then ok "playwright present"
  else warn "playwright not installed"; missing=1; fi
  if compgen -G "$HOME/.cache/ms-playwright/chromium*" >/dev/null; then ok "chromium present"
  else warn "chromium not downloaded"; missing=1; fi
  command -v python3 >/dev/null && ok "python3 $(python3 -V | cut -d' ' -f2)" \
    || { warn "python3 missing - needed to serve the site"; missing=1; }
  exit "$missing"
fi

# --- node ---------------------------------------------------------------
# Prebuilt tarball rather than apt: no root available, and this pins the
# version regardless of what the distro ships.
if [[ -x "$NODE_DIR/bin/node" ]]; then
  say "Node already installed: $("$NODE_DIR/bin/node" -v)"
else
  say "Installing Node v$NODE_VERSION into $NODE_DIR"
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  ok "node $("$NODE_DIR/bin/node" -v)"
fi

export PATH="$NODE_DIR/bin:$PATH"

# --- playwright + chromium ----------------------------------------------
say "Installing Playwright"
cd "$TOOLS_DIR"
npm install --no-audit --no-fund
ok "playwright installed"

say "Downloading Chromium"
# Only chromium - the other engines are ~400 MB and nothing here needs them.
npx playwright install chromium
ok "chromium ready"

say "Done"
cat <<EOF
  Add Node to your PATH for this shell:
      export PATH="\$HOME/.local/node/bin:\$PATH"

  Then verify the site:
      ./tools/verify.sh

  Note: Playwright's own browser deps may be missing on a bare system. If
  Chromium fails to launch, the fix needs root:
      sudo npx playwright install-deps chromium
EOF
