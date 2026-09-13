#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { runPrintMode } from '../../cli/dist/index.js';
import {
  PHASE18_REPORT_FILE_ENV,
  runPhase18AcceptanceFromEnvironment,
  sanitizePhase18Report
} from '../dist/phase18-acceptance.js';

async function runRealProvider({ config, prompt }) {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    const result = await runPrintMode({
      prompt,
      modelConfig: {
        id: config.model,
        name: config.model,
        provider: config.runtimeProvider,
        apiKey: config.apiKey,
        maxTokens: 256,
        temperature: 0
      }
    });
    return {
      success: result.success,
      content: result.content,
      durationMs: result.durationMs,
      usage: result.usage,
      error: result.error
    };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

const report = sanitizePhase18Report(
  await runPhase18AcceptanceFromEnvironment({
    runProvider: runRealProvider
  })
);
const reportFile = process.env[PHASE18_REPORT_FILE_ENV]?.trim();
if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 2;
