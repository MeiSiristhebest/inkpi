/**
 * 集中弃用别名（P3-#19）。
 *
 * 约定：全仓库的兼容别名只允许出现在本文件中，统一标注 `@deprecated`
 * 与预计移除版本（v1.0）。每个别名必须指向唯一权威名称，且行为完全一致。
 * 新代码禁止使用本文件导出的任何名字。
 */
import { Agent } from './agent.js';
import { BranchExplorer } from './branch-what-if.js';
import { ExtensionInstaller } from './package-manager/package-manager.js';
import { SessionRegistry } from './rpc/session-registry.js';
import { WorkflowCoordinator } from './pipeline/coordinator.js';
import type { SlashCommandExecutor } from './slash-commands.js';
import type { TrustStoreFile } from './trust/project-trust.js';

/** @deprecated 已由 `Agent` 取代（同一实现）。计划移除版本：v1.0 */
export const AgentEngine = Agent;
export type AgentEngine = Agent;

/** @deprecated 已由 `BranchExplorer` 取代（业务前缀与 Manager 后缀移除）。计划移除版本：v1.0 */
export const StoryBranchManager = BranchExplorer;
export type StoryBranchManager = BranchExplorer;

/** @deprecated 已由 `ExtensionInstaller` 取代（其实际职责是安装/隔离扩展，非通用包管理）。计划移除版本：v1.0 */
export const ExtensionPackageManager = ExtensionInstaller;
export type ExtensionPackageManager = ExtensionInstaller;

/** @deprecated 已由 `SessionRegistry` 取代（其实际职责是多会话注册表，实现 SessionStore 端口）。计划移除版本：v1.0 */
export const LiveSessionManager = SessionRegistry;
export type LiveSessionManager = SessionRegistry;

/** @deprecated 已由 `WorkflowCoordinator` 取代（四个名字指向同一个类，保留唯一权威名）。计划移除版本：v1.0 */
export const NovelCollaborativePipeline = WorkflowCoordinator;
export type NovelCollaborativePipeline = WorkflowCoordinator;

/** @deprecated 已由 `WorkflowCoordinator` 取代。计划移除版本：v1.0 */
export const CollaborativePipeline = WorkflowCoordinator;
export type CollaborativePipeline = WorkflowCoordinator;

/** @deprecated 已由 `WorkflowCoordinator` 取代。计划移除版本：v1.0 */
export const PipelineCoordinator = WorkflowCoordinator;
export type PipelineCoordinator = WorkflowCoordinator;

/** @deprecated 已由 `SlashCommandExecutor` 取代（handler 后缀未能表达"执行命令"语义）。计划移除版本：v1.0 */
export type SlashCommandHandler = SlashCommandExecutor;

/** @deprecated 已由 `TrustStoreFile` 取代（该结构描述的是磁盘上信任存储文件的形状，非抽象数据）。计划移除版本：v1.0 */
export type TrustStoreData = TrustStoreFile;
