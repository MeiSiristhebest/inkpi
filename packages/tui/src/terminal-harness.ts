import { HeadlessEditorState, GhostTextManager, formatTypography } from '@inkpi/editor-core';
import type { TypographyOptions } from '@inkpi/protocol';
import type { Agent } from '@inkpi/agent-core';
import type { SessionTree } from '@inkpi/agent-core';
import { SlashCommandRegistry } from '@inkpi/agent-core';
import { ANSI, drawBox } from './render.js';

export interface TerminalHarnessOptions {
  agent?: Agent;
  tree?: SessionTree;
  width?: number;
  height?: number;
  initialResources?: Array<{ title: string; wordCount: number; active?: boolean }>;
  labels?: Partial<TerminalHarnessLabels>;
  typography?: (Partial<TypographyOptions> & { mode?: 'chinese' | 'western' | 'none' }) | false;
}

export interface TerminalHarnessLabels {
  resources: string;
  editor: string;
  console: string;
  ghostSuggestion: string;
  acceptSuggestion: string;
  inserted: string;
  accepted: string;
  ready: string;
  resourceMetric: (wordCount: number) => string;
}

/**
 * Headless terminal interaction harness.
 *
 * 原位于 `@inkpi/agent-core/src/tui/terminal-harness.ts`，作为表现层被错误地放在
 * 领域核心包内。现迁移至 `@inkpi/tui`。领域类型从 `@inkpi/agent-core` 引入，
 * 渲染原语取包内实现。详见 ARCHITECTURE.md §5。
 */
export class TerminalHarness {
  public editor: HeadlessEditorState;
  public ghost: GhostTextManager;
  public slashRegistry: SlashCommandRegistry;
  public agent?: Agent;
  public tree?: SessionTree;

  public currentResourceTitle = 'Untitled resource';
  public resourceList: Array<{ title: string; wordCount: number; active: boolean }>;

  private logs: string[];
  private width: number;
  private height: number;
  private typography: TerminalHarnessOptions['typography'];
  private labels: TerminalHarnessLabels;

  constructor(options: TerminalHarnessOptions = {}) {
    this.editor = new HeadlessEditorState();
    this.ghost = new GhostTextManager(this.editor);
    this.slashRegistry = new SlashCommandRegistry();
    this.agent = options.agent;
    this.tree = options.tree;
    this.width = options.width || 90;
    this.height = options.height || 26;
    this.typography = options.typography;
    this.labels = {
      resources: 'Resources',
      editor: 'Editor',
      console: 'Console',
      ghostSuggestion: 'Suggestion',
      acceptSuggestion: 'Tab to accept',
      inserted: 'Inserted',
      accepted: 'Suggestion accepted',
      ready: 'Ready',
      resourceMetric: (wordCount) => `${wordCount}`,
      ...options.labels
    };
    this.resourceList = (options.initialResources || [
      { title: 'Untitled resource', wordCount: 0, active: true }
    ]).map((resource, index) => ({
      ...resource,
      active: resource.active ?? index === 0
    }));
    this.currentResourceTitle = this.resourceList.find((resource) => resource.active)?.title
      || this.resourceList[0]?.title
      || 'Untitled resource';
    this.logs = [this.labels.ready];
  }

  /**
   * 渲染当前终端全屏帧
   */
  public renderScreen(): string {
    const leftWidth = 26;
    const rightWidth = this.width - leftWidth - 1;
    const topHeight = Math.floor(this.height * 0.6);
    const bottomHeight = this.height - topHeight - 1;

    // 1. 左侧资源栏
    const outlineLines: string[] = this.resourceList.map((res) => {
      const prefix = res.active ? `${ANSI.FG_CYAN}👉 ` : '   ';
      const title = `${res.title} (${this.labels.resourceMetric(res.wordCount)})`;
      return `${prefix}${title}${ANSI.RESET}`;
    });
    const leftBox = drawBox(this.labels.resources, outlineLines, leftWidth, topHeight, ANSI.FG_CYAN);

    // 2. 右侧编辑与幽灵提示
    const rawText = this.editor.getText();
    const formatted = this.typography
      ? formatTypography(rawText, this.typography)
      : rawText;
    const textLines = formatted.split('\n');

    if (this.ghost.hasGhostText()) {
      const ghost = this.ghost.getGhostText();
      if (ghost) {
        textLines.push(`${ANSI.FG_GRAY}${this.labels.ghostSuggestion}: ${ghost.text} ${ANSI.FG_YELLOW}(${this.labels.acceptSuggestion})${ANSI.RESET}`);
      }
    }

    const rightBox = drawBox(`${this.labels.editor} - ${this.currentResourceTitle}`, textLines, rightWidth, topHeight, ANSI.FG_GREEN);

    // Combine top left & right
    const combinedTop: string[] = [];
    for (let i = 0; i < topHeight; i++) {
      combinedTop.push((leftBox[i] || '') + ' ' + (rightBox[i] || ''));
    }

    // 3. 底部 AI 副驾驶与控制台
    const bottomBox = drawBox(this.labels.console, this.logs.slice(-bottomHeight + 3), this.width, bottomHeight, ANSI.FG_YELLOW);

    return combinedTop.join('\n') + '\n' + bottomBox.join('\n');
  }

  /**
   * 处理键盘与指令输入
   */
  public async handleInput(input: string): Promise<string> {
    const trimmed = input.trim();

    // 1. Tab 键触发采纳幽灵文本
    if (input === '\t' || trimmed.toUpperCase() === 'TAB') {
      if (this.ghost.hasGhostText()) {
        const accepted = this.ghost.acceptGhostText();
        this.logs.push(`${this.labels.accepted}: ${accepted ? 'ok' : 'failed'}`);
        return 'Ghost text accepted';
      }
      return 'No active ghost text';
    }

    // 2. 斜杠指令
    if (this.slashRegistry.isSlashSyntax(trimmed)) {
      const res = await this.slashRegistry.execute(trimmed, {
        agent: this.agent,
        tree: this.tree
      });
      this.logs.push(`> ${trimmed}`);
      this.logs.push(res.output);
      return res.output;
    }

    // Default input is an editor operation; the harness does not infer a
    // document type or invoke a domain-specific generation workflow.
    this.editor.insertText(this.editor.getText().length, trimmed + '\n');
    this.logs.push(`${this.labels.inserted}: ${trimmed.slice(0, 30)}...`);
    return 'Text inserted';
  }

  public log(msg: string): void {
    this.logs.push(msg);
  }
}
