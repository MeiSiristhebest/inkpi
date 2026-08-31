import type { SlashCommand, AgentMessage, ThinkingLevel } from '@meisiristhebest/protocol';
import type { Agent } from './agent.js';
import type { SessionTree } from './tree.js';
import { findModelInCatalog, modelCatalogEntryToConfig } from '@meisiristhebest/ai';

export interface SlashCommandCapabilities {
  compact?: (ctx: SlashCommandExecutionContext) => Promise<string> | string;
  export?: (format: 'html' | 'markdown' | 'jsonl', ctx: SlashCommandExecutionContext) => Promise<string> | string;
}

export interface SlashCommandExecutionContext {
  agent?: Agent;
  tree?: SessionTree;
  editor?: any;
  args: string[];
  rawText: string;
  capabilities?: SlashCommandCapabilities;
}

export type SlashCommandHandler = (
  ctx: SlashCommandExecutionContext
) => Promise<{ success: boolean; output: string }> | { success: boolean; output: string };

export interface BuiltinCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  usage?: string;
  handler: SlashCommandHandler;
  execute?: (args: string, context?: unknown) => Promise<string | void> | (string | void);
}

/**
 * 通用斜杠指令系统 (1:1 对标 repos/pi BuiltinSlashCommands)
 */
export class SlashCommandRegistry {
  private commands = new Map<string, BuiltinCommandDefinition>();

  constructor() {
    this.registerDefaults();
  }

  public register(cmd: BuiltinCommandDefinition): void {
    if (!cmd.execute) {
      cmd.execute = async (argsStr: string, context?: any) => {
        const res = await cmd.handler({
          args: argsStr ? argsStr.split(/\s+/) : [],
          rawText: `/${cmd.name} ${argsStr}`.trim(),
          agent: context?.agent,
          tree: context?.tree
        });
        return res.output;
      };
    }
    this.commands.set(cmd.name.toLowerCase(), cmd);
  }

  public get(name: string): BuiltinCommandDefinition | undefined {
    return this.commands.get(name.toLowerCase());
  }

  public getAll(): BuiltinCommandDefinition[] {
    return Array.from(this.commands.values());
  }

  public isSlashCommand(input: string): boolean {
    return input.trim().startsWith('/');
  }

