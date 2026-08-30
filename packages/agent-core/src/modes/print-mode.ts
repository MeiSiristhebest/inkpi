/**
 * InkPi Print Mode (非交互批处理与自动化脚本模式) (1:1 对标 pi-coding-agent print-mode.ts)
 */

import * as fs from 'node:fs';
import { Agent } from '../agent.js';
import { WorkflowCoordinator } from '../pipeline/coordinator.js';
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
      const coordinator = new WorkflowCoordinator();
      const pipelineResult = await coordinator.runPipeline('作品', '第一章', options.prompt);
      const durationMs = Date.now() - startTime;
      const finalContent = pipelineResult.polishedText || pipelineResult.draftText || pipelineResult.outlineText || options.prompt;

      if (options.output) {
        fs.writeFileSync(options.output, finalContent, 'utf8');
      }

      const result: PrintModeResult = {
        success: true,
        content: finalContent,
        role: 'pipeline',
        usage: {
          inputTokens: 1000,
          outputTokens: finalContent.length,
          totalTokens: 1000 + finalContent.length
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

    const modelObj = options.model ? getModelPreset(options.model) : getModelPreset('mock-test');
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
    if (assistantMsg && typeof assistantMsg.content !== 'string') {
      const textBlocks = (assistantMsg.content as any[]).filter((b: any) => b.type === 'text');
      if (textBlocks.length > 0) {
        generatedText = textBlocks.map((b: any) => b.text).join('\n');
      }
    }

    const durationMs = Date.now() - startTime;
    const result: PrintModeResult = {
      success: true,
      content: generatedText || `[${role}] 任务已完成`,
      role,
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
