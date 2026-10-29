import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateProjectConfig } from './project-config-schema.js';

export function loadProjectConfig(projectRoot = process.cwd()) {
  const configPath = resolve(projectRoot, 'inkpi.config.json');
  if (!existsSync(configPath)) return undefined;

  let value;
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${configPath}: ${detail}`);
  }

  const errors = validateProjectConfig(value);
  if (errors.length > 0) {
    throw new Error(`Invalid ${configPath}: ${errors.join('; ')}`);
  }

  return value;
}
