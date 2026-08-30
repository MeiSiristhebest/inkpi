import { describe, it, expect } from 'vitest';
import { SlashCommandRegistry, Agent, SessionTree } from '@inkpi/agent-core';

describe('@inkpi/agent-core -> SlashCommandRegistry', () => {
  it('should execute built-in commands like /model, /thinking, /tree, /stats, /help', async () => {
    const registry = new SlashCommandRegistry();
    const agent = new Agent();
    const tree = new SessionTree();

    tree.addMessage({ role: 'user', content: '测试消息' } as any);

    // 1. /help
    const helpRes = await registry.execute('/help', {});
    expect(helpRes.handled).toBe(true);
    expect(helpRes.output).toContain('/model');
    expect(helpRes.output).toContain('/thinking');

    // 2. /model switch
    const modelRes = await registry.execute('/model deepseek-reasoner', { agent });
    expect(modelRes.success).toBe(true);
    expect(modelRes.output).toContain('DeepSeek R1');
    expect(agent.state.model.id).toBe('deepseek-reasoner');

    // 3. /thinking change
    const thinkingRes = await registry.execute('/thinking high', { agent });
    expect(thinkingRes.success).toBe(true);
    expect(agent.state.thinkingLevel).toBe('high');

    // 4. /tree view
    const treeRes = await registry.execute('/tree', { tree });
    expect(treeRes.success).toBe(true);
    expect(treeRes.output).toContain('分支树');

    // 5. /stats
    const statsRes = await registry.execute('/stats', { agent });
    expect(statsRes.success).toBe(true);
    expect(statsRes.output).toContain('会话统计');
  });

  it('should register and execute custom extensions slash commands cleanly', async () => {
    const registry = new SlashCommandRegistry();

    registry.register({
      name: 'clue_check',
      description: '伏笔自检指令',
      handler: (ctx) => ({
        success: true,
        output: `已完成伏笔自检，当前参数: ${ctx.args.join(',')}`
      })
    });

    const res = await registry.execute('/clue_check document_12 all', {});
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.output).toContain('document_12,all');
  });


  it('should test all built-in command branch conditions', async () => {

    const registry = new SlashCommandRegistry();
    const agent = new Agent();
    const tree = new SessionTree();

    // 1. /model without args
    const m1 = await registry.execute('/model', { agent });
    expect(m1.output).toContain('当前活跃模型');

    // 2. /model unknown
    const m2 = await registry.execute('/model unknown_xyz_model', { agent });
    expect(m2.success).toBe(false);

    // 3. /thinking without args & invalid arg
    const t1 = await registry.execute('/thinking', { agent });
    expect(t1.output).toContain('当前思考预算等级');
    const t2 = await registry.execute('/thinking super_extreme', { agent });
    expect(t2.success).toBe(false);

    // 4. /tree without tree
    const tr1 = await registry.execute('/tree', {});
    expect(tr1.success).toBe(false);

    // 5. /branch without tree & with args
    const b1 = await registry.execute('/branch', {});
    expect(b1.success).toBe(false);

    const rootId = tree.addMessage({ role: 'user', content: 'hello' } as any);
    const b2 = await registry.execute(`/branch ${rootId}`, { tree });
    expect(b2.success).toBe(true);

    // 6. /compact without agent & with agent
    const c1 = await registry.execute('/compact', {});
    expect(c1.success).toBe(false);
    const c2 = await registry.execute('/compact', { agent });
    expect(c2.success).toBe(true);

    // 7. /export
    const exp1 = await registry.execute('/export markdown', {});
    expect(exp1.output).toContain('markdown');

    // 8. Non-slash command
    const nonSlash = await registry.execute('not a slash', {});
    expect(nonSlash.handled).toBe(false);

    // 9. Unknown command
    const unk = await registry.execute('/unknown_cmd_abc', {});
    expect(unk.output).toContain('未知指令');
  });

});
