#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { runPrintMode } from '../packages/cli/dist/index.js';
import {
  evaluateRealProviderResult,
  readRealProviderAcceptancePlan,
  reportSkippedOrInvalid
} from '../packages/evals/dist/real-provider-acceptance.js';

const plan = readRealProviderAcceptancePlan();
const reportFile = process.env.INKPI_ACCEPTANCE_REPORT_FILE?.trim();
let report;

if (plan.status !== 'ready') {
  report = reportSkippedOrInvalid(plan);
} else {
  const { config } = plan;
  const result = await runPrintMode({
    prompt: config.prompt,
    modelConfig: {
      id: config.model,
      name: config.model,
      provider: config.runtimeProvider,
      apiKey: config.apiKey,
      maxTokens: 64,
      temperature: 0
    },
    quiet: true
  });
  report = evaluateRealProviderResult(config, result);
}

if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 2;
