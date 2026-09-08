import type { SkillInfo } from '@inkpi/protocol';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InstructionRegistry, ProgressiveSkillRuntime, parseSkillMetadata, parseSkillMarkdown } from '@inkpi/agent-core';

const firstPartySkillsDir = fileURLToPath(new URL('../skills/', import.meta.url));

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

  it('parses typed frontmatter values without loading the body into metadata', () => {
    const rawMarkdown = `\uFEFF---
name: typed-skill
description: "A quoted: description # kept"
intents: [continue, "rewrite, carefully"]
capabilities:
  - narrative-hook
  - continuity-audit
taskKinds: ['creative.continue', narrative.continuity.audit]
enabled: true
priority: 7
maxTokens: 1024
---
Full prompt instructions
`;
    const metadata = parseSkillMetadata(rawMarkdown, 'typed-skill.md');

    expect(metadata?.frontmatter).toMatchObject({
      name: 'typed-skill',
      description: 'A quoted: description # kept',
      intents: ['continue', 'rewrite, carefully'],
      capabilities: ['narrative-hook', 'continuity-audit'],
      taskKinds: ['creative.continue', 'narrative.continuity.audit'],
      enabled: true,
      priority: 7,
      maxTokens: 1024,
    });
    expect(metadata?.promptBody).toBe('');

    const skill = parseSkillMarkdown(
      rawMarkdown,
      'typed-skill.md',
    );

    expect(skill?.promptBody).toBe('Full prompt instructions');
  });

  it('discovers first-party manifests by metadata and resolves them without eager body loading', () => {
    const runtime = new ProgressiveSkillRuntime({ searchDirs: [firstPartySkillsDir] });

    expect(runtime.discover()).toEqual([
      { name: 'character-voice', description: expect.any(String), loaded: false },
      { name: 'hook', description: expect.any(String), loaded: false },
      { name: 'promise', description: expect.any(String), loaded: false },
      { name: 'timeline-consistency', description: expect.any(String), loaded: false },
    ]);
    expect(runtime.listLoaded()).toEqual([]);

    const hook = runtime.resolve({ capability: 'narrative-hook', taskKind: 'creative.continue' });
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({
      id: 'hook',
      activation: 'on-demand',
      taskKinds: ['creative.continue', 'creative.rewrite'],
    });

    const eagerVoice = runtime.resolve({ capability: 'character-voice', activation: 'eager' });
    expect(eagerVoice.map((manifest) => manifest.id)).toEqual(['character-voice']);

    const timeline = runtime.resolve({ capability: 'timeline-consistency', taskKind: 'narrative.continuity.audit' });
    expect(timeline[0]).toMatchObject({ id: 'timeline-consistency', activation: 'on-demand' });
    expect(runtime.listLoaded()).toEqual([]);

    const loadedHook = runtime.load('hook');
    expect(loadedHook.promptBody).toContain('strongest');
    expect(runtime.listLoaded()).toEqual(['hook']);
    expect(runtime.discover().find((entry) => entry.name === 'hook')?.loaded).toBe(true);
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
