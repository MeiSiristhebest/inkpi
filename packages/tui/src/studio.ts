import { HeadlessEditorState, GhostTextManager, formatTypography } from '@inkpi/editor-core';
import type { StateLedger, SelectListOptions, TypographyOptions } from '@inkpi/protocol';
import type { Agent } from '@inkpi/agent-core';
import type { SessionTree } from '@inkpi/agent-core';
import { SlashCommandRegistry } from '@inkpi/agent-core';
import { ANSI, drawBox, DifferentialRenderer } from './render.js';

export type StudioFocusMode = 'editor' | 'outline' | 'copilot' | 'ledger';

export interface StudioResourceItem {
  id: string;
  title: string;
  wordCount: number;
  status?: string;
  active: boolean;
}

export interface StudioLabels {
  leftBoxTitle?: string;
  editorTitle?: string;
  rightBoxTitle?: string;
  entitiesHeader?: string;
  assetsHeader?: string;
  tracksHeader?: string;
  dialogueHeader?: string;
  emptyContentText?: string;
  emptyEntitiesText?: string;
  emptyAssetsText?: string;
  emptyTracksText?: string;
  emptyDialogueText?: string;
  statusReady?: string;
  processingText?: string;
  ghostSuggestion?: string;
  acceptSuggestion?: string;
  focusStatus?: (mode: StudioFocusMode) => string;
  resourceMetric?: (wordCount: number) => string;
  insertedStatus?: (count: number) => string;
  commandExecutedStatus?: (command: string) => string;
  statusBarTitle?: string;
  statusBarWords?: string;
  statusBarFocus?: string;
  userRole?: string;
  assistantRole?: string;
}

export interface TerminalStudioOptions {
  agent?: Agent;
  tree?: SessionTree;
  width?: number;
  height?: number;
  initialResources?: StudioResourceItem[];
  labels?: Partial<StudioLabels>;
  typography?: (Partial<TypographyOptions> & { mode?: 'chinese' | 'western' | 'none' }) | false;
}

/**
 * Terminal workstation primitives.
 *
 * 原位于 `@inkpi/agent-core/src/tui/studio.ts`，作为表现层被错误地放在领域核心包内。
 * 现迁移至 `@inkpi/tui`（表现层包）。领域类型（Agent/SessionTree/SlashCommandRegistry）
 * 从 `@inkpi/agent-core` 引入，渲染原语（ANSI/drawBox/DifferentialRenderer）取包内实现。
 * 详见 ARCHITECTURE.md §5。
 */
export class TerminalStudio {
  public editor: HeadlessEditorState;
  public ghost: GhostTextManager;
  public slashRegistry: SlashCommandRegistry;
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

  private dialogueHistory: Array<{ role: string; text: string; timestamp: number }> = [];
  private width: number;
  private height: number;
  private differentialRenderer = new DifferentialRenderer();
  private statusMessage: string;
  private typography: TerminalStudioOptions['typography'];

  // Scroll and modal state
  public outlineScrollOffset = 0;
  public transcriptScrollOffset = 0;
  public activeModal: 'selectList' | 'input' | null = null;
  public activeSelectList?: SelectListOptions<any>;
  public activeSelectIndex = 0;
  public flashMessage?: { text: string; level: 'info' | 'success' | 'warning' | 'error'; expiresAt: number };

