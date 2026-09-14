#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 23 is an evidence gate, not a test-count gate.  Keep the required
 * groups in one machine-readable place so a local fixture run cannot be
 * mistaken for a production freeze.
 */
export const FINAL_FREEZE_GROUPS = Object.freeze([
  ['semantic-content', 'Canonical content and source maps'],
  ['story-model', 'Canonical StoryState and provenance'],
  ['vertical-slices', 'Five Desktop to Daemon vertical slices'],
  ['projection-sync', 'Domain projection and cross-device sync'],
  ['proposal-cas', 'Proposal, CAS commit, and undo'],
  ['durable-execution', 'Crash recovery and durable execution'],
  ['context-pipeline', 'Context registration, budget, and fingerprint'],
  ['skills', 'First-party skill lazy loading and activation'],
  ['artifacts', 'Artifact store, lineage, and ownership'],
  ['cache', 'Three-layer cache and invalidation metrics'],
  ['capability-routing', 'Capability-aware provider routing'],
  ['instruction-registry', 'Desktop and Daemon instruction registry'],
  ['evals', 'Objective, subjective, mutation, and long-context evals'],
  ['observability', 'Observability, sampling, and privacy boundary'],
  ['plugins-legacy', '44-plugin migration and legacy cleanup'],
  ['reliability', 'Offline, failure, and unavailable-model drills']
].map(([id, label]) => Object.freeze({ id, label })));

const VALID_STATUSES = new Set(['passed', 'failed', 'missing']);
const VALID_LOCAL_STATUSES = new Set(['passed', 'partial', 'failed', 'missing']);

/**
 * Evaluate a deliberately small evidence envelope.  The evaluator does not
 * inspect or print evidence payloads; it only records their presence and
 * declared status.  A group cannot be waived, and an absent envelope never
 * passes.  The actual evidence producers remain responsible for proving their
 * claims (tests, reports, package runs, or human-labelled data).
 */
export function evaluateFreezeEvidence(input) {
  const source = isRecord(input) && isRecord(input.evidence) ? input.evidence : {};
  const localSource = isRecord(input) && isRecord(input.localEvidence) ? input.localEvidence : {};
  const groups = FINAL_FREEZE_GROUPS.map(({ id, label }) => {
    const entry = isRecord(source[id]) ? source[id] : undefined;
    const localEntry = isRecord(localSource[id]) ? localSource[id] : undefined;
    const rawStatus = entry?.status;
    const status = typeof rawStatus === 'string' && VALID_STATUSES.has(rawStatus) ? rawStatus : 'missing';
    const hasSource = typeof entry?.source === 'string' && entry.source.trim().length > 0;
    const recordedAt = typeof entry?.recordedAt === 'string' && Number.isFinite(Date.parse(entry.recordedAt))
      ? entry.recordedAt
      : undefined;
    const validPassedRecord = status !== 'passed' || (hasSource && recordedAt !== undefined);
    const rawLocalStatus = localEntry?.status;
    const localStatus =
      typeof rawLocalStatus === 'string' && VALID_LOCAL_STATUSES.has(rawLocalStatus)
        ? rawLocalStatus
        : 'missing';
    const localHasSource =
      typeof localEntry?.source === 'string' && localEntry.source.trim().length > 0;
    const localRecordedAt =
      typeof localEntry?.recordedAt === 'string' && Number.isFinite(Date.parse(localEntry.recordedAt))
        ? localEntry.recordedAt
        : undefined;
    const validLocalRecord =
      localStatus === 'missing' || (localHasSource && localRecordedAt !== undefined);
    return {
      id,
      label,
      status: validPassedRecord ? status : 'missing',
      hasSource,
      recordedAt,
      localStatus: validLocalRecord ? localStatus : 'missing',
      localHasSource,
      localRecordedAt
    };
  });

  const missing = groups.filter((group) => group.status === 'missing').map((group) => group.id);
  const failed = groups.filter((group) => group.status === 'failed').map((group) => group.id);
  const eligible = missing.length === 0 && failed.length === 0;

  return {
    schemaVersion: 1,
    status: eligible ? 'passed' : 'pending',
    eligible,
    requiredGroupCount: FINAL_FREEZE_GROUPS.length,
    passedGroupCount: groups.filter((group) => group.status === 'passed').length,
    localEvidenceGroupCount: groups.filter(
      (group) => group.localStatus === 'passed' || group.localStatus === 'partial'
    ).length,
    localPartialGroupCount: groups.filter((group) => group.localStatus === 'partial').length,
    localFailed: groups.filter((group) => group.localStatus === 'failed').map((group) => group.id),
    localMissing: groups.filter((group) => group.localStatus === 'missing').map((group) => group.id),
    missing,
    failed,
    groups
  };
}

