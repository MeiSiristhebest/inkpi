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

    const resNonJson = await runPrintMode({
      prompt: '非 JSON 模式',
      role: 'writer',
      json: false
    });
    expect(resNonJson.success).toBe(true);
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

  it('should resolve models dynamically from environment variables', async () => {
    // 1. DeepSeek
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    const resDeepSeek = await runPrintMode({ prompt: 'test deepseek' });
    expect(resDeepSeek).toBeDefined();
    delete process.env.DEEPSEEK_API_KEY;

    // 2. OpenRouter
    process.env.OPENROUTER_API_KEY = 'sk-test-openrouter';
    const resOpenRouter = await runPrintMode({ prompt: 'test openrouter' });
    expect(resOpenRouter).toBeDefined();
    delete process.env.OPENROUTER_API_KEY;

    // 3. OpenAI
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const resOpenAi = await runPrintMode({ prompt: 'test openai' });
    expect(resOpenAi).toBeDefined();
    delete process.env.OPENAI_API_KEY;

    // 4. Anthropic
    process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
    const resAnthropic = await runPrintMode({ prompt: 'test anthropic' });
    expect(resAnthropic).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;

    // 5. Gemini
    process.env.GEMINI_API_KEY = 'sk-test-gemini';
    const resGemini = await runPrintMode({ prompt: 'test gemini' });
    expect(resGemini).toBeDefined();
    delete process.env.GEMINI_API_KEY;
  });


  it('should write output file in writer mode', async () => {
    const tmpFile = path.join(process.cwd(), 'tmp-writer-test.txt');
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
      const res = await runPrintMode({ prompt: 'test missing provider', json: true });
      expect(res.success).toBe(false);
      expect(res.error).toContain('缺少有效的 AI 模型提供商配置');
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
      process.env.VITEST = oldVitest;
    }
  });
});

