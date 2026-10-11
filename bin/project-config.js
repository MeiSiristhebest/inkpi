import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TYPOGRAPHY_MODES = new Set(['chinese', 'western', 'none']);

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

function validateProjectConfig(value) {
  if (!isRecord(value)) return ['the document must be a JSON object'];

  const errors = [];
  for (const key of ['name', 'version', 'defaultModel']) {
    if (key in value && (typeof value[key] !== 'string' || value[key].trim().length === 0)) {
      errors.push(`${key} must be a non-empty string`);
    }
  }

  if ('plugins' in value && (!Array.isArray(value.plugins) || value.plugins.some((plugin) => typeof plugin !== 'string'))) {
    errors.push('plugins must be an array of strings');
  }

  if ('typography' in value && value.typography !== false) {
    if (!isRecord(value.typography)) {
      errors.push('typography must be false or an object');
    } else {
      const { mode, indentString } = value.typography;
      if (mode !== undefined && (typeof mode !== 'string' || !TYPOGRAPHY_MODES.has(mode))) {
        errors.push(`typography.mode must be one of ${[...TYPOGRAPHY_MODES].join(', ')}`);
      }
      if (indentString !== undefined && typeof indentString !== 'string') {
        errors.push('typography.indentString must be a string');
      }
    }
  }

  return errors;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
