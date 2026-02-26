# ──────────────────────────────────────────────────────────────────
#  Alfred — Personal AI Assistant
#  irm https://raw.githubusercontent.com/user/alfred/main/install.ps1 | iex
# ──────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$Package = "alfred-ai"

Write-Host ""
Write-Host "     _    _     _____ ____  _____ ____  " -ForegroundColor Magenta
Write-Host "    / \  | |   |  ___|  _ \| ____|  _ \ " -ForegroundColor Magenta
Write-Host "   / _ \ | |   | |_  | |_) |  _| | | | |" -ForegroundColor Magenta
Write-Host "  / ___ \| |___|  _| |  _ <| |___| |_| |" -ForegroundColor Magenta
Write-Host " /_/   \_\_____|_|   |_| \_\_____|____/ " -ForegroundColor Magenta
Write-Host ""

# ── Check Node.js ────────────────────────────────────────────────
try {
    $nodeVersionRaw = & node --version 2>$null
} catch {
    $nodeVersionRaw = $null
}

if (-not $nodeVersionRaw) {
    Write-Host "  Node.js is not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install Node.js 20+ first:"
    Write-Host "    winget install OpenJS.NodeJS.LTS"
    Write-Host "    Or: https://nodejs.org/"
    Write-Host ""
    exit 1
}

$nodeMajor = [int](($nodeVersionRaw -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Host "  Node.js $nodeVersionRaw is too old. Need >= 20." -ForegroundColor Red
    Write-Host "  Upgrade: https://nodejs.org/"
    exit 1
}

Write-Host "  ✓ " -ForegroundColor Green -NoNewline
Write-Host "Node.js $nodeVersionRaw"

# ── Install package ──────────────────────────────────────────────
Write-Host "  → " -ForegroundColor Cyan -NoNewline
Write-Host "Installing $Package..."

& npm install -g $Package
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Installation failed. Try running as Administrator." -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ " -ForegroundColor Green -NoNewline
Write-Host "Installed"

# ── Run setup ────────────────────────────────────────────────────
Write-Host ""
& alfred setup

Write-Host ""
Write-Host "  ✓ Alfred is ready!" -ForegroundColor Green
Write-Host ""
Write-Host "  alfred start   " -NoNewline -ForegroundColor White; Write-Host " Start the assistant"
Write-Host "  alfred setup   " -NoNewline -ForegroundColor White; Write-Host " Re-run setup wizard"
Write-Host "  alfred --help  " -NoNewline -ForegroundColor White; Write-Host " Show all commands"
Write-Host ""
