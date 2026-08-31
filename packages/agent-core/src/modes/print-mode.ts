/**
 * InkPi Print Mode (非交互批处理与自动化脚本模式) (1:1 对标 pi-coding-agent print-mode.ts)
 */

import * as fs from 'node:fs';
import { Agent } from '../agent.js';
import { WorkflowCoordinator } from '../pipeline/coordinator.js';
import { TelemetryCollector } from '../telemetry/telemetry.js';
import { getModelPreset } from '@meisiristhebest/ai';

import type {
  AgentRoleConfig,
  QualityGateHandler,
  QualityGateRule,
  StateLedger,
  ThinkingLevel,
  Usage,
  WorkflowContext,
  WorkflowStageConfig
} from '@meisiristhebest/protocol';
import type { ModelConfig } from '@meisiristhebest/ai';

export interface PrintWorkflowOptions {
  stages: WorkflowStageConfig[];
  initialContext?: Partial<WorkflowContext>;
  finalStageId?: string;
  customExecutor?: (role: string, systemPrompt: string, userPrompt: string) => Promise<string>;
  initialRoles?: Record<string, AgentRoleConfig>;
  ledgerExtractor?: (output: string, ctx: WorkflowContext) => StateLedger | Partial<StateLedger>;
  ledgerFormatter?: (ledger: StateLedger) => string;
  enableQualityGate?: boolean;
  qualityGateHandler?: QualityGateHandler;
  customGateRules?: QualityGateRule[];
}

export interface PrintModeOptions {
  prompt: string;
  role?: string | 'pipeline';
  provider?: string;
  model?: string;
  modelConfig?: ModelConfig;
  thinkingLevel?: ThinkingLevel;
  json?: boolean;
  output?: string;
  systemPrompt?: string;
  /** Explicit workflow adapter for batch execution; no domain stages are implied. */
  workflow?: PrintWorkflowOptions;
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

function resolveEnvironmentModel(provider?: string): ModelConfig {
  const configuredProviders = provider
    ? [provider]
    : ['deepseek', 'openrouter', 'openai', 'claude', 'gemini'];

  for (const configuredProvider of configuredProviders) {
    if (configuredProvider === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    const id = process.env.INKPI_DEEPSEEK_MODEL;
    if (!id) throw new Error('DEEPSEEK_API_KEY requires INKPI_DEEPSEEK_MODEL.');
    return { id, name: id, provider: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY };
  }
    if (configuredProvider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    const id = process.env.INKPI_OPENROUTER_MODEL;
    if (!id) throw new Error('OPENROUTER_API_KEY requires INKPI_OPENROUTER_MODEL.');
    return {
      id,
      name: id,
      provider: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY
    };
  }
    if (configuredProvider === 'openai' && process.env.OPENAI_API_KEY) {
    const id = process.env.INKPI_OPENAI_MODEL;
    if (!id) throw new Error('OPENAI_API_KEY requires INKPI_OPENAI_MODEL.');
    return { id, name: id, provider: 'openai', apiKey: process.env.OPENAI_API_KEY };
  }
    if ((configuredProvider === 'claude' || configuredProvider === 'anthropic') && process.env.ANTHROPIC_API_KEY) {
    const id = process.env.INKPI_ANTHROPIC_MODEL;
    if (!id) throw new Error('ANTHROPIC_API_KEY requires INKPI_ANTHROPIC_MODEL.');
    return { id, name: id, provider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY };
  }
    if (configuredProvider === 'gemini' && process.env.GEMINI_API_KEY) {
    const id = process.env.INKPI_GEMINI_MODEL;
    if (!id) throw new Error('GEMINI_API_KEY requires INKPI_GEMINI_MODEL.');
    return { id, name: id, provider: 'gemini', apiKey: process.env.GEMINI_API_KEY };
  }
  }
  throw new Error(
    provider
      ? `No configured model was found for provider '${provider}'. Pass --model or configure that provider's API key and INKPI_*_MODEL.`
      : 'No AI model configuration found. Pass an explicit model or configure a provider API key and INKPI_*_MODEL.'
  );
}

export async function runPrintMode(options: PrintModeOptions): Promise<PrintModeResult> {
  const startTime = Date.now();
  const role = options.role || 'assistant';

  try {
    if (role === 'pipeline') {
      if (!options.workflow) {
        throw new Error(
          'Print workflow mode requires an explicit workflow configuration. ' +
          'Use a custom workflow or call WorkflowCoordinator.runPipeline() for the legacy narrative pipeline.'
        );
      }
      const telemetry = new TelemetryCollector();
      const coordinator = new WorkflowCoordinator({
        telemetry,
        model: options.modelConfig || (options.model ? getModelPreset(options.model) : undefined),
        ...options.workflow
      });
      const workflowResult = await coordinator.runWorkflow({
        ...options.workflow.initialContext,
        userPrompt: options.prompt
      });
      const finalStageId = options.workflow.finalStageId
        || options.workflow.stages[options.workflow.stages.length - 1]?.id;
      const finalContent = finalStageId ? workflowResult.stageOutputs[finalStageId] || '' : '';
      if (!finalContent) {
        throw new Error('Print workflow completed without output from its final stage.');
      }
      const durationMs = Date.now() - startTime;

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
    if (options.modelConfig) {
      modelObj = options.modelConfig;
    } else if (options.model) {
      modelObj = getModelPreset(options.model);
    } else {
      modelObj = resolveEnvironmentModel(options.provider);
    }


    const agent = new Agent({
      initialState: {
        model: modelObj,
        thinkingLevel: options.thinkingLevel || 'low',
        systemPrompt: options.systemPrompt || ''
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

    if (agent.state.errorMessage) {
      throw new Error(agent.state.errorMessage);
    }

    const assistantMsg = agent.state.messages.slice().reverse().find(m => m.role === 'assistant');
    let realUsage: Usage | undefined;
    if (assistantMsg) {
      if ((assistantMsg as any).stopReason === 'error') {
        throw new Error((assistantMsg as any).errorMessage || 'Model stream ended with an error.');
      }
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
    if (!generatedText) {
      throw new Error('Model completed without assistant text output.');
    }

    const durationMs = Date.now() - startTime;
    const result: PrintModeResult = {
      success: true,
      content: generatedText,
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
