// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../scripts/phase18-23-evidence.mjs', import.meta.url));
const marker = 'INKPI_REAL_PROVIDER_ACCEPTANCE_OK';
const recordedAt = '2026-09-13T08:00:00.000Z';

function chapters(count: number, withContract = true) {
  return {
    id: `external-long-context-${count}`,
    mode: 'real-provider',
    chapterCount: count,
    chapters: Array.from({ length: count }, (_, index) => ({
      chapter: index + 1,
      text: `第${index + 1}章 private chapter body ${count}`
    })),
    ...(withContract
      ? {
          responseContract: {
            expectedRetrievedAnchors: [1, count],
            expectedRecoveredChapter: count - 1
          }
        }
      : {})
  };
}

function chapterInput() {
  return {
    id: 'phase18-generated-input',
    mode: 'real-provider',
    benchmarks: [chapters(100), chapters(300)]
  };
}

function provenance(annotationCount = 1) {
  return {
    source: 'human-labelled',
    datasetId: 'human-dataset-2026-09',
    version: 'v1',
    annotatorIds: ['annotator-1'],
    annotationCount,
    annotatedAt: recordedAt,
    adjudication: { status: 'not-required', reason: 'single annotator protocol' }
  };
}

function labels() {
  return {
    goldSet: {
      id: 'gold-set',
      cases: [
        {
          id: 'hook-1',
          kind: 'hook',
          candidate: { score: 92, rubricScores: { clarity: 92 } },
          gold: { threshold: 85, rubric: { id: 'hook-rubric', criteria: ['clarity'] } }
        }
      ],
      provenance: provenance(),
      annotations: [{ caseId: 'hook-1', annotatorId: 'annotator-1', label: 'accept', score: 92 }]
    },
    pairwise: {
      id: 'pairwise-set',
      requireExplicitObservedPreference: true,
      comparisons: [
        {
          id: 'comparison-1',
          left: 'candidate-a',
          right: 'candidate-b',
          expectedPreference: 'candidate-a',
          observedPreference: 'candidate-a'
        }
      ],
      provenance: provenance(),
      annotations: [{ comparisonId: 'comparison-1', annotatorId: 'annotator-1', preference: 'candidate-a' }]
    }
  };
}

function providerResults(includeKey = false) {
  return {
    mode: 'real-provider',
    provider: 'openai',
    model: 'external-model',
    ...(includeKey ? { apiKey: 'sk-test-secret-must-not-appear' } : {}),
    results: [100, 300].map((chapterCount) => ({
      chapterCount,
      runId: `provider-run-${chapterCount}`,
      observedAt: recordedAt,
      success: true,
      durationMs: 42,
      response: {
        marker,
        retrievedAnchors: [1, chapterCount],
        recoveredChapter: chapterCount - 1
      }
    }))
  };
}

function runtimeObservations() {
  return {
    source: 'runtime',
    benchmarks: [100, 300].map((chapterCount) => ({
      chapterCount,
      observations: {
        source: 'runtime',
        runId: `runtime-run-${chapterCount}`,
        retainedChapters: [1, chapterCount - 1, chapterCount],
        cacheLookups: [
          { key: `context-${chapterCount}`, hit: false },
          { key: `context-${chapterCount}`, hit: true }
        ],
        recovery: { attempted: true, recoveredChapter: chapterCount - 1 }
      }
    }))
  };
}

function metadata(withSignals = false) {
  return {
    runId: 'phase18-23-run',
    capturedAt: recordedAt,
    producer: 'external-evidence-collector',
    sourceRef: 'external-run-record',
    ...(withSignals
      ? {
          guiObservation: { observed: true, sourceRef: 'manual-gui-record', recordedAt },
          dualInstanceObservation: {
            observed: true,
            sourceRef: 'manual-dual-instance-record',
            recordedAt,
            instanceIds: ['desktop-a', 'desktop-b']
          },
          observabilityObservation: {
            observed: true,
            sourceRef: 'runtime-observability-record',
            recordedAt,
            sampleCount: 2,
            redacted: true
          }
        }
      : {})
  };
}

function freezeEvidence() {
  const ids = [
    'semantic-content',
    'story-model',
    'vertical-slices',
    'projection-sync',
    'proposal-cas',
    'durable-execution',
    'context-pipeline',
    'skills',
    'artifacts',
    'cache',
    'capability-routing',
    'instruction-registry',
    'evals',
    'observability',
    'plugins-legacy',
    'reliability'
  ];
  return Object.fromEntries(
    ids.map((id) => [id, { status: 'passed', source: `external-${id}-record`, recordedAt, scope: 'external' }])
  );
}

