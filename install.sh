#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
#  Alfred — Personal AI Assistant
#  curl -fsSL https://raw.githubusercontent.com/user/alfred/main/install.sh | bash
# ──────────────────────────────────────────────────────────────────
set -e

PACKAGE="@madh-io/alfred-ai"

R='\033[0m' B='\033[1m' G='\033[32m' Y='\033[33m' C='\033[36m' M='\033[35m' RE='\033[31m'

echo ""
echo -e "${M}${B}"
echo '     _    _     _____ ____  _____ ____  '
echo '    / \  | |   |  ___|  _ \| ____|  _ \ '
echo '   / _ \ | |   | |_  | |_) |  _| | | | |'
echo '  / ___ \| |___|  _| |  _ <| |___| |_| |'
echo ' /_/   \_\_____|_|   |_| \_\_____|____/ '
echo -e "${R}"

# ── Check Node.js ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "  ${RE}Node.js is not installed.${R}"
  echo ""
  echo "  Install Node.js 20+ first:"
  echo "    macOS:   brew install node"
  echo "    Ubuntu:  sudo apt install nodejs npm"
  echo "    Windows: winget install OpenJS.NodeJS.LTS"
  echo "    Other:   https://nodejs.org/"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "  ${RE}Node.js $(node --version) is too old. Need >= 20.${R}"
  echo "  Upgrade: https://nodejs.org/"
  exit 1
fi

echo -e "  ${G}✓${R} Node.js $(node --version)"

# ── Install package ──────────────────────────────────────────────
echo -e "  ${C}→${R} Installing ${PACKAGE}..."
npm install -g "$PACKAGE"
echo -e "  ${G}✓${R} Installed"

# ── Run setup ────────────────────────────────────────────────────
echo ""
alfred setup

echo ""
echo -e "  ${G}${B}✓ Alfred is ready!${R}"
echo ""
echo -e "  ${B}alfred start${R}    Start the assistant"
echo -e "  ${B}alfred setup${R}    Re-run setup wizard"
echo -e "  ${B}alfred --help${R}   Show all commands"
echo ""
