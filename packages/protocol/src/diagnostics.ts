import type { CacheStatus } from './cache.js';

/** Read-only Runtime health data safe to expose across the Desktop boundary. */
export interface DiagnosticSnapshot {
  version: 1;
  capturedAt: number;
  runtime: {
    protocolVersion: string;
    contractVersion: number;
    schemaHash: string;
    implementationVersion: string;
    capabilities: string[];
  };
  daemon: {
    running: boolean;
    activeSessions: number;
    uptimeMs: number;
    port?: number;
    host?: string;
    wsPort?: number;
  };
  cache: CacheStatus;
  modelRoutes: {
    configured: number;
  };
}
