import type { SkillInfo } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { InstructionRegistry, ProgressiveSkillRuntime } from '@inkpi/agent-core';

describe('progressive skills and instruction registry', () => {
  it('exposes skill metadata first and loads the prompt body on demand', () => {
    const runtime = new ProgressiveSkillRuntime();
    const skill: SkillInfo = {
      name: 'continuity',
      description: 'Audit story continuity',
      filePath: '.inkpi/skills/continuity.md',
      frontmatter: { capability: 'continuity-audit' },
      promptBody: 'Full continuity instructions',
    };
    runtime.registerSkill(skill);
    expect(runtime.discover()).toEqual([{ name: 'continuity', description: 'Audit story continuity', loaded: false }]);
    expect(runtime.load('continuity').promptBody).toBe('Full continuity instructions');
    expect(runtime.listLoaded()).toEqual(['continuity']);
    expect(runtime.getExtensionApi()).toBe(runtime.extensionHost);
  });

  it('composes enabled instructions by priority within a character budget', () => {
    const registry = new InstructionRegistry();
    registry.register({ id: 'base', scope: 'system', content: 'base', priority: 1 });
    registry.register({ id: 'task', scope: 'task', content: 'task', priority: 10, tags: ['creative'] });
    registry.register({ id: 'disabled', scope: 'extension', content: 'skip', enabled: false });
    expect(registry.compose({ tags: ['creative'] })).toMatchObject({ text: 'task', entryIds: ['task'] });
    expect(registry.compose({ maxCharacters: 5 })).toMatchObject({ text: 'task', truncated: true });
  });
});
