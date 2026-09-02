import {
  // 权威名称
  Agent,
  // 弃用别名
  AgentEngine,
  BranchExplorer,
  CollaborativePipeline,
  ExtensionInstaller,
  ExtensionPackageManager,
  LiveSessionManager,
  NovelCollaborativePipeline,
  PipelineCoordinator,
  ProjectTrustManager,
  ProjectTrustStore,
  SandboxExecutor,
  SandboxManager,
  SessionRegistry,
  SessionShareExporter,
  SessionShareManager,
  StoryBranchManager,
  WorkflowCoordinator
} from '@inkpi/agent-core';
import type {
  HypothesisBranchInfo,
  HypothesisExecutiveReport,
  ISandboxRunner,
  SandboxRunner,
  WhatIfBranchInfo,
  WhatIfExecutiveReport
} from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

/**
 * P3-#19：集中弃用别名（src/deprecations.ts）的兼容性守卫。
 * 保证别名仍指向唯一权威实现；v1.0 移除别名时删除本测试的对应断言即可。
 */
describe('deprecations: 集中别名与权威名称同址', () => {
  it('AgentEngine === Agent', () => {
    expect(AgentEngine).toBe(Agent);
  });

  it('StoryBranchManager === BranchExplorer', () => {
    expect(StoryBranchManager).toBe(BranchExplorer);
  });

  it('ExtensionPackageManager === ExtensionInstaller', () => {
    expect(ExtensionPackageManager).toBe(ExtensionInstaller);
  });

  it('LiveSessionManager === SessionRegistry', () => {
    expect(LiveSessionManager).toBe(SessionRegistry);
  });

  it('三个管线旧名 === WorkflowCoordinator', () => {
    expect(NovelCollaborativePipeline).toBe(WorkflowCoordinator);
    expect(CollaborativePipeline).toBe(WorkflowCoordinator);
    expect(PipelineCoordinator).toBe(WorkflowCoordinator);
  });

  it('SessionTree.addBranchMarker 与弃用 branch() 行为一致', async () => {
    const { SessionTree } = await import('@inkpi/agent-core');
    const t1 = new SessionTree();
    const t2 = new SessionTree();
    const viaNew = t1.addBranchMarker('推演点A', '假设A');
    const viaOld = t2.branch('推演点A', '假设A');
    // 两者行为逐字一致：都追加一条 branch 标记消息并返回新叶子节点
    expect(viaNew.id).toBe(viaOld.id);
    expect(viaNew.message).toEqual(viaOld.message);
    expect(t1.getCurrentLeafId()).toBe(t2.getCurrentLeafId());
  });

  it('SandboxManager === SandboxExecutor（Manager 后缀空泛改名）', () => {
    expect(SandboxManager).toBe(SandboxExecutor);
    expect(new SandboxManager()).toBeInstanceOf(SandboxExecutor);
  });

  it('ProjectTrustManager === ProjectTrustStore', () => {
    expect(ProjectTrustManager).toBe(ProjectTrustStore);
  });

  it('SessionShareManager === SessionShareExporter', () => {
    expect(SessionShareManager).toBe(SessionShareExporter);
  });

  it('类型别名与权威名同构（WhatIf*/ISandboxRunner）', () => {
    const b1: HypothesisBranchInfo = null as unknown as HypothesisBranchInfo;
    const b2: WhatIfBranchInfo = b1;
    const r1: HypothesisExecutiveReport = null as unknown as HypothesisExecutiveReport;
    const r2: WhatIfExecutiveReport = r1;
    const s1: SandboxRunner = null as unknown as SandboxRunner;
    const s2: ISandboxRunner = s1;
    expect(b2).toBeNull();
    expect(r2).toBeNull();
    expect(s2).toBeNull();
  });
});
