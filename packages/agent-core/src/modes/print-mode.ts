/**
 * InkPi Print Mode (非交互批处理与自动化脚本模式) (1:1 对标 pi-coding-agent print-mode.ts)
 */

import * as fs from 'node:fs';
import { Agent } from '../agent.js';
import { WorkflowCoordinator } from '../pipeline/coordinator.js';
import { TelemetryCollector } from '../telemetry/telemetry.js';
import { getModelPreset } from '@inkpi/ai';

import type { ThinkingLevel } from '@inkpi/protocol';

export interface PrintModeOptions {
  prompt: string;
  role?: 'architect' | 'writer' | 'auditor' | 'polisher' | 'pipeline';
  model?: string;
  thinkingLevel?: ThinkingLevel;
  json?: boolean;
  output?: string;
  systemPrompt?: string;
}

export interface PrintModeResult {
  success: boolean;
  content: string;
  role: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  durationMs: number;
  error?: string;
}

export async function runPrintMode(options: PrintModeOptions): Promise<PrintModeResult> {
  const startTime = Date.now();
  const role = options.role || 'writer';

  try {
    if (role === 'pipeline') {
      const telemetry = new TelemetryCollector();
      const coordinator = new WorkflowCoordinator({ telemetry });
      const pipelineResult = await coordinator.runPipeline('Project', 'Unit', options.prompt);
      const durationMs = Date.now() - startTime;
      const finalContent = pipelineResult.polishedText || pipelineResult.draftText || pipelineResult.outlineText || options.prompt;

      if (options.output) {
        fs.writeFileSync(options.output, finalContent, 'utf8');
      }

      const spans = telemetry.getSpans();
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      for (const s of spans) {
        if (s.inputTokens) totalInputTokens += s.inputTokens;
        if (s.outputTokens) totalOutputTokens += s.outputTokens;
      }


      const result: PrintModeResult = {
        success: true,
        content: finalContent,
        role: 'pipeline',
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens
        },
        durationMs
      };


      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(finalContent + '\n');
      }

      return result;
    }

    let modelObj: any;
    if (options.model) {
      modelObj = getModelPreset(options.model);
    } else if (process.env.DEEPSEEK_API_KEY) {
      modelObj = getModelPreset('deepseek-chat');
    } else if (process.env.OPENROUTER_API_KEY) {
      modelObj = getModelPreset('creative-pro');
    } else if (process.env.OPENAI_API_KEY) {
      modelObj = getModelPreset('creative-pro');
    } else if (process.env.ANTHROPIC_API_KEY) {
      modelObj = getModelPreset('creative-pro');
    } else if (process.env.GEMINI_API_KEY) {
      modelObj = getModelPreset('creative-pro');
    } else {
      if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
        modelObj = getModelPreset('mock-test');
      } else {
        throw new Error(
          '缺少有效的 AI 模型提供商配置。请配置环境变量 (如 DEEPSEEK_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)、通过命令行传入 --api-key <key>，或启动本地 Ollama 并使用 --model local-offline。'
        );
      }
    }


    const agent = new Agent({
      initialState: {
        model: modelObj,
        thinkingLevel: options.thinkingLevel || 'low',
        systemPrompt: options.systemPrompt || `你是一位专精的 ${role} 创作 Agent。`
      }
    });


    let generatedText = '';
    let hasStreamedToStdout = false;

    agent.subscribe((event) => {
      if (event.type === 'message_update') {
        const ev = (event as any).assistantMessageEvent;
        if (ev && !options.json) {
          if (ev.type === 'thinking_delta' && ev.thinkingDelta) {
            process.stdout.write(`\x1b[36m${ev.thinkingDelta}\x1b[0m`);
            hasStreamedToStdout = true;
          } else if (ev.type === 'text_delta' && ev.textDelta) {
            process.stdout.write(ev.textDelta);
            hasStreamedToStdout = true;
          }
        }
        if (event.message?.role === 'assistant') {
          const textBlocks = event.message.content.filter((b: any) => b.type === 'text');
          generatedText = textBlocks.map((b: any) => b.text).join('\n');
        }
      }
    });

    await agent.prompt(options.prompt);

    const assistantMsg = agent.state.messages.slice().reverse().find(m => m.role === 'assistant');
    let realUsage: Usage | undefined;
    if (assistantMsg) {
      if (typeof assistantMsg.content !== 'string') {
        const textBlocks = (assistantMsg.content as any[]).filter((b: any) => b.type === 'text');
        if (textBlocks.length > 0) {
          generatedText = textBlocks.map((b: any) => b.text).join('\n');
        }
      }
      if ((assistantMsg as any).usage) {
        realUsage = (assistantMsg as any).usage;
      }
    }

    const durationMs = Date.now() - startTime;
    const result: PrintModeResult = {
      success: true,
      content: generatedText || `[${role}] 任务已完成`,
      role,
      usage: realUsage,
      durationMs
    };



    if (options.output) {
      fs.writeFileSync(options.output, result.content, 'utf8');
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (hasStreamedToStdout) {
      process.stdout.write('\n');
    } else {
      process.stdout.write(result.content + '\n');
    }

    return result;

  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorResult: PrintModeResult = {
      success: false,
      content: '',
      role,
      durationMs,
      error: err.message || String(err)
    };

    if (options.json) {
      process.stdout.write(JSON.stringify(errorResult, null, 2) + '\n');
    } else {
      process.stderr.write(`❌ [InkPi Print Error] ${errorResult.error}\n`);
    }

    return errorResult;
  }
}
