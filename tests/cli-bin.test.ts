import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('InkPi CLI Executable Binary (bin/inkpi.js)', () => {
  const binPath = resolve(__dirname, '../bin/inkpi.js');

  it('should print version upon --version flag', () => {
    const output = execSync(`node "${binPath}" --version`, { encoding: 'utf8' });
    expect(output).toContain('InkPi v1.0.0');
  });

  it('should print help text upon --help flag', () => {
    const output = execSync(`node "${binPath}" --help`, { encoding: 'utf8' });
    expect(output).toContain('USAGE:');
    expect(output).toContain('COMMANDS:');
    expect(output).toContain('studio');
    expect(output).toContain('daemon');
    expect(output).toContain('doctor');
  });

  it('should execute doctor diagnostics', () => {
    const output = execSync(`node "${binPath}" doctor`, { encoding: 'utf8' });
    expect(output).toContain('InkPi System & Environment Diagnostics');
    expect(output).toContain('Node.js Version:');
    expect(output).toContain('SQLite Engine:');
  });
});
