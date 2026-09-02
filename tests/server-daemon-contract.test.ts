import { describe, it, expect, afterEach } from 'vitest';
import { InkPiDaemon } from '@inkpi/server';

// ---------------------------------------------------------------------------
// @inkpi/server 的遗留 InkPiDaemon 契约。
//
// 两处被评审点名的行为在此锁定：
//   1. 未配置模型时**不再**静默回显 `InkPi Response for [...]` 假响应 —— 那会让
//      调用方以为模型真的回答了。现在必须显式报错。
//   2. 端口 0 应被解析为操作系统实际分配的端口，而不是把 0 报给调用方。
// ---------------------------------------------------------------------------
describe('@inkpi/server InkPiDaemon contract', () => {
  let daemon: InkPiDaemon | null = null;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
  });

  function makeDaemon(port = 0): InkPiDaemon {
    // 完整版 InkPiDaemon 自行创建领域层 SessionRegistry（无默认模型时不静默回落）。
    daemon = new InkPiDaemon({ port });
    return daemon;
  }

  it('未配置模型的 session.create 显式报错，不再静默回显假响应', async () => {
    const d = makeDaemon();
    // 完整版守护进程在**创建会话时**即显式报错（无模型无法创建会话），
    // 而非先创建再在 prompt 时静默回显假响应。这正是架构评审要锁定的行为。
    const res = await d.getRpcServer().handleRequest({ jsonrpc: '2.0', id: 1, method: 'session.create', params: { sessionId: 's1' } });

    expect(res.error).toBeDefined();
    expect(res.error!.message).toMatch(/No model configured/i);
    // 关键：绝不能出现原先那种伪装成模型回答的回显文本
    expect(res.result).toBeUndefined();
    expect(JSON.stringify(res)).not.toMatch(/InkPi Response for/);
  });

  it('显式传入 mock-test 模型的 session.prompt 走真实（测试替身）模型路径', async () => {
    const d = makeDaemon();
    await d.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.create',
      params: { sessionId: 's2', model: 'mock-test' }
    });

    const res = await d.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'session.prompt',
      params: { sessionId: 's2', prompt: '请续写一段。' }
    });

    expect(res.error).toBeUndefined();
    expect((res.result as { success: boolean }).success).toBe(true);
    expect((res.result as { messageCount: number }).messageCount).toBe(2);
  });

  it('未知方法返回错误响应，异常不外泄为未捕获错误', async () => {
    const d = makeDaemon();
    const res = await d.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'no.such.method',
      params: {}
    });
    expect(res.error).toBeDefined();
  });

  it('端口 0 解析为操作系统分配的实际端口', async () => {
    const d = makeDaemon(0);
    await d.start();
    const port = d.getPort();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(0);
  });

  it('stop 幂等，且未启动时 stop 安全', async () => {
    const notStarted = makeDaemon(0);
    await expect(notStarted.stop()).resolves.toBeUndefined();

    const d = makeDaemon(0);
    await d.start();
    await d.stop();
    await expect(d.stop()).resolves.toBeUndefined();
    daemon = null; // 已手动停止，避免 afterEach 重复操作
  });
});
