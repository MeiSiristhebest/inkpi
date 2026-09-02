import type { AgentRoleConfig, WorkflowStageConfig } from '@inkpi/protocol';
import type { RoleRegistry } from './roles.js';

/**
 * 流水线阶段注册表：按 id 去重的可变阶段序列。
 */
export class StageRegistry {
  private stages: WorkflowStageConfig[];

  constructor(initial: WorkflowStageConfig[] = []) {
    this.stages = [...initial];
  }

  /** 注册或按 id 覆盖已有阶段。 */
  public register(config: WorkflowStageConfig): this {
    const existingIdx = this.stages.findIndex((s) => s.id === config.id);
    if (existingIdx !== -1) {
      this.stages[existingIdx] = config;
    } else {
      this.stages.push(config);
    }
    return this;
  }

  /** 返回当前阶段序列的副本，防止调用方就地改动注册表。 */
  public list(): WorkflowStageConfig[] {
    return [...this.stages];
  }

  public get size(): number {
    return this.stages.length;
  }
}

/**
 * 把 `overrides` 合并进 `base`：同 id 覆盖，新 id 追加。
 *
 * `runPipeline` 用它把调用方注册的阶段叠加到遗留叙事阶段序列之上。
 * 纯函数：不修改任何入参数组。
 */
export function mergeStageLists(
  base: WorkflowStageConfig[],
  overrides: WorkflowStageConfig[]
): WorkflowStageConfig[] {
  const merged = [...base];
  for (const stage of overrides) {
    const index = merged.findIndex((candidate) => candidate.id === stage.id);
    if (index >= 0) merged[index] = stage;
    else merged.push(stage);
  }
  return merged;
}

/**
 * 解析阶段执行所用的角色配置。
 *
 * 阶段可内联 `AgentRoleConfig`（此时注册表不参与），也可给角色名字符串
 * （此时查注册表）；查不到时回落到由阶段自身字段构造的临时角色。
 * 纯函数：不修改任何入参。
 */
export function resolveStageRole(
  stage: WorkflowStageConfig,
  registry: RoleRegistry
): AgentRoleConfig {
  if (typeof stage.role === 'object' && stage.role !== null) {
    return stage.role;
  }
  const roleId = typeof stage.role === 'string' ? stage.role : stage.id;
  return (
    registry.get(roleId) || {
      role: roleId,
      name: stage.name,
      systemPrompt: stage.systemPrompt || ''
    }
  );
}

/** 阶段声明的执行角色 id，用于 `customExecutor` 的 role 形参。 */
export function resolveStageRoleId(stage: WorkflowStageConfig): string {
  return typeof stage.role === 'string' ? stage.role : (stage.role?.role || stage.id);
}
