import { formatTypography } from '@inkpi/editor-core';
import type { StateLedger } from '@inkpi/protocol';
import { ANSI, DifferentialRenderer, drawBox } from './render.js';
import type { StudioModel } from './studio-model.js';

/**
 * Studio 三层分离之 **View**：从 Model 读取状态，纯渲染，不做任何状态迁移。
 *
 * 从 `TerminalStudio` 原地拆出（P2-#12）。`renderScreen` 的输出与拆分前逐字节一致；
 * 唯一的内部可变状态是差分渲染器缓存，属于渲染基础设施而非业务状态。
 */
export class StudioView {
  private readonly model: StudioModel;
  private readonly differentialRenderer = new DifferentialRenderer();

  constructor(model: StudioModel) {
    this.model = model;
  }

  /** Render the three-pane workstation frame. */
  public renderScreen(): string {
    const leftWidth = 24;
    const rightWidth = 34;
    const centerWidth = Math.max(30, this.model.getWidth() - leftWidth - rightWidth - 2);
    const mainHeight = this.model.getHeight() - 3;

    const leftBox = this.renderResourcePane(leftWidth, mainHeight);
    const centerBox = this.renderEditorPane(centerWidth, mainHeight);
    const rightBox = this.renderStatePane(rightWidth, mainHeight);

    const combinedRows: string[] = [];
    for (let r = 0; r < mainHeight; r++) {
      const l = leftBox[r] || ' '.repeat(leftWidth);
      const c = centerBox[r] || ' '.repeat(centerWidth);
      const rg = rightBox[r] || ' '.repeat(rightWidth);
      combinedRows.push(`${l} ${c} ${rg}`);
    }

    // Status line
    const wordCount = this.model.editor.getWordCount();
    let statusText = this.model.getStatusMessage();
    if (this.model.flashMessage && Date.now() < this.model.flashMessage.expiresAt) {
      const color =
        this.model.flashMessage.level === 'error'
          ? ANSI.FG_RED
          : this.model.flashMessage.level === 'warning'
            ? ANSI.FG_YELLOW
            : ANSI.FG_GREEN;
      statusText = `${color}⚡ [${this.model.flashMessage.level.toUpperCase()}] ${this.model.flashMessage.text}${ANSI.RESET}`;
    }

    const labels = this.model.labels;
    const statusLine = `${ANSI.BG_DARK_GRAY}${ANSI.FG_WHITE} ${labels.statusBarTitle || 'Studio'} | ${labels.statusBarWords || 'Count'}: ${wordCount} | ${labels.statusBarFocus || 'Focus'}: ${this.model.focusMode.toUpperCase()} | ${statusText}${ANSI.RESET}`;
    combinedRows.push(statusLine);

    // Modal rendering
    this.applyModalOverlay(combinedRows);

    return combinedRows.join('\n');
  }

  public renderEntityAvatar(entityName: string): string[] {
    const entity = (this.model.stateLedger.entities || []).find(
      (candidate: StateLedger['entities'][number]) => candidate.name === entityName
    );
    return [
      '┌───────────┐',
      `│  (•‿•)   │  Entity: ${entityName}`,
      `│  /| ★ |\\  │  Status: ${entity?.status || 'active'}`,
      '└───────────┘'
    ];
  }

  public renderDifferential(): { isDiff: boolean; content: string } {
    const current = this.renderScreen();
    const result = this.differentialRenderer.render(current);
    return {
      isDiff: result.changedLines > 0,
      content: result.changedLines === 0 ? '' : current
    };
  }

  /** 左栏：资源目录树。 */
  private renderResourcePane(leftWidth: number, mainHeight: number): string[] {
    const labels = this.model.labels;
    const outlineBorder = this.model.focusMode === 'outline' ? ANSI.FG_YELLOW : ANSI.FG_CYAN;
    const outlineLines: string[] = this.model.resources.map((res, idx) => {
      const activeMark = idx === this.model.activeResourceIndex ? '👉 ' : '   ';
      const status = res.status ? `[${res.status}] ` : '';
      const metric = labels.resourceMetric?.(res.wordCount) || `${res.wordCount}`;
      return `${activeMark}${status}${res.title} (${metric})`;
    });
    return drawBox(labels.leftBoxTitle || '📚 资源目录树', outlineLines, leftWidth, mainHeight, outlineBorder);
  }

