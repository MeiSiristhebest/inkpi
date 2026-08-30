#!/usr/bin/env node
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
    console.log(`🚀 [InkPi Server Daemon] Listening on tcp://127.0.0.1:${port}`);
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
