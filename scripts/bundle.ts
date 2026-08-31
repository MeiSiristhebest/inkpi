/**
 * InkPi Standalone Binary Bundler (1:1 对标 pi scripts/bundle.ts)
 * 使用 Bun 将 InkPi 全部子包内联并编译为单个独立可执行二进制文件 (无外部 Node.js 依赖)
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist-bin');

console.log('🚀 [InkPi Bundler] Starting Standalone Single-File Binary Compilation...');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// 1. Check if bun is installed
let hasBun = false;
try {
  const version = execSync('bun --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  console.log(`📦 Found Bun runtime: v${version}`);
  hasBun = true;
} catch {
  console.warn('⚠️ Bun is not detected in current environment path. Generating dry-run compilation artifacts...');
}

// 2. Create standalone CLI entrypoint for bundler
const entrypointPath = path.join(rootDir, 'scripts', 'inkpi-standalone.mjs');
if (!fs.existsSync(entrypointPath)) {
  throw new Error(`Standalone entrypoint is missing: ${entrypointPath}`);
}

if (hasBun) {
  const targetBin = process.platform === 'win32' ? 'inkpi.exe' : 'inkpi';
  const outPath = path.join(distDir, targetBin);
  console.log(`🔨 Building standalone binary with Bun: ${outPath}...`);
  try {
    execSync(`bun build --compile --minify --outfile "${outPath}" "${entrypointPath}"`, {
      stdio: 'inherit',
      cwd: rootDir
    });
    console.log(`✅ [InkPi Bundler] Standalone binary created successfully at: ${outPath}`);
  } catch (err) {
    console.error('❌ Failed to compile standalone binary with Bun:', err);
  }
} else {
  console.log(`ℹ️ [InkPi Bundler] Reviewed entrypoint selected at: ${entrypointPath}`);
}