  constructor(options: TerminalStudioOptions = {}) {
    this.editor = new HeadlessEditorState();
    this.ghost = new GhostTextManager(this.editor);
    this.slashRegistry = new SlashCommandRegistry();
    this.agent = options.agent;
    this.tree = options.tree;
    this.width = Math.max(80, options.width || 120);
    this.height = Math.max(24, options.height || 32);
    this.typography = options.typography;

    this.labels = {
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
      assistantRole: 'assistant',
      ...options.labels
    };

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

  /** Render the three-pane workstation frame. */
  public renderScreen(): string {
    const leftWidth = 24;
    const rightWidth = 34;
    const centerWidth = Math.max(30, this.width - leftWidth - rightWidth - 2);
    const mainHeight = this.height - 3;

    // 1. Resource list
    const outlineBorder = this.focusMode === 'outline' ? ANSI.FG_YELLOW : ANSI.FG_CYAN;
    const outlineLines: string[] = this.resources.map((res, idx) => {
      const activeMark = idx === this.activeResourceIndex ? '👉 ' : '   ';
      const status = res.status ? `[${res.status}] ` : '';
      const metric = this.labels.resourceMetric?.(res.wordCount) || `${res.wordCount}`;
      return `${activeMark}${status}${res.title} (${metric})`;
    });
    const leftBox = drawBox(this.labels.leftBoxTitle || '📚 资源目录树', outlineLines, leftWidth, mainHeight, outlineBorder);

    // 2. Editor and ghost text
    const editorBorder = this.focusMode === 'editor' ? ANSI.FG_GREEN : ANSI.FG_GRAY;
    const currentResource = this.resources[this.activeResourceIndex] || { title: 'Untitled resource' };
    const rawContent = this.editor.getText();
    const formattedContent = this.typography
      ? formatTypography(rawContent, this.typography)
      : rawContent;
    const contentLines = formattedContent ? formattedContent.split('\n') : [this.labels.emptyContentText || '(empty)'];

    if (this.ghost.hasGhostText()) {
      const gt = this.ghost.getGhostText();
      if (gt) {
        contentLines.push(`${ANSI.FG_GRAY}${this.labels.ghostSuggestion || 'Suggestion'}: ${gt.text} ${ANSI.FG_YELLOW}(${this.labels.acceptSuggestion || 'Tab to accept'})${ANSI.RESET}`);
      }
    }
    const centerBox = drawBox(
      `${this.labels.editorTitle || 'Editor'} - ${currentResource.title} (${this.labels.resourceMetric?.(this.editor.getWordCount()) || this.editor.getWordCount()})`,
      contentLines,
      centerWidth,
      mainHeight,
      editorBorder
    );

    // 3. Runtime state and conversation
    const rightBorder = this.focusMode === 'copilot' || this.focusMode === 'ledger' ? ANSI.FG_MAGENTA : ANSI.FG_BLUE;
    const rightContentLines: string[] = [];

    rightContentLines.push(`${ANSI.BOLD}${this.labels.entitiesHeader || '👤 活跃实体:'}${ANSI.RESET}`);
    if (this.stateLedger.entities.length > 0) {
      for (const c of this.stateLedger.entities.slice(0, 3)) {
        rightContentLines.push(` • ${c.name} ${c.status ? `(${c.status})` : ''}`);
      }
    } else {
      rightContentLines.push(this.labels.emptyEntitiesText || '   (暂无实体记账)');
    }

    rightContentLines.push(`${ANSI.BOLD}${this.labels.assetsHeader || '📦 核心资产:'}${ANSI.RESET}`);
    if (this.stateLedger.assets.length > 0) {
      for (const item of this.stateLedger.assets.slice(0, 2)) {
        rightContentLines.push(` • ${item.name}`);
      }
    } else {
      rightContentLines.push(this.labels.emptyAssetsText || '   (暂无资产记账)');
    }

    rightContentLines.push(`${ANSI.BOLD}${this.labels.tracksHeader || '🔍 追踪项:'}${ANSI.RESET}`);
    if (this.stateLedger.tracks.length > 0) {
      for (const f of this.stateLedger.tracks.slice(0, 2)) {
        const label = f.clue || f.summary || f.id || 'track';
        rightContentLines.push(` • ${label.slice(0, 16)}...`);
      }
    } else {
      rightContentLines.push(this.labels.emptyTracksText || '   (暂无追踪项)');
    }

    rightContentLines.push('─'.repeat(rightWidth - 4));
    rightContentLines.push(`${ANSI.BOLD}${this.labels.dialogueHeader || '🤖 对话流:'}${ANSI.RESET}`);
    if (this.dialogueHistory.length > 0) {
      for (const d of this.dialogueHistory.slice(-4)) {
        rightContentLines.push(`[${d.role === 'user' ? this.labels.userRole : this.labels.assistantRole}] ${d.text.slice(0, 20)}`);
      }
    } else {
      rightContentLines.push(this.labels.emptyDialogueText || ' (无活跃对话)');
    }

    const rightBox = drawBox(this.labels.rightBoxTitle || '📊 状态账本 & Copilot', rightContentLines, rightWidth, mainHeight, rightBorder);

    // 合并三栏
    const combinedRows: string[] = [];
    for (let r = 0; r < mainHeight; r++) {
      const l = leftBox[r] || ' '.repeat(leftWidth);
      const c = centerBox[r] || ' '.repeat(centerWidth);
      const rg = rightBox[r] || ' '.repeat(rightWidth);
      combinedRows.push(`${l} ${c} ${rg}`);
    }

    // 4. Status line
    const wordCount = this.editor.getWordCount();
    let statusText = this.statusMessage;
    if (this.flashMessage && Date.now() < this.flashMessage.expiresAt) {
      const color = this.flashMessage.level === 'error' ? ANSI.FG_RED : this.flashMessage.level === 'warning' ? ANSI.FG_YELLOW : ANSI.FG_GREEN;
      statusText = `${color}⚡ [${this.flashMessage.level.toUpperCase()}] ${this.flashMessage.text}${ANSI.RESET}`;
    }

    const statusLine = `${ANSI.BG_DARK_GRAY}${ANSI.FG_WHITE} ${this.labels.statusBarTitle || 'Studio'} | ${this.labels.statusBarWords || 'Count'}: ${wordCount} | ${this.labels.statusBarFocus || 'Focus'}: ${this.focusMode.toUpperCase()} | ${statusText}${ANSI.RESET}`;
    combinedRows.push(statusLine);

    // 5. Modal rendering
    if (this.activeModal === 'selectList' && this.activeSelectList) {
      const modalLines: string[] = [];
      modalLines.push(`${ANSI.BOLD}${this.activeSelectList.title}${ANSI.RESET}`);
      modalLines.push('─'.repeat(40));
      const items = this.activeSelectList.items || this.activeSelectList.assets || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isSelected = i === this.activeSelectIndex;
        const prefix = isSelected ? `${ANSI.FG_GREEN}👉 [*] ` : '   [ ] ';
        modalLines.push(`${prefix}${item.label}${item.description ? ` (${item.description})` : ''}${ANSI.RESET}`);
      }
      const modalBox = drawBox('Select', modalLines, 50, Math.min(12, modalLines.length + 3), ANSI.FG_YELLOW);
      const startRow = Math.max(2, Math.floor((this.height - modalBox.length) / 2));
      for (let m = 0; m < modalBox.length; m++) {
        if (combinedRows[startRow + m]) {
          combinedRows[startRow + m] = `${modalBox[m]}`;
        }
      }
    }

    return combinedRows.join('\n');
  }

