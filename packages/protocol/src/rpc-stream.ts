import { type RpcLimits, resolveRpcLimits, rpcFrameBytes } from './rpc-limits.js';
import type { RpcNotification, RpcRequest, RpcResponse } from './rpc.js';

export interface RpcWireTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  onClose?(handler: (error?: Error) => void): void;
  close(): Promise<void> | void;
  isOpen(): boolean;
}
export interface RpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
interface PendingRpc {
  request: RpcRequest;
  resolve: (result: RpcResponse) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** Shared request lifetimes for both client packages; each wire attempt has a unique identity. */
export class RpcStreamRequests {
  private readonly limits: RpcLimits;
  private readonly connectionId = crypto.randomUUID();
  private nextAttempt = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly activeIds = new Set<string | number>();
  private readonly notifications = new Set<(notification: RpcNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closedError?: Error;

  constructor(
    private readonly transport: RpcWireTransport,
    options?: Partial<RpcLimits>
  ) {
    this.limits = resolveRpcLimits(options);
    transport.onClose?.((error) => this.failPending(error ?? new Error('RPC transport closed')));
    transport.onMessage((message) => this.consume(message));
  }

  sendRequest(request: RpcRequest, options: RpcRequestOptions = {}): Promise<RpcResponse> {
    if (this.closedError || !this.transport.isOpen()) return Promise.reject(new Error('RPC transport is closed'));
    if (
      request.jsonrpc !== '2.0' ||
      typeof request.method !== 'string' ||
      !request.method.trim() ||
      (typeof request.id !== 'string' && (typeof request.id !== 'number' || !Number.isFinite(request.id)))
    )
      return Promise.reject(new Error('Invalid RPC request'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.activeIds.has(request.id))
      return Promise.reject(new Error(`RPC request id is already pending: ${request.id}`));
    if (this.pending.size >= this.limits.maxPendingRequests)
      return Promise.reject(new Error('RPC pending request limit reached'));
    const timeout = options.timeoutMs ?? this.limits.requestTimeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
      return Promise.reject(new Error('Invalid RPC request timeout'));
    const id = `${this.connectionId}:${++this.nextAttempt}`;
    let message: string;
    try {
      message = JSON.stringify({ ...request, id });
      rpcFrameBytes(message, this.limits);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.failRequest(id, options.signal?.reason ?? new DOMException('RPC wait cancelled', 'AbortError'));
      const timer = setTimeout(() => this.failRequest(id, new Error('RPC request timed out')), timeout);
      const pending = {
        request: { ...request },
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        }
      };
      this.pending.set(id, pending);
      this.activeIds.add(request.id);
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        void Promise.resolve(this.transport.send(message)).catch((error) => this.failRequest(id, error));
      } catch (error) {
        this.failRequest(id, error);
      }
    });
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.notifications.add(handler);
    return () => {
      this.notifications.delete(handler);
    };
  }
  onClose(handler: (error: Error) => void): () => void {
    if (this.closedError) handler(this.closedError);
    else this.closeListeners.add(handler);
    return () => {
      this.closeListeners.delete(handler);
    };
  }
  async close(): Promise<void> {
    this.failPending(new Error('RPC transport closed while awaiting a response'));
    await this.transport.close();
  }

  private consume(message: string): void {
    if (this.closedError) return;
    try {
      rpcFrameBytes(message, this.limits);
      const value = JSON.parse(message);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0')
        throw new Error('Invalid RPC message');
      if (Object.hasOwn(value, 'id')) {
        if (
          typeof value.id !== 'string' ||
          Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error') ||
          (value.error !== undefined &&
            (!Number.isInteger(value.error?.code) || typeof value.error?.message !== 'string'))
        )
          throw new Error('Invalid RPC response');
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.remove(value.id, pending);
        pending.resolve({ ...value, id: pending.request.id });
      } else if (typeof value.method === 'string') {
        for (const listener of [...this.notifications]) {
          try {
            listener(structuredClone(value));
          } catch {
            /* A consumer does not own the connection. */
          }
        }
      } else throw new Error('Invalid RPC notification');
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error('Invalid RPC message'));
      void Promise.resolve(this.transport.close()).catch(() => undefined);
    }
  }
  private remove(id: string, pending: PendingRpc): void {
    this.pending.delete(id);
    this.activeIds.delete(pending.request.id);
    pending.cleanup();
  }
  private failRequest(id: string, error: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.remove(id, pending);
    pending.reject(error);
  }
  private failPending(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const [id, pending] of this.pending) {
      this.remove(id, pending);
      pending.reject(error);
    }
    this.notifications.clear();
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        /* Drain every waiter. */
      }
    }
    this.closeListeners.clear();
  }
}
