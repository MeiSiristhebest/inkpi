#!/usr/bin/env node

/**
 * 模型目录完整性校验脚本 (1:1 对标 pi-ai check-model-data.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, '..');

const jsonPath = path.join(packageRoot, 'src', 'models-data.json');
const tsPath = path.join(packageRoot, 'src', 'models.generated.ts');

if (!fs.existsSync(jsonPath)) {
  console.error(`❌ models-data.json missing at: ${jsonPath}`);
  process.exit(1);
}

if (!fs.existsSync(tsPath)) {
  console.error(`❌ models.generated.ts missing at: ${tsPath}`);
  process.exit(1);
}

try {
  const models = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(models) || models.length === 0) {
    console.error('❌ models-data.json must be a non-empty array');
    process.exit(1);
  }

  for (const m of models) {
    if (!m.id || !m.name || !m.provider || typeof m.contextWindow !== 'number') {
      console.error(`❌ Malformed model metadata entry: ${JSON.stringify(m)}`);
      process.exit(1);
    }
  }

  console.log(`✅ Model data check passed: ${models.length} valid models verified.`);
} catch (err) {
  console.error('❌ Failed to parse models-data.json:', err);
  process.exit(1);
}
