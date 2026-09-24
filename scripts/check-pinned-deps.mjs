#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

// Optional argument points the check at another workspace root; that is how
// tests/pinned-dependencies.test.ts feeds it fixtures without touching the repo.
const rootDir = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const problems = [];

console.log('[Supply-Chain Hardening] Verifying pinned dependencies across monorepo...');

checkPackageJson(path.join(rootDir, 'package.json'));
const pkgsDir = path.join(rootDir, 'packages');
if (fs.existsSync(pkgsDir)) {
  for (const dir of fs.readdirSync(pkgsDir)) {
    checkPackageJson(path.join(pkgsDir, dir, 'package.json'));
  }
}

if (!['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].some((name) => fs.existsSync(path.join(rootDir, name)))) {
  problems.push(`${rootDir}: no lockfile found, dependency resolution is not pinned`);
}

for (const problem of problems) console.error(`  ❌ ${problem}`);
if (problems.length > 0) {
  console.error(`❌ Supply chain dependency check failed (${problems.length} problem(s)).`);
  process.exit(1);
}
console.log('✅ Supply chain dependency check completed successfully.');

function checkPackageJson(pkgPath) {
  if (!fs.existsSync(pkgPath)) return;
  const content = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const relPath = path.relative(rootDir, pkgPath);

  for (const label of DEPENDENCY_FIELDS) {
    const deps = content[label];
    if (!deps || typeof deps !== 'object') continue;
    for (const [dep, version] of Object.entries(deps)) {
      if (dep.startsWith('@inkpi/')) continue; // internal workspace packages resolve locally
      if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
        problems.push(`${relPath} ${label} '${dep}': '${version}' is not an exact version`);
      }
    }
  }
}