  public flash(text: string, level: 'info' | 'success' | 'warning' | 'error' = 'info', durationMs = 3000): void {
    this.flashMessage = {
      text,
      level,
      expiresAt: Date.now() + durationMs
    };
  }

  public openSelectList<T>(options: SelectListOptions<T>): void {
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

  public renderEntityAvatar(entityName: string): string[] {
    const entity = (this.stateLedger.entities || []).find((candidate: StateLedger['entities'][number]) => candidate.name === entityName);
    return [
      `┌───────────┐`,
      `│  (•‿•)   │  Entity: ${entityName}`,
      `│  /| ★ |\\  │  Status: ${entity?.status || 'active'}`,
      `└───────────┘`
    ];
  }

  public renderFullFrame(): string {
    return this.renderScreen();
  }

  public renderDifferential(): { isDiff: boolean; content: string } {
    const current = this.renderScreen();
    const result = this.differentialRenderer.render(current);
    return {
      isDiff: result.changedLines > 0,
      content: result.changedLines === 0 ? '' : current
    };
  }


  public async handleInput(input: string): Promise<string> {
    const trimmed = input.trim();

    if (this.activeModal === 'selectList') {
      if (input === '\u001b[A' || trimmed === 'UP' || trimmed === 'k') {
        this.selectPrev();
        return 'Selection up';
      }
      if (input === '\u001b[B' || trimmed === 'DOWN' || trimmed === 'j') {
        this.selectNext();
        return 'Selection down';
      }
      if (input === '\r' || trimmed === 'ENTER') {
        const val = this.confirmSelection();
        return `Selected: ${JSON.stringify(val)}`;
      }
      if (input === '\u001b' || trimmed === 'ESC') {
        this.closeModal();
        return 'Modal closed';
      }
    }

    if (input === '\t' || trimmed.toUpperCase() === 'TAB') {
      if (this.ghost.hasGhostText()) {
        this.ghost.acceptGhostText();
        this.statusMessage = 'Ghost text accepted';
        return 'Ghost text accepted';
      }
      return 'No active ghost text';
    }

    if (trimmed.toLowerCase() === ':focus outline') {
      this.setFocus('outline');
      return 'Focused on outline';
    }
    if (trimmed.toLowerCase() === ':focus editor') {
      this.setFocus('editor');
      return 'Focused on editor';
    }
    if (trimmed.toLowerCase() === ':focus copilot') {
      this.setFocus('copilot');
      return 'Focused on copilot';
    }
    if (trimmed.toLowerCase() === ':focus ledger') {
      this.setFocus('ledger');
      return 'Focused on ledger';
    }

    if (this.slashRegistry.isSlashSyntax(trimmed)) {
      const res = await this.slashRegistry.execute(trimmed, {
        agent: this.agent,
        tree: this.tree
      });
      this.dialogueHistory.push({ role: 'user', text: trimmed, timestamp: Date.now() });
      this.dialogueHistory.push({ role: 'assistant', text: res.output, timestamp: Date.now() });
      this.statusMessage = this.labels.commandExecutedStatus?.(trimmed) || `Command executed: ${trimmed}`;
      return res.output;
    }

    this.editor.insertText(this.editor.getText().length, trimmed + '\n');
    this.statusMessage = this.labels.insertedStatus?.(trimmed.length) || `Inserted ${trimmed.length} characters`;
    return 'Text inserted';
  }
}

export const TuiStudio = TerminalStudio;
