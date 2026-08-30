import { HeadlessEditorState, GhostTextManager, formatChineseTypography } from '@inkpi/editor-core';
import type { Agent } from '../agent.js';
import type { SessionTree } from '../tree.js';
import { SlashCommandRegistry } from '../slash-commands.js';
import { ANSI, drawBox } from './render.js';

export interface TerminalHarnessOptions {
  agent?: Agent;
  tree?: SessionTree;
  width?: number;
  height?: number;
}

/**
 * InkPi 终端工作台 (1:1 对标 repos/pi Interactive Terminal Mode)
 */
export class TerminalWriterHarness {
  public editor: HeadlessEditorState;
  public ghost: GhostTextManager;
  public slashRegistry: SlashCommandRegistry;
  public agent?: Agent;
  public tree?: SessionTree;
  
  public currentResourceTitle = '新建文档';
  public resourceList = [
    { title: '新建文档', wordCount: 0, active: true }
  ];

  private logs: string[] = ['欢迎使用 InkPi 终端。输入 /help 查看指令。'];
  private width: number;
  private height: number;

  constructor(options: TerminalHarnessOptions = {}) {
    this.editor = new HeadlessEditorState();
    this.ghost = new GhostTextManager(this.editor);
    this.slashRegistry = new SlashCommandRegistry();
    this.agent = options.agent;
    this.tree = options.tree;
    this.width = options.width || 90;
    this.height = options.height || 26;
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
      const title = `${res.title} (${res.wordCount}字)`;
      return `${prefix}${title}${ANSI.RESET}`;
    });
    const leftBox = drawBox('📚 资源列表', outlineLines, leftWidth, topHeight, ANSI.FG_CYAN);

    // 2. 右侧编辑与幽灵提示
    const rawText = this.editor.getText();
    const formatted = formatChineseTypography(rawText);
    const textLines = formatted.split('\n');

    if (this.ghost.hasGhostText()) {
      const ghost = this.ghost.getGhostText();
      if (ghost) {
        textLines.push(`${ANSI.FG_GRAY}👻 [建议] ${ghost.text} ${ANSI.FG_YELLOW}(Tab采纳)${ANSI.RESET}`);
      }
    }

    const rightBox = drawBox(`✍️ 编辑 - ${this.currentResourceTitle}`, textLines, rightWidth, topHeight, ANSI.FG_GREEN);

    // Combine top left & right
    const combinedTop: string[] = [];
    for (let i = 0; i < topHeight; i++) {
      combinedTop.push((leftBox[i] || '') + ' ' + (rightBox[i] || ''));
    }

    // 3. 底部 AI 副驾驶与控制台
    const bottomBox = drawBox('🤖 AI 副驾驶 & 控制台', this.logs.slice(-bottomHeight + 3), this.width, bottomHeight, ANSI.FG_YELLOW);

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
        this.logs.push(`✅ 已采纳 AI 幽灵建议 (${accepted ? '成功' : '失败'})`);
        return 'Ghost text accepted';
      }
      return 'No active ghost text';
    }

    // 2. 斜杠指令
    if (this.slashRegistry.isSlashCommand(trimmed)) {
      const res = await this.slashRegistry.execute(trimmed, {
        agent: this.agent,
        tree: this.tree
      });
      this.logs.push(`> ${trimmed}`);
      this.logs.push(res.output);
      return res.output;
    }

    // 3. 默认文本输入写入正文
    this.editor.insertText(this.editor.getText().length, trimmed + '\n');
    this.logs.push(`✍️ 写入内容: ${trimmed.slice(0, 30)}...`);
    return 'Text inserted';
  }

  public log(msg: string): void {
    this.logs.push(msg);
  }
}
