import { describe, it, expect } from 'vitest';
import {
  HeadlessEditorState,
  GhostTextManager,
  ImeProtectionManager,
  formatChineseTypography,
  formatWesternTypography
} from '@inkpi/editor-core';

describe('@inkpi/editor-core', () => {
  it('should maintain Document AST and support undo/redo transactions', () => {
    const editor = new HeadlessEditorState('第一段');
    expect(editor.getText()).toBe('第一段');
    expect(editor.getWordCount()).toBe(3);

    // Insert text
    editor.insertText(3, '，风云突变。');
    expect(editor.getText()).toBe('第一段，风云突变。');
    expect(editor.getUndoStackDepth()).toBe(1);

    // Undo
    const undone = editor.undo();
    expect(undone).toBe(true);
    expect(editor.getText()).toBe('第一段');
    expect(editor.getRedoStackDepth()).toBe(1);

    // Redo
    const redone = editor.redo();
    expect(redone).toBe(true);
    expect(editor.getText()).toBe('第一段，风云突变。');

    // Delete range
    editor.deleteRange(0, 3);
    expect(editor.getText()).toBe('，风云突变。');
  });

  it('should maintain zero AST and zero Undo pollution for Ghost Text decoration', () => {
    const editor = new HeadlessEditorState('夜幕低垂');
    const ghost = new GhostTextManager(editor);

    const initialVersion = editor.getVersion();
    const initialUndoDepth = editor.getUndoStackDepth();

    // 1. Trigger ghost text
    const suggestion = ghost.setGhostText(4, '，长风呼啸。');
    expect(suggestion.text).toBe('，长风呼啸。');
    expect(ghost.hasGhostText()).toBe(true);

    // Assert zero AST pollution & zero Undo pollution
    expect(editor.getVersion()).toBe(initialVersion);
    expect(editor.getUndoStackDepth()).toBe(initialUndoDepth);
    expect(editor.getText()).toBe('夜幕低垂'); // AST unaffected!

    // 2. Dismiss ghost text (e.g. user pressed Esc or typed another entity)
    ghost.dismissGhostText();
    expect(ghost.hasGhostText()).toBe(false);
    expect(editor.getVersion()).toBe(initialVersion);
    expect(editor.getUndoStackDepth()).toBe(initialUndoDepth);
    expect(editor.getText()).toBe('夜幕低垂');

    // 3. Re-set and Accept ghost text (e.g. user pressed Tab)
    ghost.setGhostText(4, '，长剑出鞘。');
    const accepted = ghost.acceptGhostText();
    expect(accepted).toBe(true);
    expect(ghost.hasGhostText()).toBe(false);

    // Now text is written to AST, and atomic Undo transaction is recorded!
    expect(editor.getText()).toBe('夜幕低垂，长剑出鞘。');
    expect(editor.getUndoStackDepth()).toBe(initialUndoDepth + 1);

    // One-click undo for accepted ghost text
    editor.undo();
    expect(editor.getText()).toBe('夜幕低垂');
  });

  it('should protect IME composition state', () => {
    const ime = new ImeProtectionManager();
    expect(ime.isCompositionActive()).toBe(false);

    ime.onCompositionStart();
    expect(ime.isCompositionActive()).toBe(true);

    ime.onCompositionUpdate('nihao');
    expect(ime.getCompositionText()).toBe('nihao');

    const result = ime.onCompositionEnd('你好');
    expect(result).toBe('你好');
    expect(ime.isCompositionActive()).toBe(false);
  });

  it('should apply Chinese and Western typography formatting', () => {
    const rawCn = '第一段text\n第二段text';
    const formattedCn = formatChineseTypography(rawCn);
    expect(formattedCn).toBe('\u3000\u3000第一段text\n\u3000\u3000第二段text');

    const rawEn = 'Document 1   The beginning   of dawn.';
    const formattedEn = formatWesternTypography(rawEn);
    expect(formattedEn).toBe('Document 1 The beginning of dawn.');
  });
});
