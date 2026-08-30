import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPrintMode } from '@inkpi/agent-core';

describe('InkPi Print Mode (Non-interactive batch mode)', () => {
  const tmpOut = path.join(process.cwd(), 'tmp-print-test.txt');

  it('should run single-shot generation for writer role', async () => {
    const res = await runPrintMode({
      prompt: '请写一段开篇介绍',
      role: 'writer',
      json: true
    });

    expect(res.success).toBe(true);
    expect(res.role).toBe('writer');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should run multi-agent pipeline in print mode and write output file', async () => {
    const res = await runPrintMode({
      prompt: '请构建第一章大纲并撰写正文',
      role: 'pipeline',
      output: tmpOut
    });

    expect(res.success).toBe(true);
    expect(res.role).toBe('pipeline');
    expect(fs.existsSync(tmpOut)).toBe(true);
    const content = fs.readFileSync(tmpOut, 'utf8');
    expect(content.length).toBeGreaterThan(0);

    // Clean up
    fs.unlinkSync(tmpOut);
  });

  it('should handle errors gracefully in print mode', async () => {
    const res = await runPrintMode({
      prompt: '测试错误处理',
      role: 'pipeline',
      output: '/invalid_dir_path_that_fails/output.txt',
      json: false
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();

    const jsonError = await runPrintMode({
      prompt: '测试 JSON 错误',
      role: 'pipeline',
      output: '/invalid_dir_path_that_fails/output.txt',
      json: true
    });
    expect(jsonError.success).toBe(false);
  });
});
