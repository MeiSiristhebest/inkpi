/**
 * 通用 RPC 传输层契约
 */
export interface RpcTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  close(): Promise<void> | void;
  isOpen(): boolean;
}
