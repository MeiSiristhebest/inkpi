import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkGeneratedArtifacts,
  renderGeneratedArtifacts,
  writeGeneratedArtifacts
} from '../scripts/generate-config-reference.mjs';

describe('generated configuration reference', () => {
  it('renders deterministic artifacts and detects drift without writing during checks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-config-reference-'));
    try {
      const artifacts = renderGeneratedArtifacts();
      expect([...renderGeneratedArtifacts()]).toEqual([...artifacts]);
      expect(await checkGeneratedArtifacts(root, artifacts)).toEqual([...artifacts.keys()]);
      expect(readdirSync(root)).toEqual([]);

      await writeGeneratedArtifacts(root, artifacts);
      await writeGeneratedArtifacts(root, renderGeneratedArtifacts());
      expect(await checkGeneratedArtifacts(root, artifacts)).toEqual([]);

      const configSchemaPath = join(root, 'schemas', 'inkpi.config.schema.json');
      const originalSchema = readFileSync(configSchemaPath, 'utf8');
      writeFileSync(configSchemaPath, 'drift');
      expect(await checkGeneratedArtifacts(root, artifacts)).toContain('schemas/inkpi.config.schema.json');
      expect(readFileSync(configSchemaPath, 'utf8')).toBe('drift');
      writeFileSync(configSchemaPath, originalSchema);

      const configSchema = JSON.parse(originalSchema);
      expect(configSchema.properties).toHaveProperty('typography');
      expect(configSchema.properties).toHaveProperty('$schema');
      expect(existsSync(resolve(root, './schemas/inkpi.config.schema.json'))).toBe(true);
      expect(existsSync(resolve(root, 'docs', '../schemas/model-catalog.schema.json'))).toBe(true);
      expect(readFileSync(join(root, 'docs', 'config-reference.md'), 'utf8')).toContain(
        './schemas/inkpi.config.schema.json'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