  /** 中栏：编辑器与 ghost 文本。 */
  private renderEditorPane(centerWidth: number, mainHeight: number): string[] {
    const isStreaming = this.model.agent?.state?.isStreaming;
    const labels = this.model.labels;
    // 对齐上游 v0.85.0 PR #8799：流式工作指示器融合到编辑器边框，跟随思考/流式状态动态变化
    const editorBorder = isStreaming ? ANSI.FG_CYAN : this.model.focusMode === 'editor' ? ANSI.FG_GREEN : ANSI.FG_GRAY;
    const currentResource = this.model.resources[this.model.activeResourceIndex] || {
      title: 'Untitled resource'
    };
    const rawContent = this.model.editor.getText();
    const typography = this.model.getTypography();
    const formattedContent = typography ? formatTypography(rawContent, typography) : rawContent;
    const contentLines = formattedContent ? formattedContent.split('\n') : [labels.emptyContentText || '(empty)'];

    if (this.model.ghost.hasGhostText()) {
      const gt = this.model.ghost.getGhostText();
      if (gt) {
        contentLines.push(
          `${ANSI.FG_GRAY}${labels.ghostSuggestion || 'Suggestion'}: ${gt.text} ${ANSI.FG_YELLOW}(${labels.acceptSuggestion || 'Tab to accept'})${ANSI.RESET}`
        );
      }
    }
    const spinnerPrefix = isStreaming ? `${ANSI.FG_CYAN}⠋ ` : '';
    const title = `${spinnerPrefix}${labels.editorTitle || 'Editor'} - ${currentResource.title} (${labels.resourceMetric?.(this.model.editor.getWordCount()) || this.model.editor.getWordCount()})${isStreaming ? ANSI.RESET : ''}`;
    return drawBox(title, contentLines, centerWidth, mainHeight, editorBorder);
  }

  /** 右栏：运行时状态账本与对话流。 */
  private renderStatePane(rightWidth: number, mainHeight: number): string[] {
    const labels = this.model.labels;
    const rightBorder =
      this.model.focusMode === 'copilot' || this.model.focusMode === 'ledger' ? ANSI.FG_MAGENTA : ANSI.FG_BLUE;
    const rightContentLines: string[] = [];

    rightContentLines.push(`${ANSI.BOLD}${labels.entitiesHeader || '👤 活跃实体:'}${ANSI.RESET}`);
    if (this.model.stateLedger.entities.length > 0) {
      for (const c of this.model.stateLedger.entities.slice(0, 3)) {
        rightContentLines.push(` • ${c.name} ${c.status ? `(${c.status})` : ''}`);
      }
    } else {
      rightContentLines.push(labels.emptyEntitiesText || '   (暂无实体记账)');
    }

    rightContentLines.push(`${ANSI.BOLD}${labels.assetsHeader || '📦 核心资产:'}${ANSI.RESET}`);
    if (this.model.stateLedger.assets.length > 0) {
      for (const item of this.model.stateLedger.assets.slice(0, 2)) {
        rightContentLines.push(` • ${item.name}`);
      }
    } else {
      rightContentLines.push(labels.emptyAssetsText || '   (暂无资产记账)');
    }

    rightContentLines.push(`${ANSI.BOLD}${labels.tracksHeader || '🔍 追踪项:'}${ANSI.RESET}`);
    if (this.model.stateLedger.tracks.length > 0) {
      for (const f of this.model.stateLedger.tracks.slice(0, 2)) {
        const label = f.clue || f.summary || f.id || 'track';
        rightContentLines.push(` • ${label.slice(0, 16)}...`);
      }
    } else {
      rightContentLines.push(labels.emptyTracksText || '   (暂无追踪项)');
    }

    rightContentLines.push('─'.repeat(rightWidth - 4));
    rightContentLines.push(`${ANSI.BOLD}${labels.dialogueHeader || '🤖 对话流:'}${ANSI.RESET}`);
    if (this.model.dialogueHistory.length > 0) {
      for (const d of this.model.dialogueHistory.slice(-4)) {
        rightContentLines.push(
          `[${d.role === 'user' ? labels.userRole : labels.assistantRole}] ${d.text.slice(0, 20)}`
        );
      }
    } else {
      rightContentLines.push(labels.emptyDialogueText || ' (无活跃对话)');
    }

    return drawBox(
      labels.rightBoxTitle || '📊 状态账本 & Copilot',
      rightContentLines,
      rightWidth,
      mainHeight,
      rightBorder
    );
  }

  /** 在已组合的行上叠加 selectList 模态框（原地修改 combinedRows）。 */
  private applyModalOverlay(combinedRows: string[]): void {
    if (this.model.activeModal === 'selectList' && this.model.activeSelectList) {
      const modalLines: string[] = [];
      modalLines.push(`${ANSI.BOLD}${this.model.activeSelectList.title}${ANSI.RESET}`);
      modalLines.push('─'.repeat(40));
      const items = this.model.activeSelectList.items || this.model.activeSelectList.assets || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isSelected = i === this.model.activeSelectIndex;
        const prefix = isSelected ? `${ANSI.FG_GREEN}👉 [*] ` : '   [ ] ';
        modalLines.push(`${prefix}${item.label}${item.description ? ` (${item.description})` : ''}${ANSI.RESET}`);
      }
      const modalBox = drawBox('Select', modalLines, 50, Math.min(12, modalLines.length + 3), ANSI.FG_YELLOW);
      const startRow = Math.max(2, Math.floor((this.model.getHeight() - modalBox.length) / 2));
      for (let m = 0; m < modalBox.length; m++) {
        if (combinedRows[startRow + m]) {
          combinedRows[startRow + m] = `${modalBox[m]}`;
        }
      }
    }
  }
}
