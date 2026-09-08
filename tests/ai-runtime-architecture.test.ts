import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0 dependency guards for the generic Runtime packages.
 *
 * These checks inspect import specifiers rather than arbitrary identifiers.
 * Domain words in generic field names, comments, fixtures, or user-facing
 * strings are not architecture dependencies.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const INKPI_ROOT = path.resolve(TEST_DIR, '..');
const AGENT_CORE_SRC = path.join(INKPI_ROOT, 'packages', 'agent-core', 'src');
const PROTOCOL_SRC = path.join(INKPI_ROOT, 'packages', 'protocol', 'src');
const STORAGE_SRC = path.join(INKPI_ROOT, 'packages', 'storage', 'src');

const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /(?:\.test|\.spec)\.(?:ts|tsx)$/;
const CREATIVE_DOMAIN_NAMES = ['novel', 'character', 'chapter', 'foreshadow'] as const;

type ImportRule = (specifier: string) => boolean;

function listSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractImportSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g
  ];

  for (const pattern of patterns) {
    for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function matchesCreativeDomainSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/').split(/[?#]/, 1)[0];
  const segments = normalized.split('/');
  return segments.some((segment) => {
    const name = segment.replace(/\.(?:[cm]?[jt]sx?)$/i, '').toLowerCase();
    return CREATIVE_DOMAIN_NAMES.some(
      (domainName) => name === domainName || name.startsWith(`${domainName}-`) || name.startsWith(`${domainName}_`)
    );
  });
}

function matchesDesktopSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/').toLowerCase();
  return (
    normalized === '@inkpi/desktop' ||
    normalized.startsWith('@inkpi/desktop/') ||
    normalized === '@inkpi/desktop-domain' ||
    normalized.startsWith('@inkpi/desktop-domain/') ||
    normalized === '@inkpi/creative-domain' ||
    normalized.startsWith('@inkpi/creative-domain/') ||
    normalized.includes('inkpi-desktop') ||
    normalized.includes('desktop-domain') ||
    normalized.includes('creative-domain') ||
    /(?:^|\/)desktop(?:\/|$)/.test(normalized)
  );
}

function collectViolations(root: string, rule: ImportRule): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(root)) {
    const relativeFile = path.relative(root, file).split(path.sep).join('/');
    const matches = new Set(extractImportSpecifiers(fs.readFileSync(file, 'utf8')).filter(rule));
    for (const specifier of matches) {
      violations.push(`${relativeFile} -> ${specifier}`);
    }
  }
  return violations.sort();
}

describe('AI Runtime Phase 0 architecture guards', () => {
  it('agent-core does not import Creative Domain modules', () => {
    const violations = collectViolations(AGENT_CORE_SRC, matchesCreativeDomainSpecifier);
    expect(violations, `agent-core Creative Domain imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('protocol does not import desktop modules', () => {
    const violations = collectViolations(PROTOCOL_SRC, matchesDesktopSpecifier);
    expect(violations, `protocol desktop imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('storage does not import desktop domain modules', () => {
    const violations = collectViolations(STORAGE_SRC, matchesDesktopSpecifier);
    expect(violations, `storage desktop-domain imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the import scanner detects each forbidden boundary in a synthetic sample', () => {
    const sample = `
      import type { Novel } from '@inkpi/novel';
      import { DesktopState } from '../inkpi-desktop/src/domain/state';
      const lazy = () => import('@inkpi/desktop');
    `;
    const specifiers = extractImportSpecifiers(sample);

    expect(specifiers).toContain('@inkpi/novel');
    expect(specifiers).toContain('../inkpi-desktop/src/domain/state');
    expect(specifiers).toContain('@inkpi/desktop');
    expect(matchesCreativeDomainSpecifier('@inkpi/novel')).toBe(true);
    expect(matchesDesktopSpecifier('../inkpi-desktop/src/domain/state')).toBe(true);
    expect(matchesDesktopSpecifier('@inkpi/desktop')).toBe(true);
    expect(matchesDesktopSpecifier('@inkpi/creative-domain')).toBe(true);
  });
});
