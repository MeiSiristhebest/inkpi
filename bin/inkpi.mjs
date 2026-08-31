#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const BANNER = `
╔═══════════════════════════════════════════════════════════════╗
║   ___       _    ____  _                                      ║
║  |_ _|_ __ | | _|  _ \(_)                                     ║
║   | || '_ \| |/ / |_) | |                                     ║
║   | || | | |   <|  __/| |                                     ║
║  |___|_| |_|_|\_\_|   |_|                                     ║
║                                                               ║
║  Extensible AI Agent Creative Harness & Workstation Platform  ║
║  Inspired by Pi Architecture (10 Monorepo Packages)          ║
╚═══════════════════════════════════════════════════════════════╝
`;

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command) {
    case 'dev':
    case 'start': {
      console.log(BANNER);
      console.log('🚀 Launching InkPi Interactive Creative Studio...\n');
      const { InkPiStudio } = await import('../packages/agent-core/dist/tui/studio.js');
      const studio = new InkPiStudio();
      studio.start();
      break;
    }

    case 'daemon': {
      console.log(BANNER);
      const port = Number(args[1]) || 9876;
      console.log(`🔌 Starting InkPi Headless Daemon on 127.0.0.1:${port}...`);
      const { InkPiDaemon } = await import('../packages/server/dist/daemon.js');
      const daemon = new InkPiDaemon({ port });
      await daemon.start();
      console.log(`✅ InkPi Daemon is running on port ${port}. Press Ctrl+C to stop.`);
      break;
    }

    case 'mcp': {
      // Execute MCP stdio server
      await import('./inkpi-mcp.mjs');
      break;
    }

    case 'doctor': {
      console.log(BANNER);
      console.log('🩺 Running InkPi Environment & System Diagnostics...\n');
      console.log(`  • Node.js Version: ${process.version}`);
      console.log(`  • Platform / OS:   ${process.platform} (${process.arch})`);
      console.log(`  • Packages Root:   ${rootDir}`);

      const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
      console.log(`  • Version:         ${pkgJson.version}`);

      const pkgs = fs.readdirSync(path.join(rootDir, 'packages'));
      console.log(`  • Monorepo Subpackages (${pkgs.length}):`);
      for (const p of pkgs) {
        console.log(`    - @inkpi/${p}`);
      }
      console.log('\n✅ InkPi Environment is healthy and fully configured.');
      break;
    }

    case 'eval': {
      console.log(BANNER);
      console.log('📊 Running Narrative Consistency & Benchmark Suite...\n');
      const { NovelConsistencyBenchmark } = await import('../packages/evals/dist/benchmarks/narrative-consistency.js');
      const bench = new NovelConsistencyBenchmark();
      const report = await bench.run();
      console.log(`  • Consistency Score: ${report.consistencyScore.toFixed(2)}/100`);
      console.log(`  • Invariants Checked: ${report.invariantsChecked}`);
      console.log(`  • Status:             ${report.status.toUpperCase()}`);
      break;
    }

    case 'version':
    case '-v':
    case '--version': {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
      console.log(`inkpi v${pkgJson.version}`);
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default: {
      console.log(BANNER);
      console.log(`
Usage: inkpi <command> [options]

Commands:
  dev               Launch interactive TUI creative studio & editor
  daemon [port]     Start headless JSON-RPC 2.0 background daemon (default: 9876)
  mcp               Start stdio Model Context Protocol server for AI coding agents
  eval              Run evaluation & narrative benchmark suites
  doctor            Run diagnostic healthcheck on environment & packages
  version           Show InkPi version

Options:
  --help, -h        Show this help screen
  --version, -v     Show version number

Examples:
  $ npx inkpi dev
  $ npx inkpi daemon 9876
  $ npx inkpi mcp
  $ npx inkpi doctor
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error('❌ Error executing command:', err);
  process.exit(1);
});
