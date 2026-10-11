import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from '../bin/project-config.js';

describe('project config', () => {
  let projectRoot: string | undefined;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  it('loads config from a Unicode path containing spaces', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'inkpi config 中文-'));
    writeFileSync(
      join(projectRoot, 'inkpi.config.json'),
      JSON.stringify({
        name: 'novel project',
        version: '1.0.0',
        typography: { mode: 'chinese', indentString: '\u3000\u3000' },
        defaultModel: 'deepseek-chat',
        plugins: []
      })
    );

    expect(loadProjectConfig(projectRoot)).toMatchObject({
      name: 'novel project',
      defaultModel: 'deepseek-chat',
      typography: { mode: 'chinese' }
    });
  });

  it('reports malformed JSON and invalid field values with the config path', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'inkpi config-'));
    const configPath = join(projectRoot, 'inkpi.config.json');
    writeFileSync(configPath, '{ invalid json');
    expect(() => loadProjectConfig(projectRoot)).toThrow(`Unable to read ${configPath}`);

    writeFileSync(configPath, JSON.stringify({ defaultModel: '', typography: { mode: 'ansi' } }));
    expect(() => loadProjectConfig(projectRoot)).toThrow(/defaultModel must be a non-empty string/);
    expect(() => loadProjectConfig(projectRoot)).toThrow(/typography\.mode must be one of/);
  });

  it('returns undefined when the workspace has no project config', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'inkpi config-'));
    expect(loadProjectConfig(projectRoot)).toBeUndefined();
  });
});
