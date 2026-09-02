import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { SkillInfo } from '@inkpi/protocol';

/**
 * 轻量 YAML Frontmatter 解析器
 */
export function parseSkillMarkdown(content: string, filePath: string): SkillInfo | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlPart = trimmed.slice(3, endIdx).trim();
  const promptBody = trimmed.slice(endIdx + 4).trim();

  const frontmatter: Record<string, unknown> = {};
  const lines = yamlPart.split('\n');

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    frontmatter[key] = val;
  }

  const name = String(frontmatter.name || basename(filePath).replace(/\.(md|skill\.md)$/, ''));
  const description = String(frontmatter.description || '');

  return {
    name,
    description,
    filePath,
    frontmatter,
    promptBody
  };
}

export class SkillDiscoveryEngine {
  private searchDirs: string[];
  private cachedSkills = new Map<string, SkillInfo>();

  constructor(searchDirs: string[] = []) {
    this.searchDirs = searchDirs;
  }

  public addSearchDir(dir: string): void {
    if (!this.searchDirs.includes(dir)) {
      this.searchDirs.push(dir);
    }
  }

  /**
   * 递归扫描所有技能目录并加载技能
   */
  public discover(): SkillInfo[] {
    this.cachedSkills.clear();

    for (const dir of this.searchDirs) {
      if (!existsSync(dir)) continue;
      this.scanDirectory(dir);
    }

    return Array.from(this.cachedSkills.values());
  }

  private scanDirectory(dir: string): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          this.scanDirectory(fullPath);
        } else if (entry.endsWith('.md') || entry.endsWith('.skill.md')) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const skill = parseSkillMarkdown(content, fullPath);
            if (skill) {
              this.cachedSkills.set(skill.name, skill);
            }
          } catch {}
        }
      }
    } catch {}
  }

  public getSkill(name: string): SkillInfo | undefined {
    return this.cachedSkills.get(name);
  }

  public getAll(): SkillInfo[] {
    return Array.from(this.cachedSkills.values());
  }
}
