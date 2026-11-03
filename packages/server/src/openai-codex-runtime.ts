import type {
  OpenAICodexConnection,
  OpenAICodexDisconnectParams,
  OpenAICodexDisconnectResult,
  OpenAICodexSignInParams,
  OpenAICodexSignInStart,
  OpenAICodexSignInStatus,
  OpenAICodexSignInStatusParams
} from '@inkpi/protocol';
import { ChatGPTPlanRuntime, type ChatGPTPlanRuntimeOptions } from './chatgpt-plan-runtime.js';

export type OpenAICodexRuntimeOptions = Omit<ChatGPTPlanRuntimeOptions, 'accountNamespace'>;

/** Codex OAuth stays in its own credential namespace and never requests Plan scopes. */
export class OpenAICodexRuntime {
  private readonly accounts: ChatGPTPlanRuntime;

  constructor(options: OpenAICodexRuntimeOptions = {}) {
    this.accounts = new ChatGPTPlanRuntime({ ...options, accountNamespace: 'openai-codex' });
  }

  async getStatus(): Promise<OpenAICodexConnection> {
    const connection = await this.accounts.getStatus();
    return {
      available: connection.available,
      accounts: connection.accounts.map(({ sharing: _sharing, ...account }) => account)
    };
  }

  startSignIn(params: OpenAICodexSignInParams): Promise<OpenAICodexSignInStart> {
    return this.accounts.startSignIn({ ...params, enablePlanUsage: false });
  }

  signInStatus(params: OpenAICodexSignInStatusParams): OpenAICodexSignInStatus {
    const status = this.accounts.signInStatus(params);
    if (status.status !== 'connected') return status;
    const { sharing: _sharing, ...account } = status.account;
    return { status: 'connected', account };
  }

  disconnect(params: OpenAICodexDisconnectParams): Promise<OpenAICodexDisconnectResult> {
    return this.accounts.disconnect(params);
  }

  resolveModelAccessToken(credentialRef: string): Promise<string> {
    return this.accounts.resolveModelAccessToken(credentialRef);
  }

  dispose(): void {
    this.accounts.dispose();
  }
}