export function readFreezeEvidence(filePath) {
  if (!filePath || !filePath.trim()) return {};
  const normalizedPath = resolve(filePath);
  if (!existsSync(normalizedPath)) throw new Error('Evidence file does not exist.');
  const parsed = JSON.parse(readFileSync(normalizedPath, 'utf8'));
  if (!isRecord(parsed)) throw new Error('Evidence file must contain a JSON object.');
  return parsed;
}

/**
 * Run the deterministic local gate without upgrading it to formal freeze
 * evidence.  The selected tests are provider-free and exercise the source
 * matrix, Phase 22 reliability matrix, and Phase 18 fixture contract.
 */
export async function evaluateLocalFreeze() {
  const gate = await import('../packages/evals/src/phase23-local-gate.ts');
  let testsPassed = false;
  let testError;
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const testArgs = [
    'exec',
    'vitest',
    'run',
    'tests/phase23-local-freeze.test.ts',
    'tests/phase22-reliability-matrix.test.ts',
    '--reporter=dot'
  ];

  try {
    execFileSync(packageManager, testArgs, {
      cwd: resolve(fileURLToPath(new URL('../', import.meta.url))),
      env: { ...process.env, INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '0' },
      shell: process.platform === 'win32',
      stdio: 'inherit'
    });
    testsPassed = true;
  } catch (error) {
    testError = error instanceof Error ? error.message : 'local gate tests failed';
  }

  const report = gate.evaluatePhase23LocalGate(
    testsPassed
      ? {
          checks: gate.PHASE23_ATOMIC_CONDITIONS.map(({ id, sources }) => ({ id, status: 'passed', sources })),
          reliability: gate.PHASE22_RELIABILITY_SCENARIOS.map(({ id, sources }) => ({
            id,
            status: 'passed',
            sources
          }))
        }
      : {}
  );

  return {
    ...report,
    testRun: {
      command: `${packageManager} ${testArgs.join(' ')}`,
      passed: testsPassed,
      ...(testError ? { error: testError } : {})
    },
    formalFreeze: {
      eligible: false,
      reason: 'Deterministic local regression evidence never promotes to formal external freeze.'
    }
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(args) {
  const options = {
    evidenceFile: process.env.INKPI_FINAL_FREEZE_EVIDENCE_FILE?.trim() || '',
    outputFile: process.env.INKPI_FINAL_FREEZE_REPORT_FILE?.trim() || '',
    local: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--evidence') options.evidenceFile = args[++index] || '';
    else if (arg === '--output') options.outputFile = args[++index] || '';
    else if (arg === '--local') options.local = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        'Usage: node scripts/final-freeze-audit.mjs [--evidence report.json] [--output audit.json] [--local]'
      );
      return;
    }
    const report = options.local
      ? await evaluateLocalFreeze()
      : evaluateFreezeEvidence(readFreezeEvidence(options.evidenceFile));
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputFile) {
      const outputFile = resolve(options.outputFile);
      writeFileSync(outputFile, serialized, { encoding: 'utf8' });
    }
    process.stdout.write(serialized);
    process.exitCode = report.eligible ? 0 : 2;
  } catch (error) {
    console.error(`[final-freeze-audit] ${error instanceof Error ? error.message : 'invalid input'}`);
    process.exitCode = 2;
  }
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) void main();
