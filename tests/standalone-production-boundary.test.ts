import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const standaloneSource = readFileSync(resolve(__dirname, '..', 'scripts', 'inkpi-standalone.mjs'), 'utf8');

describe('standalone production provider boundary', () => {
  it('loads test doubles only for the explicit mock-test model', () => {
    expect(standaloneSource).toMatch(
      /if\s*\(explicitModel\s*===\s*['"]mock-test['"]\)\s*\{\s*const\s*\{\s*installTestDoubles\s*\}\s*=\s*await\s*import\([^\n]+test-fixtures\.js['"]\);\s*installTestDoubles\(\);\s*\}/
    );
    expect(standaloneSource).not.toMatch(/from\s*['"][^'"]*test-fixtures\.js['"]/);
  });
});
