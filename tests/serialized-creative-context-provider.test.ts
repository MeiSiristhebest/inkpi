import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { InkRpcClient } from '@inkpi/client';
import type { AiTask, TaskStatusSnapshot } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

type ReadyEvent = { type: 'ready'; port: number };

const repositoryRoot = resolve(__dirname, '..');
const activeChildren = new Set<ChildProcess>();

const CHILD_SCRIPT = String.raw`
import { AssistantEventStream, findModelInCatalog } from '@inkpi/ai';
import { createModelRouteFromCatalog, InkPiDaemon } from '@inkpi/server';

const entry = findModelInCatalog('deepseek/deepseek-r1');
if (!entry) throw new Error('deepseek catalog route is required for the provider test');
const stream = () => {
  const result = new AssistantEventStream();
  queueMicrotask(() => {
    result.push({ type: 'text_delta', textDelta: 'serialized context accepted' });
    result.end();
  });
  return result;
};
const daemon = new InkPiDaemon({
  host: '127.0.0.1',
  modelRoutes: [createModelRouteFromCatalog(entry, { stream })]
});
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
      rejectDaemon(new Error(`Timed out waiting for context daemon; stderr=${stderr}; stdout=${stdout}`));
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
      for (const line of stdout.split('\n').slice(0, -1)) {
        try {
          const event = JSON.parse(line) as ReadyEvent;
          if (event.type === 'ready' && event.port > 0) {
            finish(() => resolveDaemon({ child, port: event.port }));
            return;
          }
        } catch {
          // Keep waiting for the ready line.
        }
      }
      stdout = stdout.slice(stdout.lastIndexOf('\n') + 1);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) =>
      finish(() => rejectDaemon(new Error(`Failed to spawn context daemon: ${error.message}; stderr=${stderr}`)))
    );
    child.once('exit', (code, signal) => {
      if (!settled)
        finish(() => rejectDaemon(new Error(`Context daemon exited (${code ?? signal}); stderr=${stderr}`)));
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

async function waitForCompletion(client: InkRpcClient, taskId: string): Promise<TaskStatusSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await client.request<TaskStatusSnapshot>('task.status', { taskId });
    if (['completed', 'failed', 'cancelled', 'waiting-user'].includes(snapshot.status)) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

afterEach(async () => {
  for (const child of [...activeChildren]) await stopDaemon(child);
});

describe('serialized CreativeContext provider boundary', () => {
  it('projects Desktop payload context through a real Daemon process', async () => {
    const daemon = await startDaemon();
    const client = await InkRpcClient.connectTcp(daemon.port, '127.0.0.1');
    const task = {
      id: 'serialized-creative-context-task',
      kind: 'creative.continue',
      input: {
        documentId: 'chapter-1',
        text: '当前段落',
        payload: {
          context: {
            documentId: 'chapter-1',
            revision: 7,
            text: '完整章节正文',
            selectionText: '当前段落',
            blocks: [{ id: 'block-1', type: 'paragraph', text: '当前段落', from: 0, to: 4 }],
            neighboringDocuments: [],
            storyContext: {
              revision: 3,
              canonicalFacts: [{ id: 'fact-1', label: '事实', summary: '作者事实', canonical: true }],
              hypotheses: []
            },
            projectRevision: 7,
            fingerprint: 'creative-context-v1'
          }
        }
      },
      contextPolicy: {
        providerIds: ['creative.document', 'creative.story'],
        includeProjectState: true,
        metadata: { contextFingerprint: 'creative-context-v1' }
      },
      requirements: { network: 'required', modalities: ['text'], outputFormats: ['text'] },
      outputContract: { format: 'text' }
    } satisfies AiTask;

    try {
      await expect(client.request('task.submit', { task })).resolves.toMatchObject({
        taskId: task.id,
        status: 'queued'
      });
      const result = await waitForCompletion(client, task.id);
      expect(result).toMatchObject({
        status: 'completed',
        result: {
          output: { format: 'text', text: 'serialized context accepted' },
          provenance: {
            contextSources: expect.arrayContaining(['creative.document', 'creative.story'])
          }
        }
      });
    } finally {
      await client.close();
      await stopDaemon(daemon.child);
    }
  }, 30_000);
});