function writeJson(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'inkpi-phase18-23-evidence-'));
  const path = join(directory, 'input.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

describe('Phase 18/23 evidence collection harness', () => {
  it('emits a pending template and never treats an empty run as a pass', () => {
    const result = runCli(['--template']);
    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout) as Record<string, any>;
    expect(record).toMatchObject({ kind: 'phase18-23-evidence', status: 'pending', passed: false, eligible: false });
    expect(record.phase18.status).toBe('missing');
    expect(record.phase23.status).toBe('pending');
    expect(record.phase23.missing).toContain('evals');
    expect(record.phase23.missingSignals).toEqual(
      expect.arrayContaining(['gui-observation', 'dual-instance-observation', 'observability-observation'])
    );
  });

  it('keeps missing provider, labels, and runtime evidence pending', () => {
    const chaptersFile = writeJson(chapterInput());
    const metadataFile = writeJson(metadata());
    const result = runCli(['--chapters', chaptersFile, '--metadata', metadataFile]);
    expect(result.status).toBe(2);
    const record = JSON.parse(result.stdout) as Record<string, any>;
    expect(record.phase18).toMatchObject({ status: 'pending', passed: false });
    expect(record.phase18.humanLabels.status).toBe('missing');
    expect(record.phase18.provider.status).toBe('missing');
    expect(record.phase18.runtimeObservations.status).toBe('missing');
    expect(['missing', 'pending']).toContain(record.evidence.evals.status);
    expect(record.passed).toBe(false);
  });

  it('records complete Phase 18 inputs while keeping Phase 23 blocked by absent GUI/dual-instance/observability evidence', () => {
    const inputFile = writeJson(chapterInput());
    const labelsFile = writeJson(labels());
    const providerFile = writeJson(providerResults());
    const runtimeFile = writeJson(runtimeObservations());
    const metadataFile = writeJson(metadata());
    const result = runCli([
      '--chapters',
      inputFile,
      '--labels',
      labelsFile,
      '--provider',
      providerFile,
      '--runtime',
      runtimeFile,
      '--metadata',
      metadataFile
    ]);
    expect(result.status).toBe(2);
    const record = JSON.parse(result.stdout) as Record<string, any>;
    expect(record.phase18).toMatchObject({ status: 'passed', passed: true });
    expect(record.phase18.chapterInputs.map((entry: any) => entry.chapterCount)).toEqual([100, 300]);
    expect(record.phase18.provider.benchmarks.every((entry: any) => entry.status === 'passed')).toBe(true);
    expect(record.phase23.status).toBe('pending');
    expect(record.passed).toBe(false);
    expect(JSON.stringify(record)).not.toContain('private chapter body');
  });

  it('does not emit credential values or provider payloads when sensitive input is present', () => {
    const inputFile = writeJson(chapterInput());
    const labelsFile = writeJson(labels());
    const providerFile = writeJson(providerResults(true));
    const result = runCli(['--chapters', inputFile, '--labels', labelsFile, '--provider', providerFile]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('sk-test-secret-must-not-appear');
    expect(result.stdout).not.toContain('private chapter body');
    expect(result.stdout).not.toContain('provider payload');
    const record = JSON.parse(result.stdout) as Record<string, any>;
    expect(record.phase18.provider.status).toBe('pending');
    expect(record.security).toEqual({
      credentialValuesWritten: false,
      chapterBodiesWritten: false,
      providerBodiesWritten: false,
      privateReasoningWritten: false
    });
  });

  it('passes only when real-provider, human-label, runtime, GUI, dual-instance, and all external freeze records are present', () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), 'inkpi-phase18-23-output-')), 'record.json');
    const inputFile = writeJson(chapterInput());
    const labelsFile = writeJson(labels());
    const providerFile = writeJson(providerResults());
    const runtimeFile = writeJson(runtimeObservations());
    const metadataFile = writeJson(metadata(true));
    const evidenceFile = writeJson(freezeEvidence());
    execFileSync(
      process.execPath,
      [
        scriptPath,
        '--chapters',
        inputFile,
        '--labels',
        labelsFile,
        '--provider',
        providerFile,
        '--runtime',
        runtimeFile,
        '--metadata',
        metadataFile,
        '--evidence',
        evidenceFile,
        '--output',
        outputPath
      ],
      { encoding: 'utf8' }
    );
    const record = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, any>;
    expect(record).toMatchObject({ status: 'passed', passed: true, eligible: true });
    expect(record.phase23.passedGroupCount).toBe(16);
    expect(record.security.chapterBodiesWritten).toBe(false);
    expect(JSON.stringify(record)).not.toContain('private chapter body');
  });

  it('rejects attempts to overwrite the formal evidence directory', () => {
    const result = runCli(['--template', '--output', 'docs/evidence/final-freeze-local.json']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('formal evidence JSON');
  });
});
