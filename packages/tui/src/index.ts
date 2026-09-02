/**
 * @inkpi/tui - Terminal UI framework for InkPi (1:1 aligned with pi-tui)
 */

export * from './render.js';
export * from './width.js';
export * from './cursor.js';
export * from './overlay.js';
export * from './keys.js';
export * from './layout.js';
// Components (atomic design: atoms / molecules / organisms — see ./components/index.js)
export * from './components/index.js';
export * from './terminal-image.js';

export * from './mermaid.js';
export * from './tui-screens.js';
export * from './tui.js';

// 表现层原语：从 agent-core 迁移而来的工作台与无头交互编排（详见 ARCHITECTURE.md §5）。
export * from './studio.js';
export * from './terminal-harness.js';

