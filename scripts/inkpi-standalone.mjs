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

import { runPrintMode } from '../packages/cli/dist/index.js';
import { TerminalStudio } from '../packages/tui/dist/studio.js';
import { runPackageManagerCli } from '../packages/cli/dist/index.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InkRpcServer } from '../packages/server/dist/server.js';
import { InkPiDaemon } from '../packages/server/dist/daemon.js';
import { createDaemonPersistence } from '../packages/server/dist/daemon-persistence.js';
import { createJsonlObservationSink } from '../packages/server/dist/observation-sink.js';
import { readObservabilitySampleRate } from '../packages/server/dist/observability-config.js';
import { getModelPreset } from '../packages/ai/dist/presets.js';
import { findModelInCatalog, modelCatalogEntryToCapabilityDeclaration } from '../packages/ai/dist/catalog.js';
// The standalone harness is the dev/test entrypoint exercised by the integration
// suite (e.g. `--model mock-test`). Mock providers are NOT silently registered on
// the production path; we opt into them explicitly here so headless tests can run
// without real API keys. Real models are unaffected.
const args = process.argv.slice(2);
const explicitModelIndex = args.indexOf('--model');
const explicitModel = explicitModelIndex === -1 ? undefined : args[explicitModelIndex + 1];
if (explicitModel === 'mock-test') {
  const { installTestDoubles } = await import('../packages/ai/dist/test-fixtures.js');
  installTestDoubles();
}

function readRequiredArg(index, name) {
  const value = args[index + 1];
  if (index === -1 || !value || value.startsWith('-')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

/**
 * Resolve a direct model configuration for packaged/headless daemon runs.
 * Presets remain the default path, while an explicit provider + model pair
 * lets an OpenAI-compatible endpoint be injected through the process
 * environment without persisting credentials in Desktop settings.
 */
function resolveEnvironmentDaemonModel() {
  const provider = process.env.INKPI_PROVIDER?.trim().toLowerCase();
  const id = process.env.INKPI_MODEL?.trim();
  if (!provider && !id) return undefined;
  if (!provider || !id) {
    throw new Error('INKPI_PROVIDER and INKPI_MODEL must be configured together.');
  }

  // Unknown OpenAI-compatible models are conservative about tool support.
  // The daemon still advertises text/structured output through its legacy
  // capability fallback, but it will not send an unverified tool schema to a
  // gateway that may implement only chat completions.
  const model = { id, name: id, provider, supportsTools: false };
  const baseUrl = process.env[`INKPI_${provider.toUpperCase()}_BASE_URL`]?.trim();
  if (baseUrl) model.baseUrl = baseUrl;
  return model;
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
    const stateDbFlag = ['--state-db', '--db-path'].find((flag) => args.includes(flag));
    const stateDbPath = stateDbFlag
      ? readRequiredArg(args.indexOf(stateDbFlag), stateDbFlag)
      : undefined;

    const modelIdx = args.indexOf('--model');
    const modelPreset = modelIdx !== -1 ? readRequiredArg(modelIdx, '--model') : process.env.INKPI_MODEL_PRESET || 'creative-pro';
    let defaultModel;
    if (modelIdx === -1) {
      defaultModel = resolveEnvironmentDaemonModel();
    }
    if (!defaultModel) {
      try {
        defaultModel = getModelPreset(modelPreset);
      } catch {
        defaultModel = undefined;
      }
    }
    const defaultModelCapabilities = defaultModel
      ? (() => {
          const catalogEntry = findModelInCatalog(defaultModel.id);
          return catalogEntry ? modelCatalogEntryToCapabilityDeclaration(catalogEntry) : undefined;
        })()
      : undefined;
    const persistence = createDaemonPersistence({ dbPath: stateDbPath });
    const observationFile = process.env.INKPI_OBSERVABILITY_FILE?.trim();
    const observationSampleRate = readObservabilitySampleRate();
    let daemon;
    try {
      daemon = new InkPiDaemon({
        port,
        host: '127.0.0.1',
        defaultModel,
        ...(defaultModelCapabilities ? { defaultModelCapabilities } : {}),
        skillSearchDirs: resolveSkillSearchDirs(),
        context: persistence.context,
        ...(persistence.cachePersistence ? { cachePersistence: persistence.cachePersistence } : {}),
        ...(observationFile || observationSampleRate !== undefined
          ? {
              observability: {
                ...(observationSampleRate !== undefined ? { sampleRate: observationSampleRate } : {}),
                ...(observationFile ? { onObservation: createJsonlObservationSink(observationFile) } : {})
              }
            }
          : {})
      });
      await daemon.start(port, '127.0.0.1');
      await daemon.startWebSocket(wsPort, '127.0.0.1');
    } catch (error) {
      try {
        await daemon?.stop();
      } finally {
        persistence.close();
      }
      throw error;
    }

    console.log(`🚀 [InkPi Daemon] Headless JSON-RPC 2.0 core is running:`);
    console.log(`   • TCP       : tcp://127.0.0.1:${port}  (TUI / Node clients)`);
    console.log(`   • WebSocket : ws://127.0.0.1:${wsPort}  (Web clients)`);
    console.log(`📡 Ready to accept connections. Press Ctrl+C to stop.\n`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n👋 Shutting down InkPi Daemon...');
      try {
        await daemon.stop();
      } finally {
        persistence.close();
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

function resolveSkillSearchDirs() {
  const candidates = [
    process.env.INKPI_SKILLS_DIR,
    join(process.cwd(), 'skills'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'skills'),
    join(dirname(process.execPath), 'skills')
  ];
  return [...new Set(candidates.filter((candidate) => candidate && existsSync(candidate)))];
}

main().catch(err => {
  console.error('Fatal InkPi Error:', err);
  process.exit(1);
});
