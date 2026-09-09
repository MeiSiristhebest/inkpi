import type { TaskHandlerContext } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'context-provider-task',
    kind: 'context-provider.test',
    input: { documentId: 'document-1', text: 'task input' },
    contextPolicy: { providerIds: ['host.document'] },
    outputContract: { format: 'text' },
    ...overrides
  };
}

describe('Daemon context provider registration', () => {
  const daemons: InkPiDaemon[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  });

  it('registers host providers in the shared TaskRouter pipeline and uses them for task RPCs', async () => {
    let receivedContext: TaskHandlerContext['context'] | undefined;
    const daemon = new InkPiDaemon({
      context: {
        contextProviders: [
          {
            id: 'host.document',
            provide: () => [
              {
                id: 'document:document-1',
                source: 'host.document',
                kind: 'document',
                text: 'canonical document context',
                priority: 100
              }
            ]
          }
        ]
      }
    });
    daemons.push(daemon);
    daemon.getTaskRouter().registry.register({
      id: 'context-provider-handler',
      kinds: ['context-provider.test'],
      async execute(context) {
        receivedContext = context.context;
        return { output: { format: 'text', text: 'ok' } };
      }
    });

    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'task.submit',
      params: { task: task() }
    });
    expect(response.error).toBeUndefined();

    await expect(daemon.getTaskRouter().wait(task().id)).resolves.toMatchObject({
      status: 'completed',
      output: { format: 'text', text: 'ok' }
    });
    expect(
      daemon
        .getTaskRouter()
        .contextPipeline.list()
        .map((provider) => provider.id)
    ).toContain('host.document');
    expect(receivedContext?.fragments).toEqual([
      expect.objectContaining({
        source: 'task-input',
        text: 'task input'
      }),
      expect.objectContaining({
        source: 'host.document',
        text: 'canonical document context'
      })
    ]);
  });

  it('does not duplicate a provider already present in an injected pipeline', async () => {
    const { ContextPipeline } = await import('@inkpi/agent-core');
    const provider = {
      id: 'host.existing',
      provide: () => []
    };
    const pipeline = new ContextPipeline();
    pipeline.register(provider);
    const daemon = new InkPiDaemon({
      context: {
        contextPipeline: pipeline,
        contextProviders: [provider]
      }
    });
    daemons.push(daemon);

    expect(
      daemon
        .getTaskRouter()
        .contextPipeline.list()
        .filter((item) => item.id === provider.id)
    ).toHaveLength(1);
  });

  it('lets a host provider override the serialized CreativeContext adapter', async () => {
    let receivedContext: TaskHandlerContext['context'] | undefined;
    const daemon = new InkPiDaemon({
      context: {
        contextProviders: [
          {
            id: 'creative.document',
            provide: () => [
              {
                id: 'host-document-override',
                source: 'host.document.override',
                text: 'host-owned document context',
                priority: 900
              }
            ]
          }
        ]
      }
    });
    daemons.push(daemon);
    daemon.getTaskRouter().registry.register({
      id: 'context-provider-override-handler',
      kinds: ['context-provider.override'],
      async execute(context) {
        receivedContext = context.context;
        return { output: { format: 'text', text: 'ok' } };
      }
    });

    const overrideTask = task({
      id: 'context-provider-override-task',
      kind: 'context-provider.override',
      contextPolicy: { providerIds: ['creative.document'] },
      input: {
        documentId: 'document-1',
        text: 'task input',
        payload: { context: { documentId: 'document-1', text: 'serialized document context' } }
      }
    });
    await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'task.submit',
      params: { task: overrideTask }
    });
    await expect(daemon.getTaskRouter().wait(overrideTask.id)).resolves.toMatchObject({ status: 'completed' });

    expect(
      daemon
        .getTaskRouter()
        .contextPipeline.list()
        .filter((provider) => provider.id === 'creative.document')
    ).toHaveLength(1);
    expect(receivedContext?.fragments).toEqual([
      expect.objectContaining({ source: 'task-input', text: 'task input' }),
      expect.objectContaining({ source: 'host.document.override', text: 'host-owned document context' })
    ]);
  });
});
