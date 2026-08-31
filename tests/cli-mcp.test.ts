import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('InkPi CLI & MCP Diagnostics', () => {
  const rootDir = path.resolve(__dirname, '..');

  it('should run inkpi version successfully', () => {
    const output = execSync('node ./bin/inkpi.mjs version', { cwd: rootDir, encoding: 'utf8' });
    expect(output).toContain('inkpi v1.0.0');
  });

  it('should run inkpi doctor successfully', () => {
    const output = execSync('node ./bin/inkpi.mjs doctor', { cwd: rootDir, encoding: 'utf8' });
    expect(output).toContain('InkPi Environment is healthy');
    expect(output).toContain('@inkpi/session-backends');
    expect(output).toContain('@inkpi/server');
    expect(output).toContain('@inkpi/client');
  });

  it('should run inkpi help successfully', () => {
    const output = execSync('node ./bin/inkpi.mjs help', { cwd: rootDir, encoding: 'utf8' });
    expect(output).toContain('Usage: inkpi <command>');
    expect(output).toContain('daemon');
    expect(output).toContain('mcp');
  });
});
