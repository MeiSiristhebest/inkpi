import type { AgentRoleConfig } from '@inkpi/protocol';

export type RoleType = string;
export type NovelRoleType = 'architect' | 'writer' | 'auditor' | 'polisher' | string;

export interface RoleRegistryOptions {
  initialRoles?: Record<string, AgentRoleConfig>;
}

/** 默认参考角色集 (支持通过 RoleRegistry 自由覆盖与拓展) */
export const DEFAULT_ROLE_CONFIGS: Record<string, AgentRoleConfig> = {
  architect: {
    role: 'architect',
    name: '架构大纲规划 (Architect)',
    description: '负责结构规划、核心矛盾与关键节点把控。',
    defaultThinkingLevel: 'high',
    systemPrompt: '你是一位专业的架构师，负责规划核心细纲、矛盾冲突与起伏节点。'
  },
  writer: {
    role: 'writer',
    name: '正文主笔作家 (Writer)',
    description: '负责将细纲展开为生动的正文描写。',
    defaultThinkingLevel: 'medium',
    systemPrompt: '你是一位专业的主笔作家，负责展开高质量正文描写。'
  },
  auditor: {
    role: 'auditor',
    name: '设定一致性审计员 (Auditor)',
    description: '负责核对设定账本与上下文逻辑一致性。',
    defaultThinkingLevel: 'high',
    systemPrompt: '你是一位专业的逻辑与设定审计员，负责核查正文是否符合前文设定与状态账本。'
  },
  polisher: {
    role: 'polisher',
    name: '格式排版校对官 (Polisher)',
    description: '负责排版规范化与文字润色。',
    defaultThinkingLevel: 'low',
    systemPrompt: '你是一位专业的文字校对官，负责规范中文排版、消除错别字与提升韵律。'
  }
};

export const NOVEL_ROLE_CONFIGS = DEFAULT_ROLE_CONFIGS;
export type NovelRoleConfig = AgentRoleConfig;

/**
 * 纯通用 Agent 角色注册表 (零业务偏见，支持动态注册任意 Agent 角色)
 */
export class RoleRegistry {
  private roles = new Map<string, AgentRoleConfig>();

  constructor(options: RoleRegistryOptions = {}) {
    const roles = options.initialRoles || DEFAULT_ROLE_CONFIGS;
    for (const [key, role] of Object.entries(roles)) {
      this.register(key, role);
    }
  }

  public register(roleId: string, config: AgentRoleConfig): void {
    this.roles.set(roleId, config);
  }

  public get(roleId: string): AgentRoleConfig | undefined {
    return this.roles.get(roleId);
  }

  public getAll(): AgentRoleConfig[] {
    return Array.from(this.roles.values());
  }

  public has(roleId: string): boolean {
    return this.roles.has(roleId);
  }
}
