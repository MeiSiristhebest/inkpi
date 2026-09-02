import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// 依赖方向守卫（architecture ratchet）
//
// 评审结语指出：最该先做的不是重构，而是补一条**能失败**的检查 —— 断言
// `agent-core` 不得 import 表现层（`@inkpi/tui`）、基础设施（`@inkpi/storage`）
// 或传输层（`node:net`）。领域核心依赖这些，意味着"六边形架构"只是目录命名。
//
// 直接让 CI 变红会阻塞所有后续工作，因此这里采用棘轮（ratchet）策略：
//   - 已知的 6 个违规文件记录在 BASELINE 中，CI 今天保持绿灯；
//   - 任何**新增**违规立即失败；
//   - 基线只许变小、不许变大：一旦某个文件被清理，必须从 BASELINE 中删除，
//     否则测试失败 —— 这保证债务只减不增。
//
// 当 BASELINE 被清空时，agent-core 即真正成为不依赖表现层/基础设施的领域核心。
// ---------------------------------------------------------------------------

const AGENT_CORE_SRC = path.resolve(__dirname, '../packages/agent-core/src');

/** 领域核心不得依赖的模块（评审 §4 点名的三类 + 事件驱动的 ws）。 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^@inkpi\/tui$/, label: '@inkpi/tui (表现层)' },
  { pattern: /^@inkpi\/storage$/, label: '@inkpi/storage (基础设施)' },
  { pattern: /^node:net$/, label: 'node:net (传输层)' },
  { pattern: /^ws$/, label: 'ws (WebSocket 传输)' }
];

/**
 * 已知违规基线。
 *
 * 阶段 2（治本）已完成：`rpc/`（daemon/server/client/transports）已整体迁移至
 * `@inkpi/server`，`tui/`（studio/terminal-harness）已迁移至 `@inkpi/tui`。
 * agent-core 自此成为不依赖表现层（`@inkpi/tui`）、基础设施（`@inkpi/storage`）、
 * 传输层（`node:net` / `ws`）的纯净领域核心。基线已清空——任何新增违规都会立即失败。
 */
const BASELINE: Record<string, string[]> = {};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释，避免把文档里的包名误判为真实 import。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 提取静态 import / 再导出 / 动态 import 的模块说明符。 */
function extractSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specs: string[] = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;}])(?:import|export)\s*['"]([^'"]+)['"]/g
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
  }
  return specs;
}

function collectViolations(): Map<string, string[]> {
  const violations = new Map<string, string[]>();
  for (const file of listSourceFiles(AGENT_CORE_SRC)) {
    const rel = path.relative(AGENT_CORE_SRC, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    const hits = new Set<string>();
    for (const spec of extractSpecifiers(source)) {
      for (const { pattern } of FORBIDDEN) {
        if (pattern.test(spec)) hits.add(spec);
      }
    }
    if (hits.size > 0) violations.set(rel, [...hits].sort());
  }
  return violations;
}

describe('依赖方向守卫：agent-core 不得依赖表现层 / 基础设施 / 传输层', () => {
  const actual = collectViolations();

  it('不出现基线之外的新违规', () => {
    const regressions: string[] = [];
    for (const [file, specs] of actual) {
      const allowed = BASELINE[file];
      if (!allowed) {
        regressions.push(`${file} —— 新增违规文件，引入了 ${specs.join(', ')}`);
        continue;
      }
      for (const spec of specs) {
        if (!allowed.includes(spec)) {
          regressions.push(`${file} —— 新增违规依赖 ${spec}`);
        }
      }
    }
    expect(regressions, `agent-core 新增了依赖方向违规：\n${regressions.join('\n')}`).toEqual([]);
  });

  it('基线只许变小、不许变大（债务只减不增）', () => {
    const stale: string[] = [];
    for (const file of Object.keys(BASELINE)) {
      const specs = actual.get(file) ?? [];
      const removed = BASELINE[file].filter((s) => !specs.includes(s));
      if (removed.length > 0) {
        stale.push(
          `${file} —— 已从代码中清除 ${removed.join(', ')}，请同步从 BASELINE 删除该条目，使债务只减不增`
        );
      }
    }
    expect(stale, `依赖基线已过期：\n${stale.join('\n')}`).toEqual([]);
  });

  it('扫描器本身有效：agent-core 已无违规，且仍能识别禁用依赖', () => {
    // 棘轮目标达成：agent-core 不再依赖表现层 / 基础设施 / 传输层。
    expect(actual.size, 'agent-core 仍存在依赖方向违规').toBe(0);

    // 防回归：若正则写错导致一个都扫不出来，上面的断言会"假绿"。
    // 这里用一段合成源码验证扫描器确实能检出禁用依赖。
    const sample = `
      import * as net from 'node:net';
      import { Foo } from '@inkpi/tui';
      import { Bar } from '@inkpi/storage';
      import WebSocket from 'ws';
    `;
    const specs = extractSpecifiers(sample);
    const detected = new Set<string>();
    for (const spec of specs) {
      for (const { pattern } of FORBIDDEN) {
        if (pattern.test(spec)) detected.add(spec);
      }
    }
    expect(detected.has('node:net')).toBe(true);
    expect(detected.has('@inkpi/tui')).toBe(true);
    expect(detected.has('@inkpi/storage')).toBe(true);
    expect(detected.has('ws')).toBe(true);
  });
});
