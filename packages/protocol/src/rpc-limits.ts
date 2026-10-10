export interface RpcLimits {
  maxFrameBytes: number;
  maxQueuedBytes: number;
  maxPendingRequests: number;
  requestTimeoutMs: number;
}
export const DEFAULT_RPC_LIMITS: Readonly<RpcLimits> = Object.freeze({
  maxFrameBytes: 8 * 1024 * 1024,
  maxQueuedBytes: 16 * 1024 * 1024,
  maxPendingRequests: 256,
  requestTimeoutMs: 30_000
});
export function resolveRpcLimits(input: Partial<RpcLimits> = {}): RpcLimits {
  const limits = { ...DEFAULT_RPC_LIMITS, ...input };
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.requestTimeoutMs > 2_147_483_647 ||
    limits.maxQueuedBytes < limits.maxFrameBytes
  )
    throw new Error('Invalid RPC limits');
  return limits;
}
const encoder = new TextEncoder();
export function rpcFrameBytes(message: string, limits: RpcLimits): number {
  const size = encoder.encode(message).byteLength;
  if (size > limits.maxFrameBytes) throw new Error('RPC frame exceeds byte limit');
  return size;
}
/** Accumulates only a bounded partial frame, without repeatedly copying its prefix. */
export class RpcLineBuffer {
  private fragments: string[] = [];
  private tail = '';
  private bytes = 0;
  constructor(private readonly limits: RpcLimits) {}
  push(chunk: string): string[] {
    const messages: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start);
      const fragment = chunk.slice(start, end < 0 ? undefined : end);
      this.bytes += encoder.encode(fragment).byteLength;
      if (this.bytes > this.limits.maxFrameBytes) {
        this.clear();
        throw new Error('RPC frame exceeds byte limit');
      }
      if (fragment.length >= 1024) {
        if (this.tail) this.fragments.push(this.tail);
        this.tail = '';
        this.fragments.push(fragment);
      } else {
        this.tail += fragment;
        if (this.tail.length >= 1024) {
          this.fragments.push(this.tail);
          this.tail = '';
        }
      }
      if (end < 0) break;
      const message = (this.fragments.join('') + this.tail).trim();
      this.clear();
      if (message) messages.push(message);
      start = end + 1;
    }
    return messages;
  }
  clear(): void {
    this.fragments = [];
    this.tail = '';
    this.bytes = 0;
  }
}
export class RpcSendWindow {
  private queuedBytes = 0;
  constructor(private readonly limits: RpcLimits) {}
  reserve(message: string, nativeQueuedBytes = 0): () => void {
    const bytes = rpcFrameBytes(message, this.limits);
    const nativeBytes = Number.isFinite(nativeQueuedBytes) ? Math.max(0, nativeQueuedBytes) : 0;
    if (Math.max(this.queuedBytes, nativeBytes) + bytes > this.limits.maxQueuedBytes)
      throw new Error('RPC send queue exceeds byte limit');
    this.queuedBytes += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.queuedBytes -= bytes;
      }
    };
  }
}
