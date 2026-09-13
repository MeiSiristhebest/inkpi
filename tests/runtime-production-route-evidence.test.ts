import { AssistantEventStream, type ModelCatalogEntry, findModelInCatalog } from '@inkpi/ai';
import type { AiTask } from '@inkpi/protocol';
import { InkPiDaemon, createModelRouteFromCatalog } from '@inkpi/server';
import { afterEach, describe, expect, it } from 'vitest';

function streamThatReturns(text: string) {
  return () => {
    const stream = new AssistantEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'text_delta', textDelta: text });
      stream.end();
    });
    return stream;
  };
}

describe('Runtime production model route boundary', () => {
  const daemons: InkPiDaemon[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  });

  it('executes a catalog-derived real-provider route through task.submit and records provenance', async () => {
    const entry = findModelInCatalog('deepseek/deepseek-r1') as ModelCatalogEntry | undefined;
    expect(entry).toBeDefined();

    const daemon = new InkPiDaemon({
      modelRoutes: [
        createModelRouteFromCatalog(entry!, {
          stream: streamThatReturns('catalog route response')
        })
      ]
    });
    daemons.push(daemon);

    const task = {
      id: 'catalog-route-runtime-task',
      kind: 'runtime.production-route',
      input: { text: 'route through the Runtime boundary' },
      requirements: {
        network: 'required',
        needsReasoning: true,
        outputFormats: ['text'],
        modalities: ['text']
      },
      outputContract: { format: 'text' }
    } satisfies AiTask;

    const submitted = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'task.submit',
      params: { task }
    });
    expect(submitted.error).toBeUndefined();

    await expect(daemon.getTaskRouter().wait(task.id)).resolves.toMatchObject({
      status: 'completed',
      output: { format: 'text', text: 'catalog route response' },
      provenance: {
        selectedRoute: entry!.id,
        selectedProvider: entry!.provider,
        selectedModel: entry!.id,
        provider: entry!.provider,
        model: entry!.id
      }
    });
  });
});
