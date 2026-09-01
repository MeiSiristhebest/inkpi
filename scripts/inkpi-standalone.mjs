#!/usr/bin/env node
/**
 * InkPi Universal Standalone CLI & Headless Server Daemon
 *
 * 独立运行入口，可编译为单文件二进制。支持以下模式：
 *   (无参数)            -> 终端工作台 (TerminalStudio)
 *   --print             -> 一次性生成模式 (runPrintMode)
 *   install/remove/list -> 包管理器 CLI (runPackageManagerCli)
 *   --server / daemon   -> 无头常驻守护进程 (InkPiDaemon)
 *                            TCP      <port>    供 TUI / Node 客户端接入
 *                            WebSocket <port+1> 供 Web 客户端接入
 */

import { runPrintMode } from '../packages/agent-core/dist/modes/print-mode.js';
import { TerminalStudio } from '../packages/agent-core/dist/tui/studio.js';
import { runPackageManagerCli } from '../packages/agent-core/dist/package-manager-cli.js';
import { InkRpcServer } from '../packages/agent-core/dist/rpc/server.js';
import { InkPiDaemon } from '../packages/agent-core/dist/rpc/daemon.js';

const args = process.argv.slice(2);

function readRequiredArg(index, name) {
  const value = args[index + 1];
  if (index === -1 || !value || value.startsWith('-')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

const providerEnv = {
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY'
};

async function main() {
  if (args.includes('--server') || args.includes('-s') || args[0] === 'daemon' || args.includes('daemon')) {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8848;
    const wsPortIdx = args.indexOf('--ws-port');
    const wsPort = wsPortIdx !== -1 ? parseInt(args[wsPortIdx + 1], 10) : port + 1;

    const daemon = new InkPiDaemon({ port, host: '127.0.0.1' });
    await daemon.start(port, '127.0.0.1');
    await daemon.startWebSocket(wsPort, '127.0.0.1');

    console.log(`🚀 [InkPi Daemon] Headless JSON-RPC 2.0 core is running:`);
    console.log(`   • TCP       : tcp://127.0.0.1:${port}  (TUI / Node clients)`);
    console.log(`   • WebSocket : ws://127.0.0.1:${wsPort}  (Web clients)`);
    console.log(`📡 Ready to accept connections. Press Ctrl+C to stop.\n`);

    const shutdown = async () => {
      console.log('\n👋 Shutting down InkPi Daemon...');
      try {
        await daemon.stop();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else if (args.includes('--print') || args.includes('-p')) {
    const promptIdx = args.indexOf('--prompt');
    const prompt = readRequiredArg(promptIdx, '--print/--prompt');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 ? readRequiredArg(modelIdx, '--model') : undefined;
    const roleIdx = args.indexOf('--role');
    const role = roleIdx !== -1 ? readRequiredArg(roleIdx, '--role') : undefined;
    const apiKeyIdx = args.indexOf('--api-key');
    const providerIdx = args.indexOf('--provider');
    const provider = providerIdx !== -1 ? readRequiredArg(providerIdx, '--provider') : undefined;
    if (apiKeyIdx !== -1) {
      if (!provider) throw new Error('--api-key requires an explicit --provider.');
      const envName = providerEnv[provider];
      if (!envName) throw new Error(`No credential environment mapping is registered for provider '${provider}'. Pass credentials through model configuration.`);
      process.env[envName] = readRequiredArg(apiKeyIdx, '--api-key');
    }
    if (!model && !provider) throw new Error('--print requires an explicit --model or --provider with model environment configuration.');
    const result = await runPrintMode({
      prompt,
      model,
      role,
      provider,
      json: args.includes('--json')
    });
    if (!result.success) process.exitCode = 1;
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
