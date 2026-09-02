#!/usr/bin/env node
/**
 * 🖋️ InkPi CLI - The Extensible AI Agent Creative Harness & Workstation Platform
 * Copyright (c) 2026 InkPi Contributors. Licensed under MIT.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as readline from 'node:readline';

const VERSION = '1.0.0';

const HELP_TEXT = `
🖋️ InkPi CLI - The Extensible AI Agent Harness & Workstation (v${VERSION})

USAGE:
  inkpi [command] [options]
  npx @inkpi/creative-agent [command]

COMMANDS:
  studio, write [path]      Launch the interactive terminal workstation (TUI)
  daemon, server            Start the headless JSON-RPC 2.0 background daemon
  init [name]               Initialize a new InkPi project workspace
  print, -p <prompt>        Run headless non-interactive generation
  doctor                    Diagnose local runtime, SQLite driver & model configurations
  plugin <list|add|remove>  Manage extension plugins
  version, -v, --version    Show current version
  help, -h, --help          Show this help message

OPTIONS:
  -p, --prompt <text>       Prompt for non-interactive generation
  -m, --model <id>          Model identifier (e.g. deepseek-chat, gpt-4o, claude-3-5-sonnet)
  --port <number>           TCP port for daemon server (default: 8848)
  --ws-port <number>        WebSocket port for daemon server (default: TCP port + 1)
  --role <role>             Agent role preset for pipeline
  --json                    Output structured JSON responses
  --chinese                 Enable typography formatting (\u3000\u3000 full-width indents)

EXAMPLES:
  $ inkpi                   # Launch interactive TUI Studio
  $ inkpi init my-workspace # Initialize new project workspace
  $ inkpi daemon --port 8848 # Start headless JSON-RPC daemon
  $ inkpi -p "Analyze architectural invariants for state machine"
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'studio';

  if (args.includes('-v') || args.includes('--version') || command === 'version') {
    console.log(`InkPi v${VERSION}`);
    return;
  }

  if (args.includes('-h') || args.includes('--help') || command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  switch (command) {
    case 'init': {
      const projectName = args[1] || 'inkpi-workspace';
      const targetDir = resolve(process.cwd(), projectName);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      mkdirSync(join(targetDir, 'docs'), { recursive: true });
      mkdirSync(join(targetDir, 'codex'), { recursive: true });
      mkdirSync(join(targetDir, 'sessions'), { recursive: true });

      const config = {
        name: projectName,
        version: '1.0.0',
        typography: { mode: 'chinese', indentString: '\u3000\u3000' },
        defaultModel: 'deepseek-chat',
        plugins: []
      };
      writeFileSync(join(targetDir, 'inkpi.config.json'), JSON.stringify(config, null, 2), 'utf8');
      writeFileSync(
        join(targetDir, 'docs', '001_intro.md'),
        `# Introduction\n\n\u3000\u3000InkPi Agent Workstation Workspace Initialized.\n`,
        'utf8'
      );
      console.log(`\n✨ Successfully initialized InkPi workspace in: ${targetDir}`);
      console.log(`📁 Directories created: docs/, codex/, sessions/`);
      console.log(`🚀 Run 'cd ${projectName} && inkpi' to start!\n`);
      break;
    }

    case 'doctor': {
      console.log(`\n🔍 InkPi System & Environment Diagnostics (v${VERSION})\n`);
      console.log(`  • Node.js Version: ${process.version} (>= 22.0.0 recommended)`);
      console.log(`  • Platform:        ${process.platform} (${process.arch})`);

      try {
        const sqlite = await import('node:sqlite');
        console.log(`  • SQLite Engine:   node:sqlite native built-in detected ✅`);
      } catch {
        console.log(`  • SQLite Engine:   Fallback / third-party driver`);
      }

      const keys = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
      console.log(`\n🔑 Model API Key Status:`);
      for (const k of keys) {
        const set = !!process.env[k];
        console.log(`  • ${k.padEnd(22)}: ${set ? 'Configured ✅' : 'Not set (Optional)'}`);
      }
      console.log(`\n✨ Environment check complete.\n`);
      break;
    }

    case 'daemon':
    case 'server': {
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8848;
      const wsPortIdx = args.indexOf('--ws-port');
      const wsPort = wsPortIdx !== -1 ? parseInt(args[wsPortIdx + 1], 10) : port + 1;

      const { InkPiDaemon } = await import('@inkpi/server');
      const daemon = new InkPiDaemon({ port, host: '127.0.0.1' });
      await daemon.start(port, '127.0.0.1');
      await daemon.startWebSocket(wsPort, '127.0.0.1');

      console.log(`\n🚀 [InkPi Daemon] Headless JSON-RPC 2.0 core is running:`);
      console.log(`   • TCP       : tcp://127.0.0.1:${port}  (TUI / VS Code / Node clients)`);
      console.log(`   • WebSocket : ws://127.0.0.1:${wsPort}  (Web / Desktop GUI clients)`);
      console.log(`📡 Ready to accept connections from Web / VS Code / TUI clients. Press Ctrl+C to stop.\n`);

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
      break;
    }

    case 'print':
    case '-p': {
      const promptIdx = args.indexOf('-p') !== -1 ? args.indexOf('-p') : args.indexOf('--prompt');
      const prompt = promptIdx !== -1 ? args[promptIdx + 1] : args[1];
      if (!prompt) {
        console.error('Error: -p / --prompt requires text argument.');
        process.exit(1);
      }
      const modelIdx = args.indexOf('--model');
      const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

      const { runPrintMode } = await import('@inkpi/agent-core');
      const result = await runPrintMode({
        prompt,
        model,
        json: args.includes('--json')
      });
      if (!result.success) process.exitCode = 1;
      break;
    }

    case 'plugin': {
      const sub = args[1] || 'list';
      const { runPackageManagerCli } = await import('@inkpi/agent-core');
      const output = await runPackageManagerCli(args.slice(1));
      console.log(output);
      break;
    }

    case 'studio':
    case 'write':
    default: {
      await startInteractiveStudio(args);
      break;
    }
  }
}

async function startInteractiveStudio(args) {
  const { TerminalStudio } = await import('@inkpi/tui');
  const { ANSI } = await import('@inkpi/tui');

  const studio = new TerminalStudio({
    typography: { mode: 'chinese', indentString: '\u3000\u3000' }
  });

  const chapterArg = args[0] === 'write' ? args[1] : undefined;
  if (chapterArg && existsSync(chapterArg)) {
    const text = readFileSync(chapterArg, 'utf8');
    studio.editor.insertText(0, text);
  }

  // Clear screen and render initial studio frame
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(studio.renderFullFrame());
  console.log(`${ANSI.DIM}Type text to insert, :focus <editor|outline|copilot|ledger>, /help for commands, :quit to exit${ANSI.RESET}`);

  // Setup interactive input loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${ANSI.FG_CYAN}inkpi> ${ANSI.RESET}`
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed === ':quit' || trimmed === ':q' || trimmed === 'exit') {
      console.log('\n👋 Exiting InkPi Studio. Your creative state is saved.\n');
      process.exit(0);
    }

    if (trimmed) {
      await studio.handleInput(trimmed);
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(studio.renderFullFrame());
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 InkPi Studio closed.\n');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('\n❌ Fatal InkPi CLI Error:', err);
  process.exit(1);
});
