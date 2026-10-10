import { ConversationContext } from '../packages/agent-core/dist/conversation-context.js';
import { AppendOnlySessionJournal } from '../packages/storage/dist/journal.js';

// Run after the TypeScript build. Measurements cover projection and external
// model-view cloning; constructing the fixture is excluded from the timings.
for (const count of [1000, 10000]) {
  const journal = new AppendOnlySessionJournal('context-benchmark');
  journal.appendBatch(
    Array.from({ length: count }, (_, index) => ({
      type: 'user_message',
      id: `message-${index}`,
      payload: { content: '章节内容 '.repeat(20) }
    }))
  );
  const context = new ConversationContext(journal, () => 1);
  const cpu = process.cpuUsage();
  const started = performance.now();
  context.getContext();
  const firstViewMs = performance.now() - started;
  const firstCpu = process.cpuUsage(cpu);
  const incrementalViewMs = [];
  for (let turn = 0; turn < 10; turn++) {
    await context.append('user_message', { content: `next chapter ${turn}` });
    const next = performance.now();
    context.getModelMessages();
    incrementalViewMs.push(performance.now() - next);
  }
  console.log(
    JSON.stringify({
      node: process.version,
      entries: count,
      firstViewMs,
      firstCpuMs: (firstCpu.user + firstCpu.system) / 1000,
      incrementalViewMs,
      rssMiB: process.memoryUsage().rss / 1048576,
      ...context.getCacheStats()
    })
  );
}
