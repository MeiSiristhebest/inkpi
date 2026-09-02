import type { StudioModel } from './studio-model.js';
import type { StudioDialogueEntry, StudioFocusMode } from './studio-types.js';

/**
 * Studio 三层分离之 **Controller**：把原始输入翻译为对 Model 的状态迁移意图。
 *
 * 从 `TerminalStudio.handleInput` 原地拆出（P2-#12）。
 * 控制器不持有任何业务状态，也不直接触碰渲染；所有写入都经由 `StudioModel` 的
 * 公开方法完成，返回字符串与拆分前逐字一致（调用方可能断言其字面值）。
 */
export class StudioController {
  private readonly model: StudioModel;

  constructor(model: StudioModel) {
    this.model = model;
  }

  public async handleInput(input: string): Promise<string> {
    const trimmed = input.trim();

    if (this.model.activeModal === 'selectList') {
      if (input === '\u001b[A' || trimmed === 'UP' || trimmed === 'k') {
        this.model.selectPrev();
        return 'Selection up';
      }
      if (input === '\u001b[B' || trimmed === 'DOWN' || trimmed === 'j') {
        this.model.selectNext();
        return 'Selection down';
      }
      if (input === '\r' || trimmed === 'ENTER') {
        const val = this.model.confirmSelection();
        return `Selected: ${JSON.stringify(val)}`;
      }
      if (input === '\u001b' || trimmed === 'ESC') {
        this.model.closeModal();
        return 'Modal closed';
      }
    }

    if (input === '\t' || trimmed.toUpperCase() === 'TAB') {
      if (this.model.ghost.hasGhostText()) {
        this.model.ghost.acceptGhostText();
        this.model.setStatusMessage('Ghost text accepted');
        return 'Ghost text accepted';
      }
      return 'No active ghost text';
    }

    const focusTargets: Array<{ token: string; mode: StudioFocusMode; reply: string }> = [
      { token: ':focus outline', mode: 'outline', reply: 'Focused on outline' },
      { token: ':focus editor', mode: 'editor', reply: 'Focused on editor' },
      { token: ':focus copilot', mode: 'copilot', reply: 'Focused on copilot' },
      { token: ':focus ledger', mode: 'ledger', reply: 'Focused on ledger' }
    ];
    for (const target of focusTargets) {
      if (trimmed.toLowerCase() === target.token) {
        this.model.setFocus(target.mode);
        return target.reply;
      }
    }

    if (this.model.slashRegistry.isSlashSyntax(trimmed)) {
      const res = await this.model.slashRegistry.execute(trimmed, {
        agent: this.model.agent,
        tree: this.model.tree
      });
      const userEntry: StudioDialogueEntry = { role: 'user', text: trimmed, timestamp: Date.now() };
      const assistantEntry: StudioDialogueEntry = { role: 'assistant', text: res.output, timestamp: Date.now() };
      this.model.dialogueHistory.push(userEntry, assistantEntry);
      this.model.setStatusMessage(
        this.model.labels.commandExecutedStatus?.(trimmed) || `Command executed: ${trimmed}`
      );
      return res.output;
    }

    this.model.editor.insertText(this.model.editor.getText().length, trimmed + '\n');
    this.model.setStatusMessage(
      this.model.labels.insertedStatus?.(trimmed.length) || `Inserted ${trimmed.length} characters`
    );
    return 'Text inserted';
  }
}
