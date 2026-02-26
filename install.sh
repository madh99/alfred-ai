#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Alfred — One-liner installer
#  curl -fsSL https://raw.githubusercontent.com/yourusername/alfred/main/install.sh | bash
# ──────────────────────────────────────────────────────────────────────
set -e

REPO_URL="https://github.com/yourusername/alfred.git"
INSTALL_DIR="${ALFRED_INSTALL_DIR:-$HOME/.alfred}"
BRANCH="${ALFRED_BRANCH:-main}"

# ── ANSI colours ──────────────────────────────────────────────────────
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
MAGENTA='\033[35m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
info() { echo -e "  ${CYAN}→${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
fail() { echo -e "\n  ${RED}✗ $1${RESET}\n"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────
echo ""
echo -e "${MAGENTA}${BOLD}"
cat << 'BANNER'
     _    _     _____ ____  _____ ____
    / \  | |   |  ___|  _ \| ____|  _ \
   / _ \ | |   | |_  | |_) |  _| | | | |
  / ___ \| |___|  _| |  _ <| |___| |_| |
 /_/   \_\_____|_|   |_| \_\_____|____/
BANNER
echo -e "${RESET}"
echo -e "  ${DIM}Personal AI Assistant${RESET}"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────
info "Checking Node.js..."

if ! command -v node &>/dev/null; then
  echo ""
  fail "Node.js is not installed.\n\n  Install Node.js >= 20:\n    macOS:   brew install node\n    Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs\n    Other:   https://nodejs.org/"
fi

NODE_VERSION=$(node --version | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js v${NODE_VERSION} found, but >= 20 is required.\n  Upgrade at https://nodejs.org/"
fi

ok "Node.js v${NODE_VERSION}"

# ── 2. Check git ─────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  fail "git is not installed. Install git first: https://git-scm.com/"
fi

# ── 3. Check / install pnpm ──────────────────────────────────────────
info "Checking pnpm..."

if ! command -v pnpm &>/dev/null; then
  info "Installing pnpm..."
  if command -v corepack &>/dev/null; then
    corepack enable 2>/dev/null || true
    corepack prepare pnpm@9.15.4 --activate 2>/dev/null || npm install -g pnpm@9.15.4
  else
    npm install -g pnpm@9.15.4
  fi
  ok "pnpm installed"
else
  ok "pnpm v$(pnpm --version)"
fi

# ── 4. Clone / update repo ───────────────────────────────────────────
echo ""
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation at ${INSTALL_DIR}..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin "$BRANCH" 2>/dev/null || git pull origin "$BRANCH"
  ok "Updated to latest version"
else
  info "Installing Alfred to ${INSTALL_DIR}..."
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || \
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "Cloned repository"
fi

# ── 5. Install dependencies ──────────────────────────────────────────
info "Installing dependencies..."
pnpm install --ignore-scripts --reporter=silent 2>/dev/null || pnpm install --ignore-scripts
ok "Dependencies installed"

# ── 6. Build ─────────────────────────────────────────────────────────
info "Building..."
pnpm run build > /dev/null 2>&1
ok "Build complete"

# ── 7. Create data directory ─────────────────────────────────────────
mkdir -p data
[ ! -f ".env" ] && [ -f ".env.example" ] && cp .env.example .env

# ── 8. Add to PATH ───────────────────────────────────────────────────
ALFRED_BIN="$INSTALL_DIR/packages/cli/dist/index.js"

# Create a wrapper script in a standard bin directory
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/alfred" << WRAPPER
#!/usr/bin/env bash
exec node "$ALFRED_BIN" "\$@"
WRAPPER
chmod +x "$BIN_DIR/alfred"

# Check if BIN_DIR is in PATH
ADD_TO_PATH=""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  ADD_TO_PATH="$BIN_DIR"
  # Try to add to shell profile
  SHELL_PROFILE=""
  if [ -f "$HOME/.zshrc" ]; then
    SHELL_PROFILE="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_PROFILE="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then
    SHELL_PROFILE="$HOME/.profile"
  fi

  if [ -n "$SHELL_PROFILE" ]; then
    if ! grep -q "$BIN_DIR" "$SHELL_PROFILE" 2>/dev/null; then
      echo "" >> "$SHELL_PROFILE"
      echo "# Alfred CLI" >> "$SHELL_PROFILE"
      echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_PROFILE"
    fi
  fi
fi

ok "CLI installed"

# ── 9. Run setup wizard ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}─────────────────────────────────────────${RESET}"
echo ""

if [ -f "$ALFRED_BIN" ]; then
  node "$ALFRED_BIN" setup
fi

# ── Done ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✓ Alfred installed successfully!${RESET}"
echo ""
echo -e "  ${BOLD}alfred start${RESET}       Start Alfred"
echo -e "  ${BOLD}alfred setup${RESET}       Re-run setup wizard"
echo -e "  ${BOLD}alfred status${RESET}      Check configuration"
echo -e "  ${BOLD}alfred --help${RESET}      Show all commands"
echo ""

if [ -n "$ADD_TO_PATH" ]; then
  echo -e "  ${YELLOW}Restart your terminal or run:${RESET}"
  echo -e "    ${DIM}export PATH=\"$BIN_DIR:\$PATH\"${RESET}"
  echo ""
fi
