import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { InkRpcClient } from '@inkpi/client';
import type { AiTask, TaskStatusSnapshot } from '@inkpi/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type ReadyEvent = { type: 'ready'; port: number };

type BoundarySnapshot = {
  calls: Array<{ route: string; prompt: string }>;
  observation?: Record<string, unknown>;
  cache: {
    provider: { hits: number; misses: number; evictions: number; invalidations: number };
    context: { hits: number; misses: number; evictions: number; invalidations: number };
    retrieval: { hits: number; misses: number; evictions: number; invalidations: number };
  };
  instruction: {
    version: string;
    entries: Array<Record<string, unknown>>;
  };
};

const repositoryRoot = resolve(__dirname, '..');
const activeChildren = new Set<ChildProcess>();

/**
 * The child is a real InkPiDaemon. The extra RPC method is test-only
 * introspection; it is not part of the production protocol or evidence store.
 */
const CHILD_SCRIPT = String.raw`
import { AssistantEventStream } from '@inkpi/ai';
import { InkPiDaemon } from '@inkpi/server';

const calls = [];
let sampleDecisionCalls = 0;

function routeStream(route, _model, messages) {
  const prompt = messages
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )
    .join('\n');
  calls.push({ route, prompt });

  const stream = new AssistantEventStream();
  queueMicrotask(() => {
    if (route === 'primary') {
      stream.error('transient primary boundary failure');
      return;
    }
    stream.push({ type: 'thinking_delta', thinkingDelta: 'RAW_REASONING_MARKER' });
    stream.push({
      type: 'text_delta',
      textDelta: '<think>RAW_REASONING_MARKER</think>boundary answer'
    });
    stream.push({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, reasoningTokens: 2 }
    });
    stream.end();
  });
  return stream;
}

const primaryModel = {
  id: 'boundary-primary-model',
  name: 'Boundary primary model',
  provider: 'faux'
};
const backupModel = {
  id: 'boundary-backup-model',
  name: 'Boundary backup model',
  provider: 'faux'
};
const capabilities = {
  capabilities: ['boundary-writing'],
  modalities: ['text'],
  network: 'required',
  outputFormats: ['text'],
  streaming: true,
  structuredOutput: true
};

const daemon = new InkPiDaemon({
  host: '127.0.0.1',
  modelRoutes: [
    {
      id: 'primary',
      model: primaryModel,
      priority: 10,
      capabilities,
      stream: (model, messages) => routeStream('primary', model, messages)
    },
    {
      id: 'backup',
      model: backupModel,
      fallback: true,
      capabilities,
      stream: (model, messages) => routeStream('backup', model, messages)
    }
  ],
  observability: {
    sampleRate: 0.5,
    random: () => {
      const decision = sampleDecisionCalls === 0 ? 0.25 : 0.75;
      sampleDecisionCalls += 1;
      return decision;
    }
  }
});

daemon.getRpcServer().registerMethod('test.boundary.snapshot', (params) => ({
  calls: calls.map(({ route, prompt }) => ({ route, prompt })),
  observation:
    typeof params?.taskId === 'string' ? daemon.getTaskObservability().get(params.taskId) : undefined,
  cache: daemon.getCacheCoordinator().stats(),
  instruction: {
    version: daemon.getInstructionRegistry().version(),
    entries: daemon.getInstructionRegistry().listReferences()
  }
}));

await daemon.start(0, '127.0.0.1');
await daemon.getTaskRouter().ready;
process.stdout.write(JSON.stringify({ type: 'ready', port: daemon.getStatus().port }) + '\n');

const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
setInterval(() => undefined, 1_000);
`;

let client: InkRpcClient | undefined;

