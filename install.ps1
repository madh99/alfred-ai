# ──────────────────────────────────────────────────────────────────────
#  Alfred — Windows PowerShell Installer
#  Run: git clone <repo> && cd alfred && .\install.ps1
# ──────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

function Write-OK($msg)   { Write-Host "  [OK] " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Info($msg)  { Write-Host "  ... " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Write-Warn($msg)  { Write-Host "  [!] " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Fail($msg)  { Write-Host "  [X] " -ForegroundColor Red -NoNewline; Write-Host $msg; exit 1 }

# ── Banner ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "     _    _     _____ ____  _____ ____  " -ForegroundColor Magenta
Write-Host "    / \  | |   |  ___|  _ \| ____|  _ \ " -ForegroundColor Magenta
Write-Host "   / _ \ | |   | |_  | |_) |  _| | | | |" -ForegroundColor Magenta
Write-Host "  / ___ \| |___|  _| |  _ <| |___| |_| |" -ForegroundColor Magenta
Write-Host " /_/   \_\_____|_|   |_| \_\_____|____/ " -ForegroundColor Magenta
Write-Host ""
Write-Host "  Personal AI Assistant — Installer" -ForegroundColor DarkGray
Write-Host ""
Write-Host "──────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check Node.js ──────────────────────────────────────────────────
Write-Info "Checking Node.js..."

try {
    $nodeVersionRaw = & node --version 2>$null
} catch {
    $nodeVersionRaw = $null
}

if (-not $nodeVersionRaw) {
    Write-Fail "Node.js is not installed.`n  Please install Node.js >= 20 from https://nodejs.org/"
}

$nodeVersion = $nodeVersionRaw -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])

if ($nodeMajor -lt 20) {
    Write-Fail "Node.js v$nodeVersion found, but >= 20 is required.`n  Please upgrade: https://nodejs.org/"
}

Write-OK "Node.js v$nodeVersion"

# ── 2. Check / install pnpm ──────────────────────────────────────────
Write-Info "Checking pnpm..."

$pnpmExists = $false
try {
    $pnpmVersionRaw = & pnpm --version 2>$null
    if ($pnpmVersionRaw) { $pnpmExists = $true }
} catch {}

if (-not $pnpmExists) {
    Write-Warn "pnpm not found."
    Write-Host ""
    Write-Host "  How would you like to install pnpm?" -ForegroundColor White
    Write-Host "    1) corepack enable (recommended, ships with Node.js)" -ForegroundColor Cyan
    Write-Host "    2) npm install -g pnpm@9.15.4" -ForegroundColor Cyan
    Write-Host "    3) Abort — I'll install it myself" -ForegroundColor Cyan
    Write-Host ""
    $choice = Read-Host "  > "

    switch ($choice) {
        "1" {
            Write-Info "Running: corepack enable && corepack prepare pnpm@9.15.4 --activate"
            try {
                & corepack enable
                & corepack prepare pnpm@9.15.4 --activate
                Write-OK "pnpm installed via corepack"
            } catch {
                Write-Fail "corepack failed. Try option 2, or install pnpm manually: https://pnpm.io/installation"
            }
        }
        "2" {
            Write-Info "Running: npm install -g pnpm@9.15.4"
            try {
                & npm install -g pnpm@9.15.4
                Write-OK "pnpm installed via npm"
            } catch {
                Write-Fail "npm install failed. Try running as Administrator."
            }
        }
        default {
            Write-Host ""
            Write-Host "  Install pnpm and re-run this script."
            Write-Host "  https://pnpm.io/installation"
            exit 0
        }
    }
} else {
    Write-OK "pnpm v$pnpmVersionRaw"
}

# ── 3. Install dependencies ──────────────────────────────────────────
Write-Host ""
Write-Info "Installing dependencies (this may take a minute)..."

try {
    & pnpm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    Write-OK "Dependencies installed"
} catch {
    Write-Fail "pnpm install failed. Check the output above for errors."
}

# ── 4. Build ──────────────────────────────────────────────────────────
Write-Info "Building project..."

try {
    & pnpm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    Write-OK "Build complete"
} catch {
    Write-Fail "Build failed. Check the output above for errors."
}

# ── 5. Create data/ directory ─────────────────────────────────────────
if (-not (Test-Path "data")) {
    New-Item -ItemType Directory -Path "data" -Force | Out-Null
    Write-OK "Created data/ directory"
} else {
    Write-OK "data/ directory exists"
}

# ── 6. Copy .env.example -> .env ──────────────────────────────────────
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-OK "Copied .env.example to .env"
    } else {
        Write-Warn ".env.example not found — .env will be created by setup wizard"
    }
} else {
    Write-OK ".env already exists (skipping copy)"
}

# ── 7. Run interactive setup wizard ──────────────────────────────────
Write-Host ""
Write-Host "──────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "  Interactive Setup" -ForegroundColor White
Write-Host "──────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host ""

if (Test-Path "packages/cli/dist/index.js") {
    & node packages/cli/dist/index.js setup
} else {
    Write-Warn "CLI not built — skipping setup wizard."
    Write-Warn "Run 'pnpm run build' then 'node packages/cli/dist/index.js setup' manually."
}

# ── 8. Done ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Alfred installation complete!" -ForegroundColor Green
Write-Host "══════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  alfred start       " -NoNewline -ForegroundColor White; Write-Host "Start Alfred"
Write-Host "  alfred status      " -NoNewline -ForegroundColor White; Write-Host "Check configuration"
Write-Host "  alfred setup       " -NoNewline -ForegroundColor White; Write-Host "Re-run setup wizard"
Write-Host "  alfred --help      " -NoNewline -ForegroundColor White; Write-Host "Show all commands"
Write-Host ""
Write-Host "  Edit .env or config/default.yml for manual configuration." -ForegroundColor DarkGray
Write-Host ""
