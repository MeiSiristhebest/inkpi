import type { ExtensionHost, TaskHandler, TaskRegistry, ToolRegistry } from '@inkpi/agent-core';
import type { AgentTool, ToolRegistrationOptions } from '@inkpi/protocol';
import {
  CREATIVE_FIRST_PARTY_TOOL_NAMES,
  CREATIVE_FIRST_PARTY_WORKFLOW_KINDS,
  createCreativeFirstPartyExtension
} from './extensions/creative-first-party.js';

export {
  CREATIVE_FIRST_PARTY_EXTENSION_ID,
  CREATIVE_FIRST_PARTY_TOOL_NAMES,
  CREATIVE_FIRST_PARTY_WORKFLOW_KINDS,
  createCreativeFirstPartyExtension
} from './extensions/creative-first-party.js';

/** Runtime-owned tool names for the default creative extension. */
export const FIRST_PARTY_RUNTIME_TOOL_NAMES = CREATIVE_FIRST_PARTY_TOOL_NAMES;

/** Runtime-owned workflow kinds for the default creative extension. */
export const FIRST_PARTY_RUNTIME_WORKFLOW_KINDS = CREATIVE_FIRST_PARTY_WORKFLOW_KINDS;

/**
 * Generic Server-side extension descriptor.
 *
 * The registrar only knows how to place these capabilities in the existing
 * ExtensionHost, ToolRegistry, and TaskRegistry. Domain behavior belongs to
 * the extension factory that supplies the descriptor.
 */
export interface RuntimeExtensionDescriptor {
  readonly id: string;
  readonly tools?: readonly AgentTool[];
  readonly workflows?: readonly TaskHandler[];
  readonly toolRegistration?: ToolRegistrationOptions;
}

export type RuntimeExtensionFactory = () => RuntimeExtensionDescriptor;

export interface FirstPartyPluginRuntimeOptions {
  readonly toolRegistry: ToolRegistry;
  readonly taskRegistry: TaskRegistry;
  readonly extensionHost?: ExtensionHost;
  /** Explicit extension factories replace the default creative extension. */
  readonly extensions?: readonly RuntimeExtensionFactory[];
}

export interface FirstPartyPluginRuntimeRegistration {
  readonly toolNames: readonly string[];
  readonly workflowKinds: readonly string[];
  dispose(): void;
}

interface RegisteredTool {
  name: string;
  tool: AgentTool;
}

interface RegisteredWorkflow {
  id: string;
  handler: TaskHandler;
}

const DEFAULT_TOOL_REGISTRATION: ToolRegistrationOptions = {
  source: 'first-party-plugin-runtime',
  capabilities: ['first-party-plugin', 'offline']
};

const DEFAULT_EXTENSION_FACTORIES: readonly RuntimeExtensionFactory[] = [createCreativeFirstPartyExtension];

/**
 * Register Server extensions through the one shared Runtime registry path.
 *
 * Registration is idempotent with respect to an already-owned name. Existing
 * host or runtime registrations are never overwritten, and dispose only
 * removes registrations created by this call.
 */
export function registerFirstPartyPluginRuntime(
  options: FirstPartyPluginRuntimeOptions
): FirstPartyPluginRuntimeRegistration {
  const extensions = (options.extensions ?? DEFAULT_EXTENSION_FACTORIES).map((factory, index) =>
    normalizeExtension(factory(), index)
  );
  const registeredTools: RegisteredTool[] = [];
  const registeredWorkflows: RegisteredWorkflow[] = [];

  for (const extension of extensions) {
    const registration = extension.toolRegistration ?? DEFAULT_TOOL_REGISTRATION;
    for (const tool of extension.tools ?? []) {
      const existingRuntimeTool = options.toolRegistry.get(tool.name);
      const existingHostTool = options.extensionHost?.getTools().find((candidate) => candidate?.name === tool.name);
      if (existingRuntimeTool || existingHostTool) continue;

      options.extensionHost?.registerTool(tool, registration);
      try {
        options.toolRegistry.register(tool, registration);
      } catch (error) {
        options.extensionHost?.unregisterTool(tool.name);
        throw error;
      }
      registeredTools.push({ name: tool.name, tool });
    }

    for (const handler of extension.workflows ?? []) {
      if (options.taskRegistry.list().some((candidate) => candidate.id === handler.id)) continue;
      options.taskRegistry.register(handler);
      registeredWorkflows.push({ id: handler.id, handler });
    }
  }

  const toolNames = unique(extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)));
  const workflowKinds = unique(
    extensions.flatMap((extension) =>
      (extension.workflows ?? []).flatMap((handler) => (handler.kinds ? [...handler.kinds] : []))
    )
  );

  return {
    toolNames,
    workflowKinds,
    dispose: () => {
      for (const { name, tool } of [...registeredTools].reverse()) {
        if (options.toolRegistry.get(name) === tool) options.toolRegistry.unregister(name);
        const hostTool = options.extensionHost?.getTools().find((candidate) => candidate?.name === name);
        if (hostTool === tool) options.extensionHost?.unregisterTool(name);
      }
      for (const { id, handler } of [...registeredWorkflows].reverse()) {
        if (options.taskRegistry.list().find((candidate) => candidate.id === id) === handler) {
          options.taskRegistry.unregister(id);
        }
      }
    }
  };
}

function normalizeExtension(extension: RuntimeExtensionDescriptor, index: number): RuntimeExtensionDescriptor {
  if (!extension || typeof extension.id !== 'string' || extension.id.trim().length === 0) {
    throw new Error(`Runtime extension factory at index ${index} returned an invalid id`);
  }
  const tools = extension.tools ?? [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.trim().length === 0) {
      throw new Error(`Runtime extension '${extension.id}' contains a tool without a name`);
    }
  }
  const workflows = extension.workflows ?? [];
  for (const handler of workflows) {
    if (!handler || typeof handler.id !== 'string' || handler.id.trim().length === 0) {
      throw new Error(`Runtime extension '${extension.id}' contains a workflow without an id`);
    }
  }
  return { ...extension, id: extension.id.trim(), tools, workflows };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
