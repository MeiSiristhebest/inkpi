export const REAL_PROVIDER_ACCEPTANCE_MARKER = 'INKPI_REAL_PROVIDER_ACCEPTANCE_OK';

const PROVIDER_DEFINITIONS = {
  deepseek: { credentialEnv: 'DEEPSEEK_API_KEY', runtimeProvider: 'deepseek' },
  openrouter: { credentialEnv: 'OPENROUTER_API_KEY', runtimeProvider: 'openrouter' },
  openai: { credentialEnv: 'OPENAI_API_KEY', runtimeProvider: 'openai' },
  claude: { credentialEnv: 'ANTHROPIC_API_KEY', runtimeProvider: 'claude' },
  anthropic: { credentialEnv: 'ANTHROPIC_API_KEY', runtimeProvider: 'claude' },
  gemini: { credentialEnv: 'GEMINI_API_KEY', runtimeProvider: 'gemini' }
} as const;

export type RealProviderName = keyof typeof PROVIDER_DEFINITIONS;

export interface RealProviderAcceptanceConfig {
  provider: RealProviderName;
  runtimeProvider: (typeof PROVIDER_DEFINITIONS)[RealProviderName]['runtimeProvider'];
  model: string;
  apiKey: string;
  prompt: string;
  expectedMarker: string;
  reportFile?: string;
}

export type RealProviderAcceptancePlan =
  | { status: 'skipped'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; config: RealProviderAcceptanceConfig };

export interface RealProviderRunResult {
  success: boolean;
  content: string;
  durationMs: number;
  usage?: Record<string, unknown>;
  error?: string;
}

export interface RealProviderAcceptanceReport {
  kind: 'real-provider-acceptance';
  mode: 'real-provider';
  status: 'skipped' | 'passed' | 'failed';
  passed: boolean;
  timestamp: number;
  provider?: RealProviderName;
  model?: string;
  responseContainsMarker?: boolean;
  contentLength?: number;
  durationMs?: number;
  usage?: Record<string, unknown>;
  reason?: string;
}

/**
 * Read the opt-in real-provider gate without ever treating a local fixture as
 * provider evidence. The API key is kept in the ready plan for the executor,
 * but is deliberately absent from all report types.
 */
export function readRealProviderAcceptancePlan(
  env: Record<string, string | undefined> = process.env
): RealProviderAcceptancePlan {
  if (env.INKPI_RUN_REAL_PROVIDER_ACCEPTANCE !== '1') {
    return {
      status: 'skipped',
      reason: 'Set INKPI_RUN_REAL_PROVIDER_ACCEPTANCE=1 to invoke a real provider.'
    };
  }

  const providerValue = env.INKPI_ACCEPTANCE_PROVIDER?.trim().toLowerCase();
  if (!providerValue || !(providerValue in PROVIDER_DEFINITIONS)) {
    return {
      status: 'invalid',
      reason: `INKPI_ACCEPTANCE_PROVIDER must be one of: ${Object.keys(PROVIDER_DEFINITIONS).join(', ')}.`
    };
  }

  const provider = providerValue as RealProviderName;
  const definition = PROVIDER_DEFINITIONS[provider];
  const model = env.INKPI_ACCEPTANCE_MODEL?.trim();
  if (!model) {
    return { status: 'invalid', reason: 'INKPI_ACCEPTANCE_MODEL must name the model used for the acceptance run.' };
  }

  const apiKey = env[definition.credentialEnv]?.trim();
  if (!apiKey) {
    return {
      status: 'invalid',
      reason: `${definition.credentialEnv} is required for provider '${provider}'.`
    };
  }

  return {
    status: 'ready',
    config: {
      provider,
      runtimeProvider: definition.runtimeProvider,
      model,
      apiKey,
      prompt:
        env.INKPI_ACCEPTANCE_PROMPT?.trim() ||
        `Reply with the exact marker ${REAL_PROVIDER_ACCEPTANCE_MARKER} and no other text.`,
      expectedMarker: REAL_PROVIDER_ACCEPTANCE_MARKER,
      ...(env.INKPI_ACCEPTANCE_REPORT_FILE?.trim() ? { reportFile: env.INKPI_ACCEPTANCE_REPORT_FILE.trim() } : {})
    }
  };
}

export function reportSkippedOrInvalid(
  plan: Exclude<RealProviderAcceptancePlan, { status: 'ready' }>,
  timestamp = Date.now()
): RealProviderAcceptanceReport {
  return {
    kind: 'real-provider-acceptance',
    mode: 'real-provider',
    status: plan.status === 'skipped' ? 'skipped' : 'failed',
    passed: false,
    timestamp,
    reason: plan.reason
  };
}

export function evaluateRealProviderResult(
  config: Pick<RealProviderAcceptanceConfig, 'provider' | 'model' | 'expectedMarker'>,
  result: RealProviderRunResult,
  timestamp = Date.now()
): RealProviderAcceptanceReport {
  const content = result.content.trim();
  const responseContainsMarker = content.includes(config.expectedMarker);
  const passed = result.success && content.length > 0 && responseContainsMarker;
  return {
    kind: 'real-provider-acceptance',
    mode: 'real-provider',
    status: passed ? 'passed' : 'failed',
    passed,
    timestamp,
    provider: config.provider,
    model: config.model,
    responseContainsMarker,
    contentLength: content.length,
    durationMs: result.durationMs,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(passed ? {} : { reason: result.error || 'Provider response did not contain the expected acceptance marker.' })
  };
}
