import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runPrintMode } from '@inkpi/agent-core';

describe('InkPi Print Mode (Non-interactive batch mode)', () => {
  const tmpOut = path.join(os.tmpdir(), 'inkpi-tmp-print-test.txt');

  it('should run single-shot generation with a generic default role', async () => {
    const res = await runPrintMode({
      prompt: '请写一段开篇介绍',
      model: 'mock-test',
      json: true
    });

    expect(res.success).toBe(true);
    expect(res.role).toBe('assistant');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    const resNonJson = await runPrintMode({
      prompt: '非 JSON 模式',
      model: 'mock-test',
      json: false
    });
    expect(resNonJson.success).toBe(true);
  });


  it('should run multi-agent pipeline in print mode and write output file', async () => {
    const res = await runPrintMode({
      prompt: '请构建第一章大纲并撰写正文',
      role: 'pipeline',
      model: 'mock-test',
      output: tmpOut,
      workflow: {
        stages: [
          {
            id: 'outline',
            name: 'Outline',
            executor: async () => 'outline result'
          },
          {
            id: 'scene',
            name: 'Scene',
            promptTemplate: (ctx) => `${ctx.stageOutputs.outline}: ${ctx.userPrompt}`,
            executor: async (ctx) => `scene result for ${ctx.stageOutputs.outline}`
          }
        ]
      }
    });

    expect(res.success).toBe(true);
    expect(res.role).toBe('pipeline');
    expect(res.content).toBe('scene result for outline result');
    expect(fs.readFileSync(tmpOut, 'utf8')).toBe('scene result for outline result');

    // Clean up
    fs.unlinkSync(tmpOut);
  });

  it('should handle errors gracefully in print mode', async () => {
    const res = await runPrintMode({
      prompt: '测试错误处理',
      role: 'pipeline',
      model: 'mock-test',
      output: '/invalid_dir_path_that_fails/output.txt',
      workflow: {
        stages: [{
          id: 'single',
          name: 'Single',
          executor: async () => 'real workflow output'
        }]
      },
      json: false
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();

    const jsonError = await runPrintMode({
      prompt: '测试 JSON 错误',
      role: 'pipeline',
      model: 'mock-test',
      output: '/invalid_dir_path_that_fails/output.txt',
      workflow: {
        stages: [{
          id: 'single',
          name: 'Single',
          executor: async () => 'real workflow output'
        }]
      },
      json: true
    });
    expect(jsonError.success).toBe(false);
  });

  it('should reject implicit legacy narrative stages in pipeline print mode', async () => {
    const result = await runPrintMode({
      prompt: 'generic batch request',
      role: 'pipeline',
      model: 'mock-test'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('explicit workflow configuration');
  });

  it('should reject an API key without an explicit model instead of selecting one', async () => {
    const original = { ...process.env };
    try {
      for (const key of ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
        delete process.env[key];
      }
      process.env.DEEPSEEK_API_KEY = 'deliberately-invalid-test-key';
      delete process.env.INKPI_DEEPSEEK_MODEL;

      const result = await runPrintMode({ prompt: 'configuration probe' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('INKPI_DEEPSEEK_MODEL');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in original)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(original)) process.env[key] = value;
    }
  });


  it('should write output file in writer mode', async () => {
    const tmpFile = path.join(os.tmpdir(), 'inkpi-tmp-writer-test.txt');
    const res = await runPrintMode({
      prompt: '写入文件测试',
      model: 'mock-test',
      output: tmpFile
    });
    expect(res.success).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(true);
    fs.unlinkSync(tmpFile);
  });

  it('should support custom systemPrompt and thinkingLevel', async () => {
    const res = await runPrintMode({
      prompt: '自定义设定测试',
      model: 'mock-test',
      systemPrompt: '自定义提示词',
      thinkingLevel: 'high',
      json: true
    });
    expect(res.success).toBe(true);
  });

  it('should throw error when no model and no API key is provided outside test env', async () => {


    const oldNodeEnv = process.env.NODE_ENV;
    const oldVitest = process.env.VITEST;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      const res = await runPrintMode({ prompt: 'test missing provider', json: false });
      expect(res.success).toBe(false);
      expect(res.error).toContain('No AI model configuration found');
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
      process.env.VITEST = oldVitest;
    }
  });

  it('should run workflow with json output and custom role configuration', async () => {
    const tmpJsonOut = path.join(os.tmpdir(), 'inkpi-tmp-workflow-json.txt');
    const res = await runPrintMode({
      prompt: 'workflow with json and custom role',
      role: 'pipeline',
      model: 'mock-test',
      output: tmpJsonOut,
      json: true,
      workflow: {
        stages: [
          {
            id: 'step1',
            name: 'Step 1',
            executor: async () => 'step1 completed'
          }
        ]
      }
    });

    expect(res.success).toBe(true);
    expect(res.content).toBe('step1 completed');
    expect(fs.readFileSync(tmpJsonOut, 'utf8')).toBe('step1 completed');
    fs.unlinkSync(tmpJsonOut);
  });

  it('should support editor and auditor roles in print mode', async () => {
    const editorRes = await runPrintMode({
      prompt: '润色文本',
      role: 'editor',
      model: 'mock-test',
      json: true
    });
    expect(editorRes.success).toBe(true);
    expect(editorRes.role).toBe('editor');

    const auditorRes = await runPrintMode({
      prompt: '审查文本',
      role: 'auditor',
      model: 'mock-test',
      json: false
    });
    expect(auditorRes.success).toBe(true);
    expect(auditorRes.role).toBe('auditor');

    // Workflow with non-JSON output (hits result.content + '\n')
    const wfNonJson = await runPrintMode({
      prompt: '非 json 工作流',
      role: 'pipeline',
      model: 'mock-test',
      json: false,
      workflow: {
        stages: [{ id: 's', name: 'Stage', executor: async () => 'pipeline completed text' }]
      }
    });
    expect(wfNonJson.success).toBe(true);
    expect(wfNonJson.content).toBe('pipeline completed text');
  });
});
