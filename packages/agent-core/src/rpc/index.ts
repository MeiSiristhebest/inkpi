// 传输层（daemon / server / client / transports）已迁移至 @inkpi/server 包。
// agent-core 作为领域核心，仅保留领域对象 SessionRegistry（实现 SessionStore 端口）。
export * from './session-registry.js';
