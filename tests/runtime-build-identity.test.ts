import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRuntimeBuildIdentity } from '../scripts/runtime-build-identity.mjs';

describe('Runtime build identity', () => {
  it('pins the exact clean commit and hashes normalized Skill manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-runtime-identity-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, 'zeta.md'), 'Zeta\r\n', 'utf8');
    writeFileSync(join(skillsDir, 'alpha.md'), 'Alpha\n', 'utf8');

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Runtime identity test',
          '-c',
          'user.email=runtime-identity@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'identity fixture'
        ],
        { cwd: root, stdio: 'ignore' }
      );

      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const expectedHash = createHash('sha256').update('alpha.md\0Alpha\n\0zeta.md\0Zeta\n\0', 'utf8').digest('hex');
      const identity = getRuntimeBuildIdentity(root);

      expect(identity).toEqual({ runtimeCommit: commit, skillManifestHash: expectedHash });

      writeFileSync(join(skillsDir, 'alpha.md'), 'Changed\n', 'utf8');
      expect(getRuntimeBuildIdentity(root).runtimeCommit).toBe('unknown');
      expect(getRuntimeBuildIdentity(root).skillManifestHash).not.toBe(expectedHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
