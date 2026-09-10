import type { ToolRegistrationDescriptor } from './extensions.js';
import type { InstructionReference } from './instructions.js';

/** Versioned wire contract for the Runtime-owned progressive skill surface. */
export const SKILL_RUNTIME_PROTOCOL_VERSION = 'skill-runtime.v1';

export type SkillActivation = 'eager' | 'lazy' | 'on-demand';

/** Metadata that is safe to expose before a skill body is loaded. */
export interface SkillManifest {
  id: string;
  version: string;
  title: string;
  description: string;
  intents?: string[];
  capabilities?: string[];
  taskKinds?: string[];
  tools?: string[];
  activation: SkillActivation;
}

export interface SkillRuntimeExtensionSnapshot {
  toolNames: string[];
  commandNames: string[];
  shortcutKeys: string[];
  pipelineHookCount: number;
}

/**
 * Process-safe Runtime registration state. Executable skill bodies, task
 * handlers, context providers, and tool functions are intentionally absent.
 */
export interface SkillRuntimeRegistrationSnapshot {
  protocolVersion: typeof SKILL_RUNTIME_PROTOCOL_VERSION;
  skills: SkillManifest[];
  loadedSkills: string[];
  activatedSkills: string[];
  tools: ToolRegistrationDescriptor[];
  tasks: string[];
  contextProviders: string[];
  extensionHost: SkillRuntimeExtensionSnapshot;
  instructionVersion?: string;
  instructions?: InstructionReference[];
}

export interface SkillResolveQuery {
  intent?: string;
  capability?: string;
  taskKind?: string;
  activation?: SkillActivation;
}

export type SkillDiscoverResult = SkillManifest[];
export type SkillResolveResult = SkillManifest[];

export interface SkillLoadParams {
  skillId: string;
}

export interface SkillActivateParams {
  skillId: string;
}

export interface SkillLoadResult {
  loaded: true;
  skill: SkillManifest;
  snapshot: SkillRuntimeRegistrationSnapshot;
}

export interface SkillActivationResult {
  activated: true;
  loaded: true;
  skill: SkillManifest;
  snapshot: SkillRuntimeRegistrationSnapshot;
}
