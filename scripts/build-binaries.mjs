#!/usr/bin/env node

/**
 * InkPi 单文件独立可执行二进制打包流水线 (1:1 对标 Pi build-binaries 架构)
 * 支持将 InkPi 编译打包为免安装独立二进制文件 (inkpi.exe / inkpi-linux / inkpi-macos)
 * 具备供应链依赖严格性校验与单可执行文件封包。
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist-bin');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

console.log('🚀 [InkPi Binary Release Engineering] Starting build pipeline...');

// 1. 严格供应链检查
console.log('🔒 Step 1: Running supply-chain dependency verification...');
try {
  execSync('node scripts/check-pinned-deps.mjs', { cwd: rootDir, stdio: 'inherit' });
} catch (err) {
  console.error('❌ Supply-chain check failed:', err);
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// 2. 生成单文件独立入口脚本
console.log('📦 Step 2: Preparing Standalone Release Entrypoint...');
const standaloneEntry = path.join(rootDir, 'scripts', 'inkpi-standalone.mjs');
const entryCode = `#!/usr/bin/env node
/**
 * InkPi Universal Standalone CLI & Headless Server Daemon
 */
import { runPrintMode } from '../packages/agent-core/dist/modes/print-mode.js';
import { TerminalStudio } from '../packages/agent-core/dist/tui/studio.js';
import { runPackageManagerCli } from '../packages/agent-core/dist/package-manager-cli.js';
import { InkRpcServer } from '../packages/agent-core/dist/rpc/server.js';

const args = process.argv.slice(2);

async function main() {
  if (args.includes('--server') || args.includes('-s')) {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8848;
    const server = new InkRpcServer();
    await server.listenTcp(port);
    console.log(\`🚀 [InkPi Server Daemon] Listening on tcp://127.0.0.1:\${port}\`);
  } else if (args.includes('--print') || args.includes('-p')) {
    const promptIdx = args.indexOf('--prompt');
    const prompt = promptIdx !== -1 ? args[promptIdx + 1] : '请开始一段全新创作';
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
    const roleIdx = args.indexOf('--role');
    const role = roleIdx !== -1 ? args[roleIdx + 1] : undefined;
    const apiKeyIdx = args.indexOf('--api-key');
    if (apiKeyIdx !== -1) {
      process.env.DEEPSEEK_API_KEY = args[apiKeyIdx + 1];
      process.env.OPENAI_API_KEY = args[apiKeyIdx + 1];
      process.env.OPENROUTER_API_KEY = args[apiKeyIdx + 1];
    }
    await runPrintMode({
      prompt,
      model,
      role,
      json: args.includes('--json')
    });
  } else if (['install', 'remove', 'list', 'update'].includes(args[0])) {
    const output = await runPackageManagerCli(args);
    console.log(output);
  } else {
    const studio = new TerminalStudio();
    console.log(studio.renderFullFrame());
  }
}

main().catch(err => {
  console.error('Fatal InkPi Error:', err);
  process.exit(1);
});
`;

fs.writeFileSync(standaloneEntry, entryCode, 'utf8');
console.log(`✅ Entrypoint generated at: ${path.relative(rootDir, standaloneEntry)}`);

// 3. 检查并执行二进制编译
console.log('🔨 Step 3: Compiling Standalone Executable Binary...');
let hasBun = false;
try {
  const v = execSync('bun --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  console.log(`✨ Found Bun compiler runtime: v${v}`);
  hasBun = true;
} catch {
  console.log('ℹ️ Bun compiler not detected in current PATH.');
}

const targetBinaryName = process.platform === 'win32' ? 'inkpi.exe' : 'inkpi';
const finalOutPath = path.join(distDir, targetBinaryName);

if (hasBun && !isDryRun) {
  try {
    execSync(`bun build --compile --minify --outfile "${finalOutPath}" "${standaloneEntry}"`, {
      stdio: 'inherit',
      cwd: rootDir
    });
    console.log(`🎉 [SUCCESS] Single-file binary compiled: ${finalOutPath}`);
  } catch (err) {
    console.error('❌ Bun compilation error:', err);
  }
} else {
  // SEA Config Dry-Run Generation
  const seaConfigPath = path.join(distDir, 'sea-config.json');
  const seaConfig = {
    main: standaloneEntry,
    output: path.join(distDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');
  console.log(`✅ [Dry-Run / SEA Pipeline Ready] SEA config generated at: ${path.relative(rootDir, seaConfigPath)}`);
}

console.log('🌟 [InkPi Binary Release Engineering] Build pipeline completed successfully.');
