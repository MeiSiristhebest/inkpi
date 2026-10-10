import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, SessionRegistry } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset, getProvider, setHttpClient } from '@inkpi/ai';
import type { ModelConfig } from '@inkpi/ai';
import type { SessionCreateResult } from '@inkpi/protocol';
import { SessionCommitError } from '@inkpi/protocol';
import { InkPiDaemon } from '@inkpi/server';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  setHttpClient(null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('independent provider conversation identity', () => {
  it('persists before requesting and restores across file-backed registry recreation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inkpi-provider-identity-'));
    directories.push(directory);
    const factory = (sessionId: string) =>
      new AppendOnlySessionJournal({ sessionId, filePath: join(directory, `${sessionId}.jsonl`) });
    const first = new SessionRegistry(() => 1, getModelPreset('mock-test'), undefined, { journalFactory: factory });
    const session = first.createSession({ sessionId: 'conversation' });
    const identity = session.agent.state.providerSessionId;
    expect(identity).toMatch(/^[\da-f-]{36}$/);
    expect(identity).not.toBe(session.sessionId);
    await session.agent.prompt('first');
    expect(factory('conversation').getEntries()[0]).toMatchObject({
      type: 'provider_session',
      payload: { version: 1, id: identity }
    });
    const restarted = new SessionRegistry(() => 1, getModelPreset('mock-test'), undefined, { journalFactory: factory });
    const restored = restarted.createSession({ sessionId: 'conversation' });
    expect(restored.agent.state.providerSessionId).toBe(identity);
    expect(restored.agent.state.messages).toHaveLength(2);
    await restored.agent.prompt('second');
    expect(factory('conversation').getEntriesByType('provider_session')).toHaveLength(1);
  });

  it('does not make a provider request or publish user input after identity persistence fails', async () => {
    let fail = true;
    const identities: string[] = [];
    const calls: string[] = [];
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      providerSessionIdGenerator: () => 'provider-conversation',
      journal: {
        append: (type: string, payload: { id?: string }) => {
          if (type === 'provider_session') {
            identities.push(payload.id!);
            if (fail) throw new SessionCommitError('disk unavailable', 'rejected');
          }
        }
      },
      streamFn: (_model, _messages, options) => {
        calls.push(options!.providerSessionId!);
        const stream = new AssistantEventStream();
        stream.push({ type: 'text_delta', textDelta: 'answer' });
        stream.end();
        return stream;
      }
    });
    await expect(agent.prompt('first')).rejects.toThrow('disk unavailable');
    expect(calls).toEqual([]);
    expect(agent.state.messages).toEqual([]);
    fail = false;
    await agent.prompt('retry');
    await agent.continue();
    expect(calls).toEqual(['provider-conversation', 'provider-conversation']);
    expect(identities).toEqual(['provider-conversation', 'provider-conversation']);
  });

  it('forks through daemon RPC with a fresh identity and an independent transcript', async () => {
    const daemon = new InkPiDaemon({ defaultModel: getModelPreset('mock-test') });
    const rpc = daemon.getRpcServer();
    await rpc.handleRequest({ jsonrpc: '2.0', id: 1, method: 'session.create', params: { sessionId: 'source' } });
    await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'session.prompt',
      params: { sessionId: 'source', prompt: 'first' }
    });
    const result = await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'session.fork',
      params: { sourceSessionId: 'source' }
    });
    expect(result.error).toBeUndefined();
    const sessions = daemon.getSessionManager();
    const fork = sessions.getSession((result.result as SessionCreateResult).sessionId)!;
    const source = sessions.getSession('source')!;
    expect(fork.agent.state.providerSessionId).not.toBe(source.agent.state.providerSessionId);
    expect(fork.agent.state.messages.map((message) => message.content)).toEqual(
      source.agent.state.messages.map((message) => message.content)
    );
    await fork.agent.prompt('fork input');
    expect(source.agent.state.messages).toHaveLength(2);
    expect(fork.agent.state.messages).toHaveLength(4);
    await daemon.stop();
  });

  it('isolates simultaneous conversations even when their wall clocks match', () => {
    const registry = new SessionRegistry(() => 1, getModelPreset('mock-test'));
    const first = registry.createSession();
    const second = registry.createSession();
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.agent.state.providerSessionId).not.toBe(second.agent.state.providerSessionId);
  });

  it('rejects invalid or conflicting persisted identities', () => {
    const journal = new AppendOnlySessionJournal('identity');
    journal.append('provider_session', { version: 2, id: 'old' });
    expect(() => new Agent({ initialState: { model: getModelPreset('mock-test') }, journal })).toThrow(
      'Invalid provider session'
    );
    const valid = new AppendOnlySessionJournal('valid');
    valid.append('provider_session', { version: 1, id: 'persisted' });
    expect(
      () =>
        new Agent({ initialState: { model: getModelPreset('mock-test') }, journal: valid, providerSessionId: 'other' })
    ).toThrow('conflicts');
  });

  it.each(['openai', 'openrouter', 'claude', 'gemini', 'ollama'] as const)(
    'passes identity to the %s adapter without using user IDs',
    async (provider) => {
      const requests: RequestInit[] = [];
      setHttpClient({
        fetch: async (_url, init) => {
          requests.push(init!);
          return new Response('request fixture', { status: 400 });
        }
      });
      const model: ModelConfig = {
        id: 'fixture',
        name: 'fixture',
        provider,
        apiKey: 'test-fixture',
        baseUrl: 'https://fixture.invalid',
        compat: { sessionAffinityHeader: 'x-fixture-session', enableSelfHealing: false }
      };
      const response = await getProvider(provider)(model, [{ role: 'user', content: 'request' }], {
        providerSessionId: 'conversation-id'
      }).collect();
      expect(response.stopReason).toBe('error');
      expect(new Headers(requests[0].headers).get('x-fixture-session')).toBe('conversation-id');
      const body = JSON.parse(String(requests[0].body));
      expect(body.user).toBeUndefined();
      expect(body.prompt_cache_key).toBe(provider === 'openai' ? 'conversation-id' : undefined);
    }
  );

  it('uses OpenRouter affinity and omits cache identity when OpenAI caching is disabled', async () => {
    const requests: RequestInit[] = [];
    setHttpClient({
      fetch: async (_url, init) => {
        requests.push(init!);
        return new Response('fixture', { status: 400 });
      }
    });
    await getProvider('openrouter')(
      { id: 'fixture', name: 'fixture', provider: 'openrouter', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' },
      [],
      { providerSessionId: 'affinity' }
    ).collect();
    expect(new Headers(requests[0].headers).get('x-session-id')).toBe('affinity');
    await getProvider('openai')(
      { id: 'fixture', name: 'fixture', provider: 'openai', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' },
      [],
      { providerSessionId: 'affinity', cacheControl: false }
    ).collect();
    expect(JSON.parse(String(requests[1].body)).prompt_cache_key).toBeUndefined();
  });
});
