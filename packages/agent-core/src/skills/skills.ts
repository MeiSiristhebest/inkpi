import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SkillInfo } from '@inkpi/protocol';

const MAX_FRONTMATTER_BYTES = 1024 * 1024;

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  promptBody: string;
}

interface PendingList {
  key: string;
  indent: number;
  values: unknown[];
  sawItem: boolean;
}

/**
 * Parse a skill Markdown file, including its prompt body.
 *
 * The parser intentionally implements the small YAML subset needed by skill
 * manifests. It supports quoted scalars, booleans, numbers, flow arrays, and
 * indented list arrays without adding a runtime YAML dependency.
 */
export function parseSkillMarkdown(content: string, filePath: string): SkillInfo | null {
  const parsed = parseSkillDocument(content, true);
  if (!parsed) return null;

  return toSkillInfo(parsed.frontmatter, parsed.promptBody, filePath);
}

/**
 * Parse only the frontmatter portion of a skill Markdown file.
 *
 * The returned body is always empty so callers can discover manifests without
 * retaining or exposing the full prompt instructions.
 */
export function parseSkillMetadata(content: string, filePath: string): SkillInfo | null {
  const parsed = parseSkillDocument(content, false);
  if (!parsed) return null;

  return toSkillInfo(parsed.frontmatter, '', filePath);
}

function parseSkillDocument(content: string, includePromptBody: boolean): ParsedFrontmatter | null {
  const source = content.replace(/^\uFEFF/, '').trimStart();
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;

  const closingIndex = lines.findIndex((line, index) => index > 0 && isClosingDelimiter(line));
  if (closingIndex === -1) return null;

  return {
    frontmatter: parseYamlSubset(lines.slice(1, closingIndex)),
    promptBody: includePromptBody ? lines.slice(closingIndex + 1).join('\n').trim() : '',
  };
}

function isClosingDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '---' || trimmed === '...';
}

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  let pendingList: PendingList | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const listItem = pendingList && indent > pendingList.indent ? /^-\s*(.*)$/.exec(trimmed) : null;
    if (listItem && pendingList) {
      if (!pendingList.sawItem) {
        pendingList.values.length = 0;
        frontmatter[pendingList.key] = pendingList.values;
        pendingList.sawItem = true;
      }
      pendingList.values.push(parseYamlValue(listItem[1]));
      continue;
    }

    pendingList = undefined;
    const colonIndex = findMappingColon(line);
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    if (!key) continue;

    const rawValue = line.slice(colonIndex + 1).trim();
    if (!rawValue) {
      frontmatter[key] = '';
      pendingList = { key, indent, values: [], sawItem: false };
      continue;
    }

    frontmatter[key] = parseYamlValue(rawValue);
  }

  return frontmatter;
}

function findMappingColon(line: string): number {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && character === ':') return index;
  }

  return -1;
}

function parseYamlValue(rawValue: string): unknown {
  const value = stripInlineComment(rawValue).trim();
  if (!value) return '';

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowValues(inner).map(parseYamlValue);
  }

  if (isQuoted(value)) return unquote(value);

  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || lower === '~') return null;

  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }

  return value;
}

function stripInlineComment(value: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }

  return value;
}

function splitFlowValues(value: string): string[] {
  const values: string[] = [];
  let start = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted || doubleQuoted) continue;

    if (character === '[') squareDepth += 1;
    if (character === ']') squareDepth -= 1;
    if (character === '{') curlyDepth += 1;
    if (character === '}') curlyDepth -= 1;
    if (character === ',' && squareDepth === 0 && curlyDepth === 0) {
      values.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  values.push(value.slice(start).trim());
  return values.filter(Boolean);
}

function isQuoted(value: string): boolean {
  if (value.length < 2) return false;
  const quote = value[0];
  return (quote === '"' || quote === "'") && value[value.length - 1] === quote;
}

function unquote(value: string): string {
  const quote = value[0];
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.replace(/''/g, "'");

  try {
    return JSON.parse(value) as string;
  } catch {
    return inner.replace(/\\([\\"'nrt])/g, (_match, escapedCharacter: string) => {
      const escapes: Record<string, string> = { '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t' };
      return escapes[escapedCharacter] ?? escapedCharacter;
    });
  }
}

function toSkillInfo(frontmatter: Record<string, unknown>, promptBody: string, filePath: string): SkillInfo {
  const fallbackName = basename(filePath).replace(/\.skill\.md$|\.md$/i, '');
  const name = nonEmptyString(frontmatter.name) ?? fallbackName;
  const description = scalarToString(frontmatter.description) ?? '';

  return {
    name,
    description,
    filePath,
    frontmatter,
    promptBody,
  };
}

function scalarToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

function nonEmptyString(value: unknown): string | undefined {
  const stringValue = scalarToString(value)?.trim();
  return stringValue || undefined;
}

export class SkillDiscoveryEngine {
  private readonly searchDirs: string[];
  private readonly cachedSkills = new Map<string, SkillInfo>();

  constructor(searchDirs: string[] = []) {
    this.searchDirs = [...searchDirs];
  }

  public addSearchDir(dir: string): void {
    if (!this.searchDirs.includes(dir)) this.searchDirs.push(dir);
  }

  /**
   * Recursively discover only skill metadata. Prompt bodies are read later by
   * loadSkill so directory discovery stays cheap for large skill libraries.
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
      const entries = readdirSync(dir).sort((left, right) => left.localeCompare(right));
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          this.scanDirectory(fullPath);
        } else if (entry.endsWith('.md') || entry.endsWith('.skill.md')) {
          const header = readFrontmatterHeader(fullPath);
          if (!header) continue;
          const skill = parseSkillMetadata(header, fullPath);
          if (skill) this.cachedSkills.set(skill.name, skill);
        }
      }
    } catch {
      // A disappearing or unreadable search directory should not abort discovery.
    }
  }

  public getSkill(name: string): SkillInfo | undefined {
    return this.cachedSkills.get(name);
  }

  /** Load one prompt body after metadata discovery has selected the skill. */
  public loadSkill(name: string): SkillInfo | undefined {
    const metadata = this.cachedSkills.get(name);
    if (!metadata) return undefined;

    try {
      const loaded = parseSkillMarkdown(readFileSync(metadata.filePath, 'utf-8'), metadata.filePath);
      if (loaded) this.cachedSkills.set(name, loaded);
      return loaded || metadata;
    } catch {
      return metadata;
    }
  }

  public getAll(): SkillInfo[] {
    return Array.from(this.cachedSkills.values());
  }
}

function readFrontmatterHeader(filePath: string): string | null {
  let fileDescriptor = -1;
  try {
    fileDescriptor = openSync(filePath, 'r');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(16 * 1024);
    let position = 0;
    let source = '';

    while (source.length <= MAX_FRONTMATTER_BYTES) {
      const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      source += decoder.write(buffer.subarray(0, bytesRead));
      if (hasClosingDelimiter(source)) return source;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fileDescriptor !== -1) closeSync(fileDescriptor);
  }
}

function hasClosingDelimiter(source: string): boolean {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  return lines[0]?.trim() === '---' && lines.some((line, index) => index > 0 && isClosingDelimiter(line));
}
