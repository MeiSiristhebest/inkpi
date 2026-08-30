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
const entrypointPath = path.join(rootDir, 'scripts', 'standalone-entry.mjs');
const entryCode = `#!/usr/bin/env node
import { runPrintMode } from '../packages/agent-core/dist/modes/print-mode.js';
import { TerminalStudio } from '../packages/agent-core/dist/tui/studio.js';
import { runPackageManagerCli } from '../packages/agent-core/dist/package-manager-cli.js';

const args = process.argv.slice(2);

if (args.includes('--print') || args.includes('-p')) {
  const promptIdx = args.indexOf('--prompt');
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : '请创作一段情节';
  await runPrintMode({ prompt, json: args.includes('--json') });
} else if (['install', 'remove', 'list', 'update'].includes(args[0])) {
  const output = await runPackageManagerCli(args);
  console.log(output);
} else {
  const studio = new TerminalStudio();
  console.log(studio.renderFullFrame());
}
`;

fs.writeFileSync(entrypointPath, entryCode, 'utf8');

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
  console.log(`ℹ️ [InkPi Bundler] Standalone entrypoint generated at: ${entrypointPath}`);
}
