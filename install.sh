#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Alfred — Installer
#  Run: git clone <repo> && cd alfred && ./install.sh
# ──────────────────────────────────────────────────────────────────────
set -e

# ── ANSI colours ──────────────────────────────────────────────────────
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
MAGENTA='\033[35m'

ok()   { echo -e "  ${GREEN}[OK]${RESET} $1"; }
info() { echo -e "  ${CYAN}...${RESET} $1"; }
warn() { echo -e "  ${YELLOW}[!]${RESET} $1"; }
fail() { echo -e "  ${RED}[X]${RESET} $1"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────
echo ""
echo -e "${MAGENTA}${BOLD}"
echo '     _    _     _____ ____  _____ ____  '
echo '    / \  | |   |  ___|  _ \| ____|  _ \ '
echo '   / _ \ | |   | |_  | |_) |  _| | | | |'
echo '  / ___ \| |___|  _| |  _ <| |___| |_| |'
echo ' /_/   \_\_____|_|   |_| \_\_____|____/ '
echo -e "${RESET}"
echo -e "${DIM}  Personal AI Assistant — Installer${RESET}"
echo ""
echo -e "${CYAN}──────────────────────────────────────────────${RESET}"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────────────────
info "Checking Node.js..."

if ! command -v node &>/dev/null; then
  fail "Node.js is not installed.
  Please install Node.js >= 20 from https://nodejs.org/
  On macOS:   brew install node
  On Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
  On Fedora:  sudo dnf install nodejs"
fi

NODE_VERSION=$(node --version | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js v${NODE_VERSION} found, but >= 20 is required.
  Please upgrade: https://nodejs.org/"
fi

ok "Node.js v${NODE_VERSION}"

# ── 2. Check / install pnpm ──────────────────────────────────────────
info "Checking pnpm..."

if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found."
  echo ""
  echo -e "  ${BOLD}How would you like to install pnpm?${RESET}"
  echo -e "    ${CYAN}1)${RESET} corepack enable (recommended, ships with Node.js)"
  echo -e "    ${CYAN}2)${RESET} npm install -g pnpm@9.15.4"
  echo -e "    ${CYAN}3)${RESET} Abort — I'll install it myself"
  echo ""
  read -rp "  > " PNPM_CHOICE

  case "$PNPM_CHOICE" in
    1)
      info "Running: corepack enable && corepack prepare pnpm@9.15.4 --activate"
      if corepack enable && corepack prepare pnpm@9.15.4 --activate; then
        ok "pnpm installed via corepack"
      else
        fail "corepack failed. Try option 2, or install pnpm manually: https://pnpm.io/installation"
      fi
      ;;
    2)
      info "Running: npm install -g pnpm@9.15.4"
      if npm install -g pnpm@9.15.4; then
        ok "pnpm installed via npm"
      else
        fail "npm install failed. Try: sudo npm install -g pnpm@9.15.4"
      fi
      ;;
    *)
      echo ""
      echo -e "  Install pnpm and re-run this script."
      echo -e "  https://pnpm.io/installation"
      exit 0
      ;;
  esac
else
  PNPM_VERSION=$(pnpm --version)
  ok "pnpm v${PNPM_VERSION}"
fi

# ── 3. Install dependencies ──────────────────────────────────────────
echo ""
info "Installing dependencies (this may take a minute)..."

if pnpm install --ignore-scripts; then
  ok "Dependencies installed"
else
  fail "pnpm install failed. Check the output above for errors."
fi

# ── 4. Build ──────────────────────────────────────────────────────────
info "Building project..."

if pnpm run build; then
  ok "Build complete"
else
  fail "Build failed. Check the output above for errors."
fi

# ── 5. Create data/ directory ─────────────────────────────────────────
if [ ! -d "data" ]; then
  mkdir -p data
  ok "Created data/ directory"
else
  ok "data/ directory exists"
fi

# ── 6. Copy .env.example -> .env ──────────────────────────────────────
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    ok "Copied .env.example to .env"
  else
    warn ".env.example not found — .env will be created by setup wizard"
  fi
else
  ok ".env already exists (skipping copy)"
fi

# ── 7. Run interactive setup wizard ──────────────────────────────────
echo ""
echo -e "${CYAN}──────────────────────────────────────────────${RESET}"
echo -e "${BOLD}  Interactive Setup${RESET}"
echo -e "${CYAN}──────────────────────────────────────────────${RESET}"
echo ""

if [ -f "packages/cli/dist/index.js" ]; then
  node packages/cli/dist/index.js setup
else
  warn "CLI not built — skipping setup wizard."
  warn "Run 'pnpm run build' then 'node packages/cli/dist/index.js setup' manually."
fi

# ── 8. Link CLI globally ─────────────────────────────────────────────
echo ""
info "Linking CLI globally..."

if pnpm --filter @alfred/cli link --global 2>/dev/null; then
  ok "CLI linked globally — 'alfred' command is now available"
else
  warn "Could not link globally. You can still run Alfred with:"
  echo -e "    ${DIM}node packages/cli/dist/index.js start${RESET}"
  echo -e "  Or add this to your PATH:"
  echo -e "    ${DIM}$(pwd)/packages/cli/dist${RESET}"
fi

# ── 9. Done ───────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  Alfred installation complete!${RESET}"
echo -e "${GREEN}══════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}alfred start${RESET}       Start Alfred"
echo -e "  ${BOLD}alfred status${RESET}      Check configuration"
echo -e "  ${BOLD}alfred setup${RESET}       Re-run setup wizard"
echo -e "  ${BOLD}alfred --help${RESET}      Show all commands"
echo ""
echo -e "  ${DIM}Edit .env or config/default.yml for manual configuration.${RESET}"
echo ""
