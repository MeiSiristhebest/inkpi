import type { AgentRoleConfig } from '@inkpi/protocol';

/** 纯字符串角色 ID 类型，不预设任何固定名称，由用户动态注册 */
export type RoleType = string;
/** @deprecated 请使用 RoleType。NovelRoleType 保留仅为向后兼容，无固定取值约束。 */
export type NovelRoleType = string;

export interface RoleRegistryOptions {
  initialRoles?: Record<string, AgentRoleConfig>;
}

/** 默认参考角色集 (纯空字典，完全由用户/项目/技能动态注册) */
export const DEFAULT_ROLE_CONFIGS: Record<string, AgentRoleConfig> = {};
export const NOVEL_ROLE_CONFIGS = DEFAULT_ROLE_CONFIGS;
export type NovelRoleConfig = AgentRoleConfig;

/**
 * 纯通用 Agent 角色注册表 (100% 动态化，零业务/人设偏见)
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
