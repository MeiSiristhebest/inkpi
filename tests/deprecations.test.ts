import { describe, expect, it } from 'vitest';
import {
  // 权威名称
  Agent,
  BranchExplorer,
  ExtensionInstaller,
  SessionRegistry,
  WorkflowCoordinator,
  // 弃用别名
  AgentEngine,
  StoryBranchManager,
  ExtensionPackageManager,
  LiveSessionManager,
  NovelCollaborativePipeline,
  CollaborativePipeline,
  PipelineCoordinator
} from '@inkpi/agent-core';

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
});
