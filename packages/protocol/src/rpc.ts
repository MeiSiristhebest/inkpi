/**
 * InkPi JSON-RPC 2.0 协议标准定义 (1:1 对标 repos/pi packages/protocol RPC 机制)
 */

export interface RpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: T;
}

export interface RpcResponseSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result: T;
  error?: never;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponseError {
  jsonrpc: '2.0';
  id: string | number;
  error: RpcErrorObject;
  result?: never;
}

export type RpcResponse<T = unknown> = RpcResponseSuccess<T> | RpcResponseError;

export interface RpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params: T;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AGENT_ABORTED: -32001,
  LEASE_LOCKED: -32002,
  STORAGE_ERROR: -32003
} as const;
