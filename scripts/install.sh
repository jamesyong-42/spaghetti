#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}  ✔ %s${RESET}\n" "$*"; }
fail()  { printf "${RED}  ✖ %s${RESET}\n" "$*"; exit 1; }
dim()   { printf "${DIM}  %s${RESET}\n" "$*"; }

echo ""
info "  🍝 Installing Spaghetti CLI"
echo ""

# Check OS
OS="$(uname -s)"
case "$OS" in
  Darwin) dim "Platform: macOS" ;;
  Linux)  dim "Platform: Linux" ;;
  MINGW*|MSYS*|CYGWIN*) dim "Platform: Windows (Git Bash)" ;;
  *) fail "Unsupported platform: $OS" ;;
esac

# Check Node.js >= 18
if ! command -v node &>/dev/null; then
  fail "Node.js is required. Install from https://nodejs.org"
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js >= 18 required (found $(node -v))"
fi
ok "Node.js $(node -v)"

# Check npm
if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
ok "npm v$(npm -v)"

# Warn about build tools on Linux
if [ "$OS" = "Linux" ]; then
  if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
    echo ""
    dim "Note: better-sqlite3 requires build tools."
    dim "If install fails, run: sudo apt-get install -y build-essential python3"
    echo ""
  fi
fi

# Install
echo ""
info "  Installing @spaghetti/cli..."
echo ""
if npm install -g @spaghetti/cli@latest 2>&1 | tail -3; then
  echo ""
else
  echo ""
  fail "Installation failed. Check the error above."
fi

# Verify
if command -v spaghetti &>/dev/null; then
  ok "Installed spaghetti $(spaghetti --version 2>/dev/null || echo '')"
  echo ""
  dim "Run 'spaghetti' or 'spag' to get started."
  dim "Run 'spaghetti --help' for all commands."
  echo ""
else
  fail "Installation succeeded but 'spaghetti' not found in PATH."
fi
