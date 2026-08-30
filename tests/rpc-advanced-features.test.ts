import { describe, it, expect } from 'vitest';
import {
  InkRpcServer,
  InkRpcClient,
  InMemoryTransport,
  WorkflowCoordinator,
  TelemetryCollector
} from '@inkpi/agent-core';
import {
  InkDb,
  InkRepository,
  FtsSearchEngine,
  AppendOnlySessionJournal,
  JitMemoryRetriever
} from '@inkpi/storage';

describe('Advanced JSON-RPC Server & Client Features', () => {
  it('should support journal, jit memory, pipeline run and telemetry via RPC', async () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);
    const journal = new AppendOnlySessionJournal('rpc_session_1');
    const jitRetriever = new JitMemoryRetriever({ repository: repo, ftsEngine: fts });
    const telemetry = new TelemetryCollector();
    const pipeline = new WorkflowCoordinator({ telemetry });

    const server = new InkRpcServer({
      storage: repo,
      fts,
      journal,
      jitRetriever,
      pipeline,
      telemetry
    });

    const transport = new InMemoryTransport(server);
    const client = new InkRpcClient(transport);

    // 1. Journal RPC
    const appRes = await client.appendJournal('user_message', { content: 'RPC用户输入' }, 'evt_rpc_1');
    expect(appRes.id).toBe('evt_rpc_1');

    const entries = await client.getJournalEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].payload.content).toBe('RPC用户输入');

    // 2. JIT Memory RPC
    const jitRes = await client.retrieveJitMemory({
      currentDraftText: 'UserB踏入剑宗大殿'
    });
    expect(jitRes.l1WorkingMemory).toBeDefined();

    // 3. Pipeline Run RPC
    const pipeRes = await client.runPipeline('万界之尊', '第一document', '主角觉醒剑魂');
    expect(pipeRes.polishedText).toBeDefined();

    // 4. Telemetry RPC
    const stats = await client.getTelemetryStats();
    expect(stats.totalDurationMs).toBeGreaterThanOrEqual(0);

    const otel = await client.exportOpenTelemetry();
    expect(otel).toContain('resourceSpans');

    // 5. Dynamic registerMethod RPC
    server.registerMethod('custom.ping', (params) => ({ pong: true, echo: params.msg }));
    const customRes = await client.request('custom.ping', { msg: 'hello rpc' });
    expect(customRes).toEqual({ pong: true, echo: 'hello rpc' });

    db.close();
  });
});


