# ──────────────────────────────────────────────────────────────────────
#  Alfred — One-liner installer for Windows
#  irm https://raw.githubusercontent.com/yourusername/alfred/main/install.ps1 | iex
# ──────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/yourusername/alfred.git"
$InstallDir = if ($env:ALFRED_INSTALL_DIR) { $env:ALFRED_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".alfred" }
$Branch = if ($env:ALFRED_BRANCH) { $env:ALFRED_BRANCH } else { "main" }

function Write-OK($msg)   { Write-Host "  ✓ " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Info($msg)  { Write-Host "  → " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Write-Warn($msg)  { Write-Host "  ! " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Fail($msg)  { Write-Host "`n  ✗ $msg`n" -ForegroundColor Red; exit 1 }

# ── Banner ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "     _    _     _____ ____  _____ ____  " -ForegroundColor Magenta
Write-Host "    / \  | |   |  ___|  _ \| ____|  _ \ " -ForegroundColor Magenta
Write-Host "   / _ \ | |   | |_  | |_) |  _| | | | |" -ForegroundColor Magenta
Write-Host "  / ___ \| |___|  _| |  _ <| |___| |_| |" -ForegroundColor Magenta
Write-Host " /_/   \_\_____|_|   |_| \_\_____|____/ " -ForegroundColor Magenta
Write-Host ""
Write-Host "  Personal AI Assistant" -ForegroundColor DarkGray
Write-Host ""

# ── 1. Check Node.js ─────────────────────────────────────────────────
Write-Info "Checking Node.js..."

try {
    $nodeVersionRaw = & node --version 2>$null
} catch {
    $nodeVersionRaw = $null
}

if (-not $nodeVersionRaw) {
    Write-Fail "Node.js is not installed.`n`n  Install Node.js >= 20 from https://nodejs.org/`n  Or: winget install OpenJS.NodeJS.LTS"
}

$nodeVersion = $nodeVersionRaw -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])

if ($nodeMajor -lt 20) {
    Write-Fail "Node.js v$nodeVersion found, but >= 20 is required.`n  Upgrade at https://nodejs.org/"
}

Write-OK "Node.js v$nodeVersion"

# ── 2. Check git ─────────────────────────────────────────────────────
try {
    & git --version | Out-Null
} catch {
    Write-Fail "git is not installed.`n  Install: winget install Git.Git"
}

# ── 3. Check / install pnpm ──────────────────────────────────────────
Write-Info "Checking pnpm..."

$pnpmExists = $false
try {
    $pnpmVersion = & pnpm --version 2>$null
    if ($pnpmVersion) { $pnpmExists = $true }
} catch {}

if (-not $pnpmExists) {
    Write-Info "Installing pnpm..."
    try {
        & corepack enable 2>$null
        & corepack prepare pnpm@9.15.4 --activate 2>$null
        Write-OK "pnpm installed via corepack"
    } catch {
        try {
            & npm install -g pnpm@9.15.4
            Write-OK "pnpm installed via npm"
        } catch {
            Write-Fail "Could not install pnpm. Install manually: https://pnpm.io/installation"
        }
    }
} else {
    Write-OK "pnpm v$pnpmVersion"
}

# ── 4. Clone / update repo ───────────────────────────────────────────
Write-Host ""
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Info "Updating existing installation..."
    Push-Location $InstallDir
    try {
        & git pull --ff-only origin $Branch 2>$null
        if ($LASTEXITCODE -ne 0) { & git pull origin $Branch }
        Write-OK "Updated to latest version"
    } catch {
        Write-Warn "Could not update, continuing with existing version"
    }
} else {
    Write-Info "Installing Alfred to $InstallDir..."
    try {
        & git clone --depth 1 --branch $Branch $RepoUrl $InstallDir 2>$null
        if ($LASTEXITCODE -ne 0) {
            & git clone --depth 1 $RepoUrl $InstallDir
        }
    } catch {
        & git clone --depth 1 $RepoUrl $InstallDir
    }
    Push-Location $InstallDir
    Write-OK "Cloned repository"
}

# ── 5. Install dependencies ──────────────────────────────────────────
Write-Info "Installing dependencies..."
& pnpm install --ignore-scripts 2>$null
if ($LASTEXITCODE -ne 0) { & pnpm install --ignore-scripts }
Write-OK "Dependencies installed"

# ── 6. Build ─────────────────────────────────────────────────────────
Write-Info "Building..."
& pnpm run build 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    & pnpm run build
    if ($LASTEXITCODE -ne 0) { Write-Fail "Build failed." }
}
Write-OK "Build complete"

# ── 7. Create data directory ─────────────────────────────────────────
if (-not (Test-Path "data")) {
    New-Item -ItemType Directory -Path "data" -Force | Out-Null
}
if ((-not (Test-Path ".env")) -and (Test-Path ".env.example")) {
    Copy-Item ".env.example" ".env"
}

# ── 8. Add to PATH ───────────────────────────────────────────────────
$AlfredBin = Join-Path $InstallDir "packages\cli\dist\index.js"
$BinDir = Join-Path $env:USERPROFILE ".alfred\bin"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

# Create alfred.cmd wrapper
$cmdContent = "@echo off`r`nnode `"$AlfredBin`" %*"
Set-Content -Path (Join-Path $BinDir "alfred.cmd") -Value $cmdContent

# Create alfred.ps1 wrapper
$ps1Content = "& node `"$AlfredBin`" @args"
Set-Content -Path (Join-Path $BinDir "alfred.ps1") -Value $ps1Content

# Add to User PATH if not already there
$NeedRestart = $false
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$currentPath", "User")
    $env:Path = "$BinDir;$env:Path"
    $NeedRestart = $true
}

Write-OK "CLI installed"

# ── 9. Run setup wizard ──────────────────────────────────────────────
Write-Host ""
Write-Host "─────────────────────────────────────────" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $AlfredBin) {
    & node $AlfredBin setup
}

# ── Done ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ✓ Alfred installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  alfred start   " -NoNewline -ForegroundColor White; Write-Host "  Start Alfred"
Write-Host "  alfred setup   " -NoNewline -ForegroundColor White; Write-Host "  Re-run setup wizard"
Write-Host "  alfred status  " -NoNewline -ForegroundColor White; Write-Host "  Check configuration"
Write-Host "  alfred --help  " -NoNewline -ForegroundColor White; Write-Host "  Show all commands"
Write-Host ""

if ($NeedRestart) {
    Write-Host "  Restart your terminal for the 'alfred' command to be available." -ForegroundColor Yellow
    Write-Host ""
}

Pop-Location
