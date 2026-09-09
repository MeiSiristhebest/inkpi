import { InstructionRegistry, type TaskHandlerContext } from '@inkpi/agent-core';
import { AssistantEventStream, type ModelConfig } from '@inkpi/ai';
import type { AgentMessage, AiTask, SkillInfo } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';
import { TaskModelHandler } from './task-model-handler.js';

const model: ModelConfig = {
  id: 'instruction-test-model',
  name: 'Instruction test model',
  provider: 'faux'
};

const definition = {
  id: 'plugin.demo.analysis',
  version: '1',
  taskKind: 'plugin.demo.analysis',
  systemInstruction: 'Use the stable demo instruction.'
};

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'instruction-task',
    kind: definition.taskKind,
    input: { text: 'context' },
    outputContract: { format: 'text' },
    metadata: { instruction: 'Dynamic metadata must not be appended.' },
    ...overrides
  };
}

function streamThatReturns(text: string, seen?: AgentMessage[][]) {
  return (_model: ModelConfig, messages: AgentMessage[]) => {
    seen?.push([...messages]);
    const stream = new AssistantEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'text_delta', textDelta: text });
      stream.end();
    });
    return stream;
  };
}

describe('daemon InstructionRegistry RPC', () => {
  const daemons: InkPiDaemon[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  });

  it('registers definitions idempotently and exposes list/status through RPC', async () => {
    const registry = new InstructionRegistry();
    const daemon = new InkPiDaemon({ instructionRegistry: registry });
    daemons.push(daemon);
    const rpc = daemon.getRpcServer();

    const first = await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'instruction.register',
      params: { instruction: definition }
    });
    const second = await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'instruction.register',
      params: { instructions: [definition] }
    });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect((first.result as { added: string[] }).added).toEqual([definition.id]);
    expect((second.result as { unchanged: string[] }).unchanged).toEqual([definition.id]);
    expect(daemon.getInstructionRegistry()).toBe(registry);
    expect(registry.list()).toHaveLength(1);

    const listed = await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'instruction.list',
      params: { taskKind: definition.taskKind }
    });
    const status = await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'instruction.status'
    });

    expect(listed.result).toEqual([
      expect.objectContaining({
        id: definition.id,
        version: definition.version,
        content: definition.systemInstruction,
        tags: [`task:${definition.taskKind}`]
      })
    ]);
    expect(status.result).toMatchObject({
      ready: true,
      count: 1,
      instructionIds: [definition.id]
    });
  });

  it('passes registry instructions to TaskModelHandler without duplicating metadata prompt text', async () => {
    const daemon = new InkPiDaemon();
    daemons.push(daemon);
    const seen: AgentMessage[][] = [];
    daemon.getTaskRouter().registry.register(
      new TaskModelHandler({
        model,
        stream: streamThatReturns('completed', seen),
        defaultModelCapabilities: { outputFormats: ['text'] }
      })
    );

    await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'instruction.register',
      params: { instruction: definition }
    });
    await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'task.submit',
      params: { task: makeTask() }
    });

    const result = await daemon.getTaskRouter().wait('instruction-task');
    const prompt = String(seen[0][0].content);

    expect(prompt).toContain(`Stable skill instruction:\n${definition.systemInstruction}`);
    expect(prompt).not.toContain('Dynamic metadata must not be appended.');
    expect(prompt.match(/Use the stable demo instruction\./g)).toHaveLength(1);
    expect(result.provenance).toMatchObject({
      instructionIds: [definition.id],
      instructionVersion: expect.stringMatching(/^instructions-/)
    });
  });

  it('exposes process-safe skill metadata through the shared daemon runtime', async () => {
    const daemon = new InkPiDaemon();
    daemons.push(daemon);
    const skill: SkillInfo = {
      name: 'rpc-skill',
      description: 'A skill exposed through RPC',
      filePath: 'rpc-skill.md',
      frontmatter: {
        id: 'rpc-skill',
        version: '2.0.0',
        activation: 'on-demand',
        capabilities: ['rpc-test']
      },
      promptBody: 'This body must stay in the Runtime process.'
    };
    daemon.getSkillRuntime().registerSkill(skill);

    const status = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'skill.status'
    });
    expect(status.result).toMatchObject({
      protocolVersion: 'skill-runtime.v1',
      skills: [expect.objectContaining({ id: skill.name, version: '2.0.0' })],
      loadedSkills: [],
      activatedSkills: []
    });
    expect(JSON.stringify(status.result)).not.toContain(skill.promptBody);

    const loaded = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'skill.load',
      params: { skillId: skill.name }
    });
    expect(loaded.result).toMatchObject({
      loaded: true,
      skill: expect.objectContaining({ id: skill.name }),
      snapshot: { loadedSkills: [skill.name] }
    });
  });

  it('puts public task intent next to the stable instruction', async () => {
    const seen: AgentMessage[][] = [];
    const handler = new TaskModelHandler({
      model,
      stream: streamThatReturns('intent', seen),
      defaultModelCapabilities: { outputFormats: ['text'] }
    });
    const context: TaskHandlerContext = {
      task: makeTask({
        id: 'intent-task',
        intent: '保持冷峻语气',
        metadata: {}
      }),
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'intent-context',
        truncated: false
      },
      instructions: {
        text: definition.systemInstruction,
        entryIds: [definition.id],
        truncated: false,
        version: 'instructions-1'
      },
      signal: new AbortController().signal,
      executionRunId: 'run:intent-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    };

    await handler.execute(context);

    const prompt = String(seen[0][0].content);
    expect(prompt).toContain(`Stable skill instruction:\n${definition.systemInstruction}`);
    expect(prompt).toContain('User intent:\n保持冷峻语气');
  });

  it('uses metadata instruction only as an explicit fallback for an unregistered task', async () => {
    const seen: AgentMessage[][] = [];
    const handler = new TaskModelHandler({
      model,
      stream: streamThatReturns('fallback', seen),
      defaultModelCapabilities: { outputFormats: ['text'] }
    });
    const context: TaskHandlerContext = {
      task: makeTask({ id: 'unregistered-task', kind: 'unregistered.kind' }),
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'empty-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:unregistered-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    };

    await handler.execute(context);

    expect(String(seen[0][0].content)).toContain(
      'Legacy skill instruction fallback:\nDynamic metadata must not be appended.'
    );
  });
});
