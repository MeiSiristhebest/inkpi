import {
  InMemoryDocumentStore,
  ToolRegistry,
  applyFuzzyTextEdit,
  createAuthoringTools,
  enforceOutputGuard,
  fuzzyFindText
} from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core: Native Authoring Tools & Fuzzy Hunk Engine', () => {
  describe('1. Fuzzy Hunk Matching & Diff Engine', () => {
    it('should perform exact match when lines match exactly', () => {
      const doc = '第一章 序幕\n风雪漫天，少年仗剑独行。\n远处的破庙隐隐透出火光。\n他停下了脚步。';
      const oldText = '风雪漫天，少年仗剑独行。\n远处的破庙隐隐透出火光。';
      const match = fuzzyFindText(doc, oldText);
      expect(match.found).toBe(true);
      expect(match.usedFuzzyMatch).toBe(false);
    });

    it('should fuzzy match through punctuation, whitespace, and smart quote variations', () => {
      const doc = '第一章 序幕\n老者说道：“天命难违，你当真要去？”\n少年沉默不语。';
      // 模型传回来的 oldText 把弯引号写成了直引号，全角逗号写成半角，行尾带了空格
      const oldText = '老者说道:"天命难违,你当真要去?"  ';
      const match = fuzzyFindText(doc, oldText);
      expect(match.found).toBe(true);
      expect(match.usedFuzzyMatch).toBe(true);
    });

    it('should apply atomic edit cleanly without corrupting other sections', () => {
      const original = '第一章 序幕\n老者说道：“天命难违，你当真要去？”\n少年沉默不语。';
      const result = applyFuzzyTextEdit(original, {
        oldText: '老者说道:"天命难违,你当真要去?"',
        newText: '老者叹息道：“天道无常，你可想好了？”'
      });
      expect(result.success).toBe(true);
      expect(result.newContent).toContain('老者叹息道：“天道无常，你可想好了？”');
      expect(result.newContent).toContain('第一章 序幕');
      expect(result.newContent).toContain('少年沉默不语。');
    });
  });

  describe('2. Output Guard', () => {
    it('should not truncate when within limits', () => {
      const guard = enforceOutputGuard('正常创作文本', { maxCharacters: 100 });
      expect(guard.truncated).toBe(false);
      expect(guard.content).toBe('正常创作文本');
    });

    it('should truncate and attach notice when exceeding maxCharacters', () => {
      const longText = 'a'.repeat(500);
      const guard = enforceOutputGuard(longText, { maxCharacters: 200 });
      expect(guard.truncated).toBe(true);
      expect(guard.content.length).toBeLessThan(500);
      expect(guard.content).toContain('[Output truncated at 200 characters');
    });
  });

  describe('3. Native Authoring Tools in ToolRegistry', () => {
    it('should register and execute authoring tools successfully', async () => {
      const store = new InMemoryDocumentStore();
      const tools = createAuthoringTools(store);
      const registry = new ToolRegistry();
      for (const tool of tools) {
        registry.register(tool);
      }

      expect(registry.get('read_chapter')).toBeDefined();
      expect(registry.get('edit_text')).toBeDefined();
      expect(registry.get('write_draft')).toBeDefined();
      expect(registry.get('list_story_outline')).toBeDefined();
      expect(registry.get('search_story_memory')).toBeDefined();
      expect(registry.get('generate_book_cover')).toBeDefined();

      // 1. write_draft
      const writeRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call_1',
        name: 'write_draft',
        arguments: {
          documentId: 'ch1',
          content: '第一章：青云初试。\n少年名为林远，手持一柄青玉佩。',
          mode: 'create'
        }
      });
      expect(writeRes.isError).toBe(false);

      // 2. read_chapter
      const readRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call_2',
        name: 'read_chapter',
        arguments: { documentId: 'ch1' }
      });
      expect(readRes.isError).toBe(false);
      expect((readRes.content[0] as any).text).toContain('林远');

      // 3. search_story_memory (记忆雷达)
      const searchRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call_3',
        name: 'search_story_memory',
        arguments: { query: '青玉佩' }
      });
      expect(searchRes.isError).toBe(false);
      expect((searchRes.content[0] as any).text).toContain('青玉佩');

      // 4. edit_text (局部手术刀)
      const editRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call_4',
        name: 'edit_text',
        arguments: {
          documentId: 'ch1',
          oldText: '手持一柄青玉佩。',
          newText: '怀揣一枚黑铁戒。'
        }
      });
      expect(editRes.isError).toBe(false);

      // 验证修改生效且其他正文完整
      const verifyRead = await registry.executeTool({
        type: 'toolCall',
        id: 'call_5',
        name: 'read_chapter',
        arguments: { documentId: 'ch1' }
      });
      expect((verifyRead.content[0] as any).text).toContain('怀揣一枚黑铁戒');
      expect((verifyRead.content[0] as any).text).toContain('第一章：青云初试');

      // 5. list_story_outline
      const outlineRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call_6',
        name: 'list_story_outline',
        arguments: {}
      });
      expect((outlineRes.content[0] as any).text).toContain('ch1');
    });
  });
});
