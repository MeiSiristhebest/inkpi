/**
 * 通用 RPC 传输层契约
 */
export interface RpcTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  close(): Promise<void> | void;
  isOpen(): boolean;
}

/**
 * RPC 连接默认主机：仅回环地址（loopback-only）。
 * 安全默认——除非调用方显式注入其他 host，RPC 端口永远只绑定/连接本机，
 * 不向局域网暴露。与 `@inkpi/server` 的 DEFAULT_RPC_HOST 语义一致。
 */
export const DEFAULT_RPC_HOST = '127.0.0.1';
