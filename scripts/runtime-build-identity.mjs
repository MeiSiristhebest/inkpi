import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function getRuntimeBuildIdentity(rootDir) {
  const skillManifestHash = hashSkillManifests(join(rootDir, 'skills'));
  let runtimeCommit = 'unknown';

  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(commit) && !dirty) runtimeCommit = commit;
  } catch {
    // A source archive without Git metadata cannot claim an exact commit.
  }

  return { runtimeCommit, skillManifestHash };
}

function hashSkillManifests(skillsDir) {
  const files = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`No skill manifests found in ${skillsDir}`);

  const hash = createHash('sha256');
  for (const name of files) {
    const source = readFileSync(join(skillsDir, name), 'utf8').replace(/\r\n?/g, '\n');
    hash.update(name, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(source, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}
