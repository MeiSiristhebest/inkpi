import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The supply-chain gate is only worth running if it can fail. Before this test
// existed, check-pinned-deps.mjs printed warnings and always exited 0, so
// `pnpm run check` reported a pinning audit that audited nothing.
// ---------------------------------------------------------------------------

const script = path.resolve(__dirname, '..', 'scripts', 'check-pinned-deps.mjs');
const repoRoot = path.resolve(__dirname, '..');
const fixtures: string[] = [];

function runChecker(root: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

function dependencyFixture(dependencies: Record<string, unknown>, options: { lockfile?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'inkpi-pinned-deps-'));
  fixtures.push(dir);
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-workspace', version: '1.0.0', dependencies }, null, 2)
  );
  if (options.lockfile !== false) {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  }
  return dir;
}

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

describe('pinned dependency gate', () => {
  it('passes for the real monorepo', () => {
    const result = runChecker(repoRoot);
    expect(result.output).toContain('completed successfully');
    expect(result.status).toBe(0);
  });

  it.each([
    ['caret range', '^1.2.3'],
    ['tilde range', '~1.2.3'],
    ['wildcard', '*'],
    ['dist-tag', 'latest']
  ])('rejects %s as an unpinned version', (_label, version) => {
    const result = runChecker(dependencyFixture({ 'some-dep': version }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('some-dep');
    expect(result.output).toContain(version);
  });

  it('rejects unpinned devDependencies and optionalDependencies', () => {
    const dir = dependencyFixture({});
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture-workspace',
          devDependencies: { 'tool-one': '^2.0.0' },
          optionalDependencies: { 'tool-two': '>=3.0.0' }
        },
        null,
        2
      )
    );
    const result = runChecker(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('tool-one');
    expect(result.output).toContain('tool-two');
  });

  it('exempts internal workspace packages', () => {
    const result = runChecker(dependencyFixture({ '@inkpi/protocol': 'workspace:*' }));
    expect(result.status).toBe(0);
  });

  it('fails when the workspace has no lockfile', () => {
    const result = runChecker(dependencyFixture({ 'some-dep': '1.2.3' }, { lockfile: false }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('no lockfile');
  });
});
