#!/bin/sh
set -e

# 🖋️ InkPi Multi-Platform One-Line Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MeiSiristhebest/inkpi/master/scripts/install.sh | sh

echo "🖋️  Installing InkPi Creative Workstation CLI..."

# Check if Node.js is installed
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js (>= 22.0.0) is required to run InkPi."
    echo "   Please install Node.js from https://nodejs.org/ or via your package manager."
    exit 1
fi

# Prefer pnpm, fallback to npm
if command -v pnpm >/dev/null 2>&1; then
    echo "📦 Installing @inkpi/creative-agent globally via pnpm..."
    pnpm add -g --ignore-scripts @inkpi/creative-agent
elif command -v npm >/dev/null 2>&1; then
    echo "📦 Installing @inkpi/creative-agent globally via npm..."
    npm install -g --ignore-scripts @inkpi/creative-agent
elif command -v bun >/dev/null 2>&1; then
    echo "📦 Installing @inkpi/creative-agent globally via bun..."
    bun install -g @inkpi/creative-agent
else
    echo "❌ Neither pnpm, npm, nor bun found in PATH."
    exit 1
fi

echo ""
echo "✨ InkPi has been successfully installed!"
echo "🚀 Run 'inkpi' to launch the interactive creative studio."
echo "📖 Run 'inkpi --help' to view all commands."