  /**
   * 解析并执行斜杠指令
   */
  public async execute(
    input: string,
    ctx: Omit<SlashCommandExecutionContext, 'args' | 'rawText'>
  ): Promise<{ success: boolean; output: string; handled: boolean }> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return { success: false, output: 'Not a slash command', handled: false };
    }

    const parts = trimmed.slice(1).split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      return {
        success: false,
        output: `未知指令 /${cmdName}。输入 /help 查看所有可用指令。`,
        handled: true
      };
    }

    try {
      const res = await cmd.handler({
        ...ctx,
        args,
        rawText: trimmed
      });
      return { ...res, handled: true };
    } catch (err) {
      return {
        success: false,
        output: `指令 /${cmdName} 执行失败: ${(err as Error).message}`,
        handled: true
      };
    }
  }

  private registerDefaults(): void {
    // 1. /model - 切换模型
    this.register({
      name: 'model',
      description: '查看或切换当前大模型',
      argumentHint: '<model_id|name>',
      handler: (ctx) => {
        if (ctx.args.length === 0) {
          const current = ctx.agent?.state.model?.name || '默认模型';
          return { success: true, output: `当前活跃模型: ${current}` };
        }
        const target = ctx.args.join(' ');
        const found = findModelInCatalog(target);
        if (found && ctx.agent) {
          ctx.agent.state.model = modelCatalogEntryToConfig(found);
          return { success: true, output: `已切换至模型: ${found.name} (${found.provider})` };
        }
        return { success: false, output: `未在模型库中找到匹配项 '${target}'` };
      }
    });

    // 2. /thinking - 设置思考深度
    this.register({
      name: 'thinking',
      description: '调节 Agent 深度思考预算级别 (none, low, medium, high, max)',
      argumentHint: '<none|low|medium|high|max>',
      handler: (ctx) => {
        if (ctx.args.length === 0) {
          const lvl = ctx.agent?.state.thinkingLevel || 'low';
          return { success: true, output: `当前思考预算等级: ${lvl}` };
        }
        const lvl = ctx.args[0].toLowerCase() as ThinkingLevel;
        if (['none', 'low', 'medium', 'high', 'max'].includes(lvl) && ctx.agent) {
          ctx.agent.state.thinkingLevel = lvl;
          return { success: true, output: `思考预算已调整为: ${lvl}` };
        }
        return { success: false, output: `无效等级 '${ctx.args[0]}'，可选值: none, low, medium, high, max` };
      }
    });

    // 3. /tree & /branch - 查看与分叉分支
    this.register({
      name: 'tree',
      description: '查看所有推演分支图谱与活跃叶子节点',
      handler: (ctx) => {
        if (!ctx.tree) return { success: false, output: '当前会话树未启用' };
        const branches = ctx.tree.getBranches();
        const curr = ctx.tree.getCurrentLeafId();
        const list = branches
          .map((b, idx) => `${b.leafId === curr ? '👉 *' : '   '} [分支 ${idx + 1}] ID: ${b.leafId} (${b.length} 轮推演)`)
          .join('\n');
        return { success: true, output: `🌲 当前分支树:\n${list || '暂无分支'}` };
      }
    });

    this.register({
      name: 'branch',
      description: '基于当前或指定节点分叉新分支',
      argumentHint: '<from_node_id?>',
      handler: (ctx) => {
        if (!ctx.tree) return { success: false, output: '当前会话树未启用' };
        const fromId = ctx.args[0] || ctx.tree.getCurrentLeafId();
        if (!fromId) return { success: false, output: '无法确定分叉源节点' };
        ctx.tree.fork(fromId);
        return { success: true, output: `🌿 已从节点 ${fromId} 成功分叉出新推演分支！` };
      }
    });

    // 4. /compact - 手动压缩上下文
    this.register({
      name: 'compact',
      description: '手动将当前长对话压缩为摘要并提取状态账本',
      handler: async (ctx) => {
        if (!ctx.agent) return { success: false, output: 'Agent 未初始化' };
        if (!ctx.capabilities?.compact) {
          return { success: false, output: '会话压缩能力未配置。请注入 compact capability 后再执行。' };
        }
        return { success: true, output: await ctx.capabilities.compact(ctx) };
      }
    });

    // 5. /export - 导出
    this.register({
      name: 'export',
      description: '导出全过程 (html, markdown, jsonl)',
      argumentHint: '<html|markdown|jsonl>',
      handler: (ctx) => {
        const fmt = (ctx.args[0] || 'html').toLowerCase();
        if (fmt !== 'html' && fmt !== 'markdown' && fmt !== 'jsonl') {
          return { success: false, output: `不支持的导出格式 '${fmt}'。可选值: html, markdown, jsonl` };
        }
        if (!ctx.capabilities?.export) {
          return { success: false, output: '导出能力未配置。请注入 export capability 后再执行。' };
        }
        return Promise.resolve(ctx.capabilities.export(fmt, ctx)).then((output) => ({ success: true, output }));
      }
    });

    // 6. /stats - 查看统计
    this.register({
      name: 'stats',
      description: '查看本会话交互统计与模型用量',
      handler: (ctx) => {
        const msgCount = ctx.agent?.state.messages.length ?? 0;
        return {
          success: true,
          output: `📊 会话统计:\n- 交互消息数: ${msgCount}\n- 模型: ${ctx.agent?.state.model?.name || '默认'}\n- 思考级别: ${ctx.agent?.state.thinkingLevel || 'low'}`
        };
      }
    });

    // 7. /help - 帮助
    this.register({
      name: 'help',
      description: '查看所有支持的斜杠指令清单',
      handler: () => {
        const list = this.getAll()
          .map((c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''} - ${c.description}`)
          .join('\n');
        return { success: true, output: `✨ InkPi 指令清单:\n${list}` };
      }
    });
  }
}
