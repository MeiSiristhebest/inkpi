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
    systemPrompt: '你是一位专业的文字校对官，负责规范排版、消除错别字与提升韵律。'
  },
  screenwriter: {
    role: 'screenwriter',
    name: '影视编剧 (Screenwriter)',
    description: '负责影视/剧本场景划分、对白打磨与动作指示。',
    defaultThinkingLevel: 'high',
    systemPrompt: '你是一位专业影视编剧，精通三幕剧结构、场景对白与动作提示规范。'
  },
  storyboarder: {
    role: 'storyboarder',
    name: '分镜提示架构师 (Storyboarder)',
    description: '负责将剧本拆解为镜头语言、景别、机位与画面构图描述。',
    defaultThinkingLevel: 'medium',
    systemPrompt: '你是一位资深分镜师，负责规划镜头景别、视线引导与视觉节奏。'
  },
  script_doctor: {
    role: 'script_doctor',
    name: '剧本医生 (Script Doctor)',
    description: '负责诊断节奏拖沓、动机断裂、人物弧光缺失与对白生硬问题。',
    defaultThinkingLevel: 'high',
    systemPrompt: '你是一位专业剧本医生，负责深度诊断情节漏洞、节奏起伏与人物逻辑。'
  },
  worldbuilder: {
    role: 'worldbuilder',
    name: '世界观架构师 (Worldbuilder)',
    description: '负责设计严谨的技术/魔法法则、地理气候、历史编年史与势力图谱。',
    defaultThinkingLevel: 'high',
    systemPrompt: '你是一位世界观架构师，负责构建逻辑自洽的世界底层法则与社会生态。'
  },
  character_designer: {
    role: 'character_designer',
    name: '人物设计师 (Character Designer)',
    description: '负责人物小传、动机欲望、说话风格与人际关系图谱构建。',
    defaultThinkingLevel: 'medium',
    systemPrompt: '你是一位专业的人物设计师，负责刻画具有深度弧光与独特声音的人物设定。'
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
