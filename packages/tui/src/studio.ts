import { StudioModel } from './studio-model.js';
import { StudioView } from './studio-view.js';
import { StudioController } from './studio-controller.js';
import type { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import type { StateLedger } from '@inkpi/protocol';
import type { Agent, SessionTree } from '@inkpi/agent-core';
import type {
  StudioFlashMessage,
  StudioFocusMode,
  StudioLabels,
  StudioModalKind,
  StudioResourceItem,
  StudioSelectListOptions,
  TerminalStudioOptions
} from './studio-types.js';

export * from './studio-types.js';
export * from './studio-model.js';
export * from './studio-view.js';
export * from './studio-controller.js';

/**
 * Terminal workstation primitives.
 *
 * 原位于 `@inkpi/agent-core/src/tui/studio.ts`，作为表现层被错误地放在领域核心包内。
 * 现迁移至 `@inkpi/tui`（表现层包）。领域类型（Agent/SessionTree/SlashCommandRegistry）
 * 从 `@inkpi/agent-core` 引入，渲染原语（ANSI/drawBox/DifferentialRenderer）取包内实现。
 * 详见 ARCHITECTURE.md §5。
 *
 * **三层分离（P2-#12）**：本类现在只是组装门面——
 * - `StudioModel`（`studio-model.ts`）持有全部状态与状态迁移；
 * - `StudioView`（`studio-view.ts`）从 Model 纯渲染（含差分渲染器）；
 * - `StudioController`（`studio-controller.ts`）把输入翻译为 Model 状态迁移。
 * 公开 API（字段 getter + 方法）与拆分前的 `TerminalStudio` 完全一致。
 */
export class TerminalStudio {
  private readonly model: StudioModel;
  private readonly view: StudioView;
  private readonly controller: StudioController;

  constructor(options: TerminalStudioOptions = {}) {
    this.model = new StudioModel(options);
    this.view = new StudioView(this.model);
    this.controller = new StudioController(this.model);
  }

  // ---- 公开字段（getter 委托 Model，保持拆分前属性访问面不变） ----

  public get editor(): HeadlessEditorState {
    return this.model.editor;
  }

  public get ghost(): GhostTextManager {
    return this.model.ghost;
  }

  public get slashRegistry(): StudioModel['slashRegistry'] {
    return this.model.slashRegistry;
  }

  public get agent(): Agent | undefined {
    return this.model.agent;
  }

  public get tree(): SessionTree | undefined {
    return this.model.tree;
  }

  public get labels(): StudioLabels {
    return this.model.labels;
  }

  public get focusMode(): StudioFocusMode {
    return this.model.focusMode;
  }

  public get resources(): StudioResourceItem[] {
    return this.model.resources;
  }

  public get activeResourceIndex(): number {
    return this.model.activeResourceIndex;
  }

  public get stateLedger(): StateLedger {
    return this.model.stateLedger;
  }

  public get outlineScrollOffset(): number {
    return this.model.outlineScrollOffset;
  }

  public get transcriptScrollOffset(): number {
    return this.model.transcriptScrollOffset;
  }

  public get activeModal(): StudioModalKind {
    return this.model.activeModal;
  }

  public get activeSelectList(): StudioSelectListOptions<any> | undefined {
    return this.model.activeSelectList;
  }

  public get activeSelectIndex(): number {
    return this.model.activeSelectIndex;
  }

  public get flashMessage(): StudioFlashMessage | undefined {
    return this.model.flashMessage;
  }

  // ---- 状态迁移（委托 Model） ----

  public setDimensions(width: number, height: number): void {
    this.model.setDimensions(width, height);
  }

  public getDimensions(): { width: number; height: number } {
    return this.model.getDimensions();
  }

  public setFocus(mode: StudioFocusMode): void {
    this.model.setFocus(mode);
  }

  public updateStateLedger(ledger: StateLedger): void {
    this.model.updateStateLedger(ledger);
  }

  public nextResource(): boolean {
    return this.model.nextResource();
  }

  public prevResource(): boolean {
    return this.model.prevResource();
  }

  public flash(
    text: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
    durationMs = 3000
  ): void {
    this.model.flash(text, level, durationMs);
  }

  public openSelectList<T>(options: StudioSelectListOptions<T>): void {
    this.model.openSelectList(options);
  }

  public closeModal(): void {
    this.model.closeModal();
  }

  public selectNext(): void {
    this.model.selectNext();
  }

  public selectPrev(): void {
    this.model.selectPrev();
  }

  public confirmSelection<T>(): T | undefined {
    return this.model.confirmSelection<T>();
  }

  public scrollOutline(delta: number): void {
    this.model.scrollOutline(delta);
  }

  public scrollTranscript(delta: number): void {
    this.model.scrollTranscript(delta);
  }

  // ---- 渲染（委托 View） ----

  public renderScreen(): string {
    return this.view.renderScreen();
  }

  public renderEntityAvatar(entityName: string): string[] {
    return this.view.renderEntityAvatar(entityName);
  }

  public renderFullFrame(): string {
    return this.renderScreen();
  }

  public renderDifferential(): { isDiff: boolean; content: string } {
    return this.view.renderDifferential();
  }

  // ---- 输入（委托 Controller） ----

  public handleInput(input: string): Promise<string> {
    return this.controller.handleInput(input);
  }
}
