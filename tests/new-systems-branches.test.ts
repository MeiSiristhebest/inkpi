import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KillRing,
  ModelRegistry,
  ScopedModelResolver,
  SessionCompactor,
  SessionExporter,
  SkillDiscoveryEngine,
  TelemetryCollector,
  fuzzySearch,
  parseSkillMarkdown
} from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core -> New Systems In-Depth Branch Coverage Suite', () => {
  it('should test Skill discovery edge cases and parseSkillMarkdown invalid branches', () => {
    // 1. Invalid YAML frontmatter
    expect(parseSkillMarkdown('no frontmatter text', 'test.md')).toBeNull();
    expect(parseSkillMarkdown('---\nno closing delimiter', 'test.md')).toBeNull();

    // 2. Lines without colon in YAML
    const withBadLine = '---\nname: skill-1\njust a random line\ndescription: desc-1\n---\nPrompt body';
    const parsed = parseSkillMarkdown(withBadLine, 'skill-1.md');
    expect(parsed?.name).toBe('skill-1');
    expect(parsed?.description).toBe('desc-1');

    // 3. Engine non-existent directory & duplicate add
    const engine = new SkillDiscoveryEngine(['/non_existent_dir_12345']);
    engine.addSearchDir('/non_existent_dir_12345'); // Duplicate add check
    expect(engine.discover()).toEqual([]);
    expect(engine.getSkill('missing')).toBeUndefined();
    expect(engine.getAll()).toEqual([]);

    // 4. Nested directories in skill discovery
    const baseDir = join(tmpdir(), `nested_skills_${Date.now()}`);
    const subDir = join(baseDir, 'sub_category');
    mkdirSync(subDir, { recursive: true });

    writeFileSync(join(subDir, 'sub_skill.md'), '---\nname: nested-skill\ndescription: Nested skill desc\n---\nBody');

    try {
      engine.addSearchDir(baseDir);
      const all = engine.discover();
      expect(all.length).toBe(1);
      expect(engine.getSkill('nested-skill')).toBeDefined();
      expect(engine.getAll().length).toBe(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('should test TelemetryCollector with missing usage, no first token, and 0 tokens', () => {
    const collector = new TelemetryCollector(Date.now);
    collector.startTurn();

    // Usage undefined
    collector.recordUsage(undefined);

    // End turn without first token (TTFT = 0, cacheHitRate = 0)
    const stats = collector.endTurn();
    expect(stats.ttftMs).toBe(0);
    expect(stats.cacheHitRate).toBe(0);
    expect(stats.tokensPerSecond).toBe(0);
  });

  it('should test SessionExporter options and Markdown with thinking and tools', () => {
    const exporter = new SessionExporter();

    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '复杂指令' }]
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考逻辑' },
          { type: 'text', text: '正文回复' }
        ]
      }
    ];

    // HTML with includeThinking=false and includeToolCalls=false
    const html = exporter.exportToHtml(messages, {
      format: 'html',
      includeThinking: false,
      includeToolCalls: false
    });
    expect(html).not.toContain('推演思考');

    // Markdown export
    const md = exporter.exportToMarkdown(messages, { format: 'markdown' });
    expect(md).toContain('复杂指令');
    expect(md).toContain('思考逻辑');
  });

  it('should test SessionCompactor default options and short messages edge case', async () => {
    const defaultCompactor = new SessionCompactor({ clock: Date.now });
    const shortMessages: AgentMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    ];

    expect(defaultCompactor.shouldCompact(shortMessages)).toBe(false);

    await expect(
      defaultCompactor.compact([
        ...shortMessages,
        { role: 'user', content: 'more 1' },
        { role: 'assistant', content: [{ type: 'text', text: 'more 2' }] },
        { role: 'user', content: 'more 3' },
        { role: 'assistant', content: [{ type: 'text', text: 'more 4' }] },
        { role: 'user', content: 'more 5' }
      ])
    ).rejects.toThrow('explicit summarizer capability');
  });

  it('should test ModelRegistry & ScopedModelResolver unknown lookups and all scopes', () => {
    const registry = new ModelRegistry();
    expect(registry.get('totally_unknown_model_id')).toBeUndefined();
    expect(registry.getAll().length).toBeGreaterThan(0);

    const resolver = new ScopedModelResolver(registry, {
      scopeMappings: {
        polishing: 'creative-pro',
        linting: 'fast-draft',
        'fast-ghost': 'local-offline'
      }
    });
    expect(resolver.getRegistry()).toBe(registry);

    // Test all scopes
    expect(resolver.resolveForTask('polishing').id).toBe('deepseek-chat');
    expect(resolver.resolveForTask('linting').id).toBe('deepseek-chat');
    expect(resolver.resolveForTask('fast-ghost').id).toBe('qwen2.5:14b');
  });

  it('should test KillRing empty checks, eviction on max, and fuzzySearch with no query', () => {
    const kr = new KillRing(2); // max 2
    kr.push(''); // Empty string ignored
    expect(kr.size()).toBe(0);
    expect(kr.peek()).toBeUndefined();
    expect(kr.rotate()).toBeUndefined();

    kr.push('asset 1');
    kr.push('asset 2');
    kr.push('asset 3'); // asset 1 evicted
    expect(kr.size()).toBe(2);
    expect(kr.getAll()).toEqual(['asset 3', 'asset 2']);

    // FuzzySearch with empty query
    const assets = [{ name: '第一document' }, { name: '第二document' }];
    const all = fuzzySearch('', assets, (i) => i.name);
    expect(all.length).toBe(2);
    expect(all[0].score).toBe(0);
  });
});
