# 🖋️ InkPi Windows PowerShell One-Line Installer
# Usage: iwr https://raw.githubusercontent.com/MeiSiristhebest/inkpi/master/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "`n🖋️  Installing InkPi Creative Workstation CLI on Windows..." -ForegroundColor Cyan

# Check if Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js (>= 22.0.0) is required to run InkPi." -ForegroundColor Red
    Write-Host "   Please install Node.js from https://nodejs.org/ or via 'winget install OpenJS.NodeJS.LTS'" -ForegroundColor Yellow
    exit 1
}

# Check for package managers
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    Write-Host "📦 Installing @inkpi/cli globally via pnpm..." -ForegroundColor Green
    pnpm add -g --ignore-scripts @inkpi/cli
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "📦 Installing @inkpi/cli globally via npm..." -ForegroundColor Green
    npm install -g --ignore-scripts @inkpi/cli
} elseif (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Host "📦 Installing @inkpi/cli globally via bun..." -ForegroundColor Green
    bun install -g @inkpi/cli
} else {
    Write-Host "❌ Neither pnpm, npm, nor bun found in PATH." -ForegroundColor Red
    exit 1
}

Write-Host "`n✨ InkPi has been successfully installed!" -ForegroundColor Green
Write-Host "🚀 Run 'inkpi' to launch the interactive creative studio." -ForegroundColor Cyan
Write-Host "📖 Run 'inkpi --help' to view all commands.`n" -ForegroundColor Gray
