import type { Agent, SessionTree } from '@inkpi/agent-core';
import { SlashCommandRegistry } from '@inkpi/agent-core';
import { GhostTextManager, HeadlessEditorState } from '@inkpi/editor-core';
import type { StateLedger } from '@inkpi/protocol';
import type {
  StudioDialogueEntry,
  StudioFlashMessage,
  StudioFocusMode,
  StudioLabels,
  StudioModalKind,
  StudioResourceItem,
  StudioSelectListOptions,
  TerminalStudioOptions
} from './studio-types.js';

/**
 * 构造 TerminalStudio 的默认标签集合。纯函数，无副作用。
 * 原内联于构造函数，抽出后便于单测与按需覆写（构造时以 `options.labels` 浅合并覆盖）。
 */
function buildDefaultStudioLabels(): StudioLabels {
  return {
    leftBoxTitle: 'Resources',
    editorTitle: 'Editor',
    rightBoxTitle: 'Runtime State',
    entitiesHeader: 'Entities:',
    assetsHeader: 'Assets:',
    tracksHeader: 'Tracks:',
    dialogueHeader: 'Conversation:',
    emptyContentText: '(empty)',
    emptyEntitiesText: '   (no entities)',
    emptyAssetsText: '   (no assets)',
    emptyTracksText: '   (no tracks)',
    emptyDialogueText: ' (no messages)',
    statusReady: 'Ready',
    processingText: 'Processing...',
    ghostSuggestion: 'Suggestion',
    acceptSuggestion: 'Tab to accept',
    focusStatus: (mode) => `Focus: [${mode.toUpperCase()}]`,
    resourceMetric: (wordCount) => `${wordCount}`,
    insertedStatus: (count) => `Inserted ${count} characters`,
    commandExecutedStatus: (command) => `Command executed: ${command}`,
    statusBarTitle: 'Studio',
    statusBarWords: 'Count',
    statusBarFocus: 'Focus',
    userRole: 'user',
    assistantRole: 'assistant'
  };
}

/**
 * Studio 三层分离之 **Model**：持有全部可变状态与状态迁移。
 *
 * 从 `TerminalStudio` 原地拆出（P2-#12）。任何输入处理（Controller）与渲染（View）
 * 都必须经由本类的公开方法/字段访问状态，不得旁路直改。
 * 字段语义与拆分前完全一致；构造时对 `agent` 的订阅逻辑也迁移至此。
 */
export class StudioModel {
  public readonly editor: HeadlessEditorState;
  public readonly ghost: GhostTextManager;
  public readonly slashRegistry: SlashCommandRegistry;
  public agent?: Agent;
  public tree?: SessionTree;
  public labels: StudioLabels;

  public focusMode: StudioFocusMode = 'editor';
  public resources: StudioResourceItem[];
  public activeResourceIndex = 0;
  public stateLedger: StateLedger = {
    entities: [],
    assets: [],
    tracks: [],
    locations: [],
    modifiedResources: []
  };
  public dialogueHistory: StudioDialogueEntry[] = [];

  public outlineScrollOffset = 0;
  public transcriptScrollOffset = 0;
  public activeModal: StudioModalKind = null;
  public activeSelectList?: StudioSelectListOptions<any>;
  public activeSelectIndex = 0;
  public flashMessage?: StudioFlashMessage;

  private width: number;
  private height: number;
  private statusMessage: string;
  private typography: TerminalStudioOptions['typography'];

