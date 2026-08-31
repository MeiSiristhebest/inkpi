/**
 * 通用 RPC 传输层契约 (1:1 对标 pi-client / pi-server transport)
 */
export interface RpcTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  close(): Promise<void> | void;
  isOpen(): boolean;
}
