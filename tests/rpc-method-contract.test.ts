import * as fs from 'node:fs';
import * as path from 'node:path';
import { DAEMON_RPC_METHOD_NAMES, RUNTIME_CAPABILITIES } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RPC_METHODS } from '../packages/server/src/builtin-methods.js';

// ---------------------------------------------------------------------------
// Daemon RPC 契约守卫
//
// `DaemonRpcMethodMap` 把每个方法的 params / result 声明在 @inkpi/protocol 里，
// `InkRpcServer.registerMethod` 只对**表内**的名字收紧签名，所以契约是否还和现实一致，
// 必须由这条检查守住：
//   1. 注册了却没进契约表的方法 —— 编译期不会报错（走宽松分支），只有这里能发现；
//   2. 契约表里有、但已经不再注册的方法；
//   3. `runtime.handshake` 对外通告的能力里出现没有契约的方法；
//   4. 两张分发表的（daemon 注册表 / 内建 BUILTIN_RPC_METHODS）名字重叠 ——
//      分发时 customHandlers 优先，重名会静默遮蔽内建实现。
//
// 第 1 条正是新增 RPC 时的正确性关口：先给 `DaemonRpcMethodMap` 补一行，再注册。
//
// 与 tests/dependency-direction.test.ts 同样的棘轮（ratchet）策略：正在进行中的方法
// 登记在 PENDING_CONTRACT 里，CI 保持绿灯；任何**新增**未契约化的方法立即失败；
// 一旦某个方法补上了契约，必须同步从 PENDING_CONTRACT 删除，否则失败 —— 债务只减不增。
// ---------------------------------------------------------------------------

const DAEMON_SOURCE = path.resolve(__dirname, '../packages/server/src/daemon.ts');

/**
 * 暂时已注册但尚无 RPC 契约的方法。新增方法应优先补齐 DaemonRpcMethodMap；
 * 完成契约后，必须立即从此白名单移除。
 */
const PENDING_CONTRACT: readonly string[] = [];

/** 去掉注释，避免把文档或注释里的方法名当成真实注册。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractRegisteredMethods(code: string): string[] {
  // 注册调用可能换行，因此用 [\s\S] 匹配 name 实参。
  return [...stripComments(code).matchAll(/registerMethod\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function registeredDaemonMethods(): string[] {
  return extractRegisteredMethods(fs.readFileSync(DAEMON_SOURCE, 'utf8'));
}

describe('Daemon RPC 契约守卫', () => {
  const registered = [...new Set(registeredDaemonMethods())];
  const contracted: string[] = [...DAEMON_RPC_METHOD_NAMES];
  const contractedOrPending = new Set([...contracted, ...PENDING_CONTRACT]);

  it('每个注册方法都在契约表里', () => {
    const missing = registered.filter((name) => !contractedOrPending.has(name));
    expect(
      missing,
      `方法 ${missing.join(', ')} 已注册但未声明契约：请先在 DaemonRpcMethodMap 与 DAEMON_RPC_METHOD_NAMES 中补上 params/result。`
    ).toEqual([]);
  });

  it('契约表不保留已停止注册的方法', () => {
    const actual = new Set(registered);
    const stale = contracted.filter((name) => !actual.has(name));
    expect(stale, `契约中的 ${stale.join(', ')} 在 daemon 中已不再注册。`).toEqual([]);
  });

  it('注册数量与契约条目一一对应（含 session.getState 别名）', () => {
    expect(registered.filter((name) => !PENDING_CONTRACT.includes(name))).toHaveLength(contracted.length);
  });

  it('对外通告的 runtime 能力都有契约', () => {
    const uncontracted = RUNTIME_CAPABILITIES.filter((capability) => !contractedOrPending.has(capability));
    expect(uncontracted, `handshake 通告了没有契约的能力：${uncontracted.join(', ')}`).toEqual([]);
  });

  it('两张 RPC 分发表不重名', () => {
    const builtin = new Set(Object.keys(BUILTIN_RPC_METHODS));
    const overlap = contracted.filter((name) => builtin.has(name));
    expect(overlap, `重名会让 customHandlers 静默遮蔽内建实现：${overlap.join(', ')}`).toEqual([]);
  });

  it('在途白名单不许变成死条目（契约债务只减不增）', () => {
    const rot: string[] = [];
    for (const name of PENDING_CONTRACT) {
      if (contracted.includes(name)) {
        rot.push(`${name} —— 已进入 DaemonRpcMethodMap，请从 PENDING_CONTRACT 删除该条目`);
      }
    }
    expect(rot, `契约基线已过期：\n${rot.join('\n')}`).toEqual([]);
  });

  it('扫描器本身有效：注册表能扫出名字，内建表非空', () => {
    // 防"假绿"：若正则退化到一个名字都扫不出来，前面的断言会集体通过。
    expect(
      extractRegisteredMethods(`
        server.registerMethod('workspace.purge', handler);
        server.registerMethod(
          'session.getState',
          handler
        );
      `)
    ).toEqual(['workspace.purge', 'session.getState']);
    expect(registered.length).toBeGreaterThanOrEqual(contracted.length);
    expect(Object.keys(BUILTIN_RPC_METHODS).length).toBeGreaterThan(30);
    expect(Object.keys(BUILTIN_RPC_METHODS)).toContain('agent.prompt');
  });
});
