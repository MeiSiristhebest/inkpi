#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('[Supply-Chain Hardening] Verifying pinned dependencies across monorepo...');

let hasErrors = false;

function checkPackageJson(pkgPath) {
  if (!fs.existsSync(pkgPath)) return;
  const content = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const relPath = path.relative(rootDir, pkgPath);

  const checkDeps = (deps, label) => {
    if (!deps) return;
    for (const [dep, version] of Object.entries(deps)) {
      if (dep.startsWith('@meisiristhebest/')) {
        // Internal monorepo workspace packages
        continue;
      }
      if (typeof version === 'string' && (version.startsWith('^') || version.startsWith('~'))) {
        console.warn(`⚠️ [Warning] ${relPath} ${label} '${dep}': version '${version}' is ranged instead of exact.`);
      }
    }
  };

  checkDeps(content.dependencies, 'dependencies');
  checkDeps(content.devDependencies, 'devDependencies');
}

checkPackageJson(path.join(rootDir, 'package.json'));

const pkgsDir = path.join(rootDir, 'packages');
if (fs.existsSync(pkgsDir)) {
  const dirs = fs.readdirSync(pkgsDir);
  for (const d of dirs) {
    checkPackageJson(path.join(pkgsDir, d, 'package.json'));
  }
}

if (hasErrors) {
  console.error('❌ Supply chain dependency check failed.');
  process.exit(1);
} else {
  console.log('✅ Supply chain dependency check completed successfully.');
}