  constructor(options: TerminalStudioOptions = {}) {
    this.editor = new HeadlessEditorState();
    this.ghost = new GhostTextManager(this.editor);
    this.slashRegistry = new SlashCommandRegistry();
    this.agent = options.agent;
    this.tree = options.tree;
    this.width = Math.max(80, options.width || 120);
    this.height = Math.max(24, options.height || 32);
    this.typography = options.typography;

    this.labels = { ...buildDefaultStudioLabels(), ...options.labels };

    this.statusMessage = this.labels.statusReady || 'Ready';

    this.resources = options.initialResources || [
      { id: 'resource_1', title: 'Untitled resource', wordCount: 0, status: 'draft', active: true }
    ];

    if (this.agent) {
      this.agent.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          this.dialogueHistory.push({
            role: 'assistant',
            text: this.labels.processingText || 'Processing...',
            timestamp: Date.now()
          });
        } else if (event.type === 'message_update' && event.message.role === 'assistant') {
          const last = this.dialogueHistory[this.dialogueHistory.length - 1];
          if (last && last.role === 'assistant') {
            const textContent = event.message.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
            last.text = textContent || this.labels.processingText || 'Processing...';
          }
        }
      });
    }
  }

  public setDimensions(width: number, height: number): void {
    this.width = Math.max(80, width);
    this.height = Math.max(24, height);
  }

  public getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** 供 View 渲染读取当前宽度。 */
  public getWidth(): number {
    return this.width;
  }

  /** 供 View 渲染读取当前高度。 */
  public getHeight(): number {
    return this.height;
  }

  /** 排版配置（View 渲染编辑器内容时读取）。 */
  public getTypography(): TerminalStudioOptions['typography'] {
    return this.typography;
  }

  public getStatusMessage(): string {
    return this.statusMessage;
  }

  public setStatusMessage(message: string): void {
    this.statusMessage = message;
  }

  public setFocus(mode: StudioFocusMode): void {
    this.focusMode = mode;
    this.statusMessage = this.labels.focusStatus?.(mode) || `Focus: [${mode.toUpperCase()}]`;
  }

  public updateStateLedger(ledger: StateLedger): void {
    this.stateLedger = { ...ledger };
  }

  public nextResource(): boolean {
    if (this.activeResourceIndex < this.resources.length - 1) {
      this.resources[this.activeResourceIndex].active = false;
      this.activeResourceIndex += 1;
      this.resources[this.activeResourceIndex].active = true;
      this.statusMessage = `切换至: ${this.resources[this.activeResourceIndex].title}`;
      return true;
    }
    return false;
  }

  public prevResource(): boolean {
    if (this.activeResourceIndex > 0) {
      this.resources[this.activeResourceIndex].active = false;
      this.activeResourceIndex -= 1;
      this.resources[this.activeResourceIndex].active = true;
      this.statusMessage = `切换至: ${this.resources[this.activeResourceIndex].title}`;
      return true;
    }
    return false;
  }

  public flash(text: string, level: 'info' | 'success' | 'warning' | 'error' = 'info', durationMs = 3000): void {
    this.flashMessage = {
      text,
      level,
      expiresAt: Date.now() + durationMs
    };
  }

  public openSelectList<T>(options: StudioSelectListOptions<T>): void {
    this.activeModal = 'selectList';
    this.activeSelectList = options;
    this.activeSelectIndex = options.initialIndex ?? 0;
  }

  public closeModal(): void {
    this.activeModal = null;
    this.activeSelectList = undefined;
  }

  public selectNext(): void {
    const items = this.activeSelectList?.items || this.activeSelectList?.assets || [];
    if (this.activeSelectList && this.activeSelectIndex < items.length - 1) {
      this.activeSelectIndex++;
    }
  }

  public selectPrev(): void {
    if (this.activeSelectList && this.activeSelectIndex > 0) {
      this.activeSelectIndex--;
    }
  }

  public confirmSelection<T>(): T | undefined {
    const items = this.activeSelectList?.items || this.activeSelectList?.assets || [];
    if (this.activeSelectList && items[this.activeSelectIndex]) {
      const selected = items[this.activeSelectIndex].value;
      this.closeModal();
      return selected;
    }
    return undefined;
  }

  public scrollOutline(delta: number): void {
    this.outlineScrollOffset = Math.max(0, this.outlineScrollOffset + delta);
  }

  public scrollTranscript(delta: number): void {
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
  }
}
