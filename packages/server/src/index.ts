export * from './daemon.js';
export * from './server.js';
export * from './client.js';
export * from './transport.js';
export * from './tcp-transport.js';
export * from './ws-transport.js';

// LiveSessionManager 是领域对象，定义在 @inkpi/agent-core（不依赖表现层/传输层）。
// server 包作为传输层，从领域核心引入它，形成 server → agent-core 的单向依赖，无环。
export { LiveSessionManager } from '@inkpi/agent-core';
export type { ManagedSession, SessionCreateOptions, SessionSummary } from '@inkpi/agent-core';