function startDaemon(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SCRIPT], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  activeChildren.add(child);

  return new Promise((resolveDaemon, rejectDaemon) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectDaemon(new Error(`Timed out waiting for boundary daemon; stderr=${stderr}; stdout=${stdout}`));
    }, 15_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ReadyEvent;
          if (event.type === 'ready' && event.port > 0) {
            finish(() => resolveDaemon({ child, port: event.port }));
            return;
          }
        } catch {
          // Daemon diagnostics before the ready line are not protocol output.
        }
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) =>
      finish(() => rejectDaemon(new Error(`Failed to spawn boundary daemon: ${error.message}; stderr=${stderr}`)))
    );
    child.once('exit', (code, signal) => {
      if (!settled)
        finish(() => rejectDaemon(new Error(`Boundary daemon exited (${code ?? signal}); stderr=${stderr}`)));
    });
  });
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(resolveExit, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
  activeChildren.delete(child);
}

async function waitForCompletion(rpc: InkRpcClient, taskId: string): Promise<TaskStatusSnapshot> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const snapshot = await rpc.request<TaskStatusSnapshot>('task.status', { taskId });
    if (['completed', 'failed', 'cancelled', 'waiting-user'].includes(snapshot.status)) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function snapshot(taskId: string): Promise<BoundarySnapshot> {
  return client!.request<BoundarySnapshot>('test.boundary.snapshot', { taskId });
}

function contextEnvelope(revision: number, reverseKeys: boolean): Record<string, unknown> {
  const blocks = [
    {
      id: 'boundary-block',
      type: 'paragraph',
      text: 'CURRENT_SCENE_MARKER',
      from: 0,
      to: 20
    }
  ];
  const neighboringDocuments = [
    {
      documentId: 'boundary-neighbor',
      revision,
      text: 'NEIGHBORING_DOCUMENT_MARKER'
    }
  ];
  const storyContext = {
    revision,
    canonicalFacts: [
      {
        id: 'boundary-fact',
        label: 'CANONICAL_FACT_MARKER',
        summary: 'The beacon remains active.',
        canonical: true
      }
    ],
    hypotheses: []
  };

  if (reverseKeys) {
    return {
      fingerprint: `desktop-envelope-v${revision}`,
      projectRevision: revision,
      storyContext,
      neighboringDocuments,
      blocks,
      selectionText: 'CURRENT_SCENE_MARKER',
      text: 'COMPLETE_DOCUMENT_MARKER',
      revision,
      documentId: 'boundary-document'
    };
  }
  return {
    documentId: 'boundary-document',
    revision,
    text: 'COMPLETE_DOCUMENT_MARKER',
    selectionText: 'CURRENT_SCENE_MARKER',
    blocks,
    neighboringDocuments,
    storyContext,
    projectRevision: revision,
    fingerprint: `desktop-envelope-v${revision}`
  };
}

function makeTask(id: string, revision: number, maxTokens: number, reverseKeys = false): AiTask {
  return {
    id,
    kind: 'boundary.governance',
    input: {
      documentId: 'boundary-document',
      selection: {
        documentId: 'boundary-document',
        from: 0,
        to: 20,
        revision
      },
      text: maxTokens <= 4 ? 'selected scene' : 'CURRENT_SCENE_MARKER',
      payload: { context: contextEnvelope(revision, reverseKeys) }
    },
    contextPolicy: {
      providerIds: ['creative.document', 'creative.story'],
      maxTokens,
      includeProjectState: true
    },
    intent: 'preserve the beacon continuity',
    requirements: {
      capabilities: ['boundary-writing'],
      modalities: ['text'],
      network: 'required',
      outputFormats: ['text'],
      streaming: true
    },
    outputContract: { format: 'text' }
  };
}

