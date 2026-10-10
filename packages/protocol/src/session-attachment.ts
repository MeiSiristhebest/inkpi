/** A host-issued route for one session object on one connection. */
export interface SessionAttachment {
  serverId: string;
  sessionId: string;
  sessionEpoch: string;
  attachmentId: string;
}
export interface SessionAttachParams {
  sessionId: string;
  generation?: number;
}
export function isSessionAttachment(value: unknown): value is SessionAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return ['serverId', 'sessionId', 'sessionEpoch', 'attachmentId'].every(
    (key) => typeof route[key] === 'string' && (route[key] as string).length > 0
  );
}
export function sameSessionAttachment(left: unknown, right: unknown): boolean {
  return (
    isSessionAttachment(left) &&
    isSessionAttachment(right) &&
    left.serverId === right.serverId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch &&
    left.attachmentId === right.attachmentId
  );
}
export function isSessionRpcMethod(method: string): boolean {
  return method.startsWith('session.') && !['session.create', 'session.list', 'session.attach'].includes(method);
}

/** Shared by the two SDKs so switching a session also cancels local waits. */
export class RpcSessionAttachment {
  private route?: SessionAttachment;
  private scope = new AbortController();
  private generation = 0;

  beginAttach(): { generation: number; signal: AbortSignal } {
    this.scope.abort(new Error('RPC session attachment changed'));
    this.route = undefined;
    this.scope = new AbortController();
    return { generation: ++this.generation, signal: this.scope.signal };
  }
  accept(generation: number, sessionId: string, value: unknown): SessionAttachment {
    if (generation !== this.generation || this.scope.signal.aborted)
      throw new Error('RPC session attachment superseded');
    if (!isSessionAttachment(value) || value.sessionId !== sessionId) throw new Error('Invalid RPC session attachment');
    this.route = structuredClone(value);
    return structuredClone(this.route);
  }
  forRequest(method: string, params: unknown): { route?: SessionAttachment; signal?: AbortSignal } {
    if (!isSessionRpcMethod(method)) return {};
    if (!this.route) {
      if (this.generation > 0) throw new Error('RPC session attachment is not ready');
      return {};
    }
    const target =
      params && typeof params === 'object'
        ? (params as Record<string, unknown>)[method === 'session.fork' ? 'sourceSessionId' : 'sessionId']
        : undefined;
    if (target !== undefined && target !== this.route.sessionId) throw new Error('RPC request targets another session');
    return { route: structuredClone(this.route), signal: this.scope.signal };
  }
  acceptsNotification(method: string, route: unknown): boolean {
    if (method !== 'session.event') return true;
    return this.generation === 0 || sameSessionAttachment(this.route, route);
  }
  close(): void {
    this.scope.abort(new Error('RPC client connection closed'));
    this.route = undefined;
  }
}
