/**
 * @inkpi/tui 集中弃用别名。
 *
 * 约定（与 `@inkpi/agent-core/src/deprecations.ts` 同规则）：每个包内的兼容别名
 * 只允许出现在本文件的对应弃用模块中，统一标注 `@deprecated` 与预计移除版本（v1.0）。
 * 每个别名必须指向唯一权威名称，且行为完全一致。新代码禁止使用本文件导出的任何名字。
 */
import { TerminalStudio } from './studio.js';
import { TerminalHarness } from './terminal-harness.js';

/** @deprecated 已由 `TerminalStudio` 取代（Tui 前缀别名，无独立语义）。计划移除版本：v1.0 */
export const TuiStudio = TerminalStudio;
export type TuiStudio = TerminalStudio;

/** @deprecated 已由 `TerminalHarness` 取代（Writer 中缀冗余）。计划移除版本：v1.0 */
export const TerminalWriterHarness = TerminalHarness;
export type TerminalWriterHarness = TerminalHarness;
