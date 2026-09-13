#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { runPrintMode } from '../packages/cli/dist/index.js';
import {
  runPhase18AcceptanceFromEnvironment,
  sanitizePhase18Report
} from '../packages/evals/dist/index.js';

const report = await runPhase18AcceptanceFromEnvironment({
  runProvider: async ({ config, prompt }) => {
    const result = await runPrintMode({
      prompt,
      modelConfig: {
        id: config.model,
        name: config.model,
        provider: config.runtimeProvider,
        apiKey: config.apiKey,
        maxTokens: 256,
        temperature: 0
      },
      quiet: true
    });
    return {
      success: result.success,
      content: result.content,
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: 'provider execution failed' } : {})
    };
  }
});

const safeReport = sanitizePhase18Report(report);
const serialized = `${JSON.stringify(safeReport, null, 2)}\n`;
const reportFile = process.env.INKPI_PHASE18_REPORT_FILE?.trim();
if (reportFile) writeFileSync(reportFile, serialized, 'utf8');
process.stdout.write(serialized);
if (!safeReport.passed) process.exitCode = 2;
