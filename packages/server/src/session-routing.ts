import {
  RPC_ERROR_CODES,
  type RpcRequest,
  type SessionAttachParams,
  type SessionAttachment,
  isSessionRpcMethod,
  sameSessionAttachment
} from '@inkpi/protocol';

export class SessionRouting {
  readonly serverId = crypto.randomUUID();
  private readonly epochs = new WeakMap<object, string>();
  private readonly connections = new Map<string, { route: SessionAttachment; generation: number }>();
  constructor(private readonly resolveSession: (sessionId: string) => object | undefined) {}

  attach(connectionId: string, params: SessionAttachParams): SessionAttachment {
    if (typeof params?.sessionId !== 'string' || !params.sessionId)
      throw new Error('session.attach requires a sessionId');
    const generation = params.generation ?? (this.connections.get(connectionId)?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation <= (this.connections.get(connectionId)?.generation ?? 0))
      throw staleAttachment();
    const session = this.resolveSession(params.sessionId);
    if (!session) throw new Error(`Session '${params.sessionId}' not found`);
    const route = {
      serverId: this.serverId,
      sessionId: params.sessionId,
      sessionEpoch: this.epoch(session),
      attachmentId: crypto.randomUUID()
    };
    this.connections.set(connectionId, { route, generation });
    return structuredClone(route);
  }
  assertRequest(connectionId: string, req: RpcRequest): void {
    if (!isSessionRpcMethod(req.method)) return;
    const current = this.connections.get(connectionId)?.route;
    if (!current && !req.route) return;
    if (!current || !sameSessionAttachment(current, req.route)) throw staleAttachment();
    const session = this.resolveSession(current.sessionId);
    if (!session || this.epoch(session) !== current.sessionEpoch) throw staleAttachment();
    const params = req.params as Record<string, unknown> | undefined;
    const target = params?.[req.method === 'session.fork' ? 'sourceSessionId' : 'sessionId'];
    if (target !== current.sessionId) throw staleAttachment();
  }
  routeForEvent(connectionId: string, sessionId: string, source: object): SessionAttachment | null {
    // A retired session object cannot publish into a newly created session with the same ID.
    if (this.resolveSession(sessionId) !== source) return null;
    const route = this.connections.get(connectionId)?.route;
    if (!route) return null;
    return route.sessionId === sessionId && route.sessionEpoch === this.epoch(source) ? structuredClone(route) : null;
  }
  release(connectionId: string): void {
    this.connections.delete(connectionId);
  }
  private epoch(session: object): string {
    let epoch = this.epochs.get(session);
    if (!epoch) {
      epoch = crypto.randomUUID();
      this.epochs.set(session, epoch);
    }
    return epoch;
  }
}
function staleAttachment(): Error {
  return Object.assign(new Error('RPC session attachment is stale'), { code: RPC_ERROR_CODES.STALE_ATTACHMENT });
}