describe('Runtime Phase 6/14/15/16/19 cross-process governance', () => {
  beforeAll(async () => {
    const started = await startDaemon();
    client = await InkRpcClient.connectTcp(started.port, '127.0.0.1');
  });

  afterAll(async () => {
    await client?.close();
    client = undefined;
    for (const child of [...activeChildren]) await stopDaemon(child);
  });

  it('keeps serialized context, cache identity, failover, instructions, sampling, and redaction coherent', async () => {
    const registration = await client!.request<{
      instructionIds: string[];
      version: string;
      results: Array<{ id: string; version: string; status: string }>;
    }>('instruction.register', {
      id: 'boundary-governance-instruction',
      version: 'instruction-v7',
      taskKind: 'boundary.governance',
      systemInstruction: 'INSTRUCTION_BOUNDARY_MARKER'
    });
    expect(registration).toMatchObject({
      instructionIds: ['boundary-governance-instruction'],
      results: [{ id: 'boundary-governance-instruction', version: 'instruction-v7', status: 'added' }]
    });

    const instructionStatus = await client!.request<{
      version: string;
      instructionIds: string[];
      instructions: Array<Record<string, unknown>>;
    }>('instruction.status', {});
    expect(instructionStatus).toMatchObject({
      version: 'instructions-1',
      instructionIds: ['boundary-governance-instruction'],
      instructions: [
        {
          id: 'boundary-governance-instruction',
          version: 'instruction-v7',
          source: 'task:boundary.governance'
        }
      ]
    });

    const firstTask = makeTask('boundary-first', 1, 256);
    await expect(client!.request('task.submit', { task: firstTask })).resolves.toMatchObject({
      taskId: firstTask.id,
      status: 'queued'
    });
    const first = await waitForCompletion(client!, firstTask.id);
    expect(first).toMatchObject({
      status: 'completed',
      result: {
        output: { format: 'text', text: 'boundary answer' },
        provenance: {
          routeId: 'backup',
          selectedRoute: 'backup',
          selectedProvider: 'faux',
          selectedModel: 'boundary-backup-model',
          routeAttempts: ['primary', 'backup'],
          providerCacheHit: false,
          projectRevision: 1,
          contextSources: expect.arrayContaining(['task-input', 'creative.document', 'creative.story']),
          instructionVersion: 'instructions-1',
          instructionIds: ['boundary-governance-instruction'],
          instructionProvenance: [
            {
              id: 'boundary-governance-instruction',
              version: 'instruction-v7',
              source: 'task:boundary.governance'
            }
          ]
        }
      }
    });

    const firstFingerprint = first.result?.provenance?.contextFingerprint;
    expect(typeof firstFingerprint).toBe('string');
    expect(first.result?.provenance?.contextTokenCount).toBeLessThanOrEqual(256);

    const firstDiagnostics = await snapshot(firstTask.id);
    expect(firstDiagnostics.observation).toMatchObject({
      taskId: firstTask.id,
      kind: firstTask.kind,
      status: 'completed',
      contextFingerprint: firstFingerprint,
      contextTokenCount: first.result?.provenance?.contextTokenCount,
      projectRevision: 1,
      routeId: 'backup',
      instructionVersion: 'instructions-1',
      resultType: 'text',
      cache: {
        provider: { misses: 2 },
        context: { misses: 1 },
        retrieval: { misses: 0 }
      }
    });
    const firstObservationText = JSON.stringify(firstDiagnostics.observation);
    expect(firstObservationText).not.toContain('RAW_REASONING_MARKER');
    expect(firstObservationText).not.toContain('<think>');
    expect(firstObservationText).not.toContain('rawThinking');

    const fullPrompt = firstDiagnostics.calls.find((call) => call.route === 'backup')?.prompt ?? '';
    expect(fullPrompt).toContain('INSTRUCTION_BOUNDARY_MARKER');
    expect(fullPrompt).toContain('COMPLETE_DOCUMENT_MARKER');
    expect(fullPrompt).toContain('CANONICAL_FACT_MARKER');
    expect(fullPrompt).not.toContain('"storyContext"');
    expect(fullPrompt).not.toContain('RAW_REASONING_MARKER');

    const equivalentTask = makeTask('boundary-equivalent', 1, 256, true);
    await expect(client!.request('task.submit', { task: equivalentTask })).resolves.toMatchObject({
      taskId: equivalentTask.id,
      status: 'queued'
    });
    const equivalent = await waitForCompletion(client!, equivalentTask.id);
    expect(equivalent).toMatchObject({
      status: 'completed',
      result: {
        output: { format: 'text', text: 'boundary answer' },
        provenance: {
          contextFingerprint: firstFingerprint,
          providerCacheHit: true,
          projectRevision: 1,
          instructionVersion: 'instructions-1'
        }
      }
    });
    const equivalentDiagnostics = await snapshot(equivalentTask.id);
    expect(equivalentDiagnostics.observation).toBeUndefined();
    expect(equivalentDiagnostics.cache.context).toMatchObject({ hits: 1, misses: 1 });
    expect(equivalentDiagnostics.cache.provider).toMatchObject({ hits: 1, misses: 3 });

    const overflowTask = makeTask('boundary-overflow', 1, 4);
    await expect(client!.request('task.submit', { task: overflowTask })).resolves.toMatchObject({
      taskId: overflowTask.id,
      status: 'queued'
    });
    const overflow = await waitForCompletion(client!, overflowTask.id);
    expect(overflow).toMatchObject({
      status: 'completed',
      result: {
        output: { format: 'text', text: 'boundary answer' },
        provenance: {
          contextSources: ['task-input'],
          contextTokenCount: expect.any(Number),
          providerCacheHit: false,
          projectRevision: 1
        }
      }
    });
    expect(overflow.result?.provenance?.contextTokenCount).toBeLessThanOrEqual(4);
    const overflowDiagnostics = await snapshot(overflowTask.id);
    expect(overflowDiagnostics.observation).toBeUndefined();
    const overflowPrompt =
      [...overflowDiagnostics.calls].reverse().find((call) => call.route === 'backup')?.prompt ?? '';
    expect(overflowPrompt).toContain('selected scene');
    expect(overflowPrompt).not.toContain('COMPLETE_DOCUMENT_MARKER');
    expect(overflowPrompt).not.toContain('CANONICAL_FACT_MARKER');
    expect(overflowPrompt).not.toContain('"storyContext"');

    const invalidation = await client!.request<{
      accepted: boolean;
      status: { stats: BoundarySnapshot['cache'] };
    }>('cache.invalidate', { reason: 'revision', projectRevision: 2 });
    expect(invalidation).toMatchObject({
      accepted: true,
      status: {
        stats: {
          provider: { invalidations: 1 },
          context: { invalidations: 1 },
          retrieval: { invalidations: 1 }
        }
      }
    });

    const revisedTask = makeTask('boundary-after-invalidation', 2, 256);
    await expect(client!.request('task.submit', { task: revisedTask })).resolves.toMatchObject({
      taskId: revisedTask.id,
      status: 'queued'
    });
    const revised = await waitForCompletion(client!, revisedTask.id);
    expect(revised).toMatchObject({
      status: 'completed',
      result: {
        output: { format: 'text', text: 'boundary answer' },
        provenance: {
          contextFingerprint: expect.any(String),
          providerCacheHit: false,
          projectRevision: 2,
          routeAttempts: ['primary', 'backup']
        }
      }
    });
    expect(revised.result?.provenance?.contextFingerprint).not.toBe(firstFingerprint);

    const mismatchTask = makeTask('boundary-capability-mismatch', 2, 256);
    mismatchTask.requirements = {
      ...mismatchTask.requirements,
      modalities: ['image']
    };
    await expect(client!.request('task.submit', { task: mismatchTask })).rejects.toThrow(/Capability mismatch/);
    await expect(client!.request('task.status', { taskId: mismatchTask.id })).rejects.toThrow(/Unknown task/);

    const finalDiagnostics = await snapshot(revisedTask.id);
    expect(finalDiagnostics.instruction).toMatchObject({
      version: 'instructions-1',
      entries: [
        {
          id: 'boundary-governance-instruction',
          version: 'instruction-v7',
          source: 'task:boundary.governance'
        }
      ]
    });
    expect(finalDiagnostics.cache.provider).toMatchObject({ hits: 1, invalidations: 1 });
    expect(finalDiagnostics.cache.context).toMatchObject({ hits: 1, invalidations: 1 });
  });
});
