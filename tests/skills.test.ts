import { describe, it, expect } from 'vitest';
import { parseSkillMarkdown, SkillDiscoveryEngine } from '@meisiristhebest/agent-core';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('@meisiristhebest/agent-core -> Skills System (YAML Frontmatter & Discovery, 1:1 Ported from repos/pi)', () => {
  it('should parse YAML Frontmatter and extract prompt body', () => {
    const rawMarkdown = `---
name: standard-combat-guide
description: 仙侠打斗与招式动author细化指南
version: 1.0.0
category: standard
---
在描写仙侠打斗时，请遵循以下法则：
1. 每一击必须交代借力、灵力流向与声光特效；
2. 招式碰撞后必须有环境反馈破坏（如山体崩裂、剑气碎石）；
3. 决战时刻凸显主角意志与心境升华。
`;

    const skill = parseSkillMarkdown(rawMarkdown, '/mock/path/standard.skill.md');
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('standard-combat-guide');
    expect(skill?.description).toBe('仙侠打斗与招式动author细化指南');
    expect(skill?.frontmatter.category).toBe('standard');
    expect(skill?.promptBody).toContain('招式碰撞后必须有环境反馈破坏');
  });

  it('should recursively discover skills in directories', () => {
    const tempDir = join(tmpdir(), `inkpi_skills_test_${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const skillFile = join(tempDir, 'detective.md');
    writeFileSync(
      skillFile,
      `---
name: detective-clues
description: 悬疑探案Task布设指南
---
在每一document结尾留下微观疑点。
`
    );

    try {
      const engine = new SkillDiscoveryEngine([tempDir]);
      const discovered = engine.discover();

      expect(discovered.length).toBe(1);
      expect(discovered[0].name).toBe('detective-clues');
      expect(engine.getSkill('detective-clues')?.description).toBe('悬疑探案Task布设指南');
      expect(engine.getAll().length).toBe(1);

      engine.addSearchDir(tempDir); // duplicate branch
      engine.addSearchDir('/non/existent/path'); // non-existent dir branch
      expect(engine.discover().length).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle malformed frontmatter and fallback name parsing gracefully', () => {
    expect(parseSkillMarkdown('no frontmatter here', '/path/to/skill.md')).toBeNull();
    expect(parseSkillMarkdown('---\nno closing delimiter', '/path/to/skill.md')).toBeNull();

    // No name provided -> derived from filename
    const fallbackSkill = parseSkillMarkdown('---\ndescription: test\ninvalid line\n---\nPrompt body', '/path/to/custom-skill.md');
    expect(fallbackSkill).not.toBeNull();
    expect(fallbackSkill?.name).toBe('custom-skill');
    expect(fallbackSkill?.description).toBe('test');
    expect(fallbackSkill?.promptBody).toBe('Prompt body');
  });
});
