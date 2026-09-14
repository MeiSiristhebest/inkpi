import {
  ToolRegistry,
  applyFuzzyTextEdit,
  createDocumentResourceTools,
  enforceOutputGuard,
  fuzzyFindText
} from '@inkpi/agent-core';
import type { DocumentResourceAdapter, ResourceMutationProposal } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core: Generic Resource Tools & Fuzzy Hunk Engine', () => {
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

  describe('3. Injected Resource Adapter in ToolRegistry', () => {
    it('should read resources and record mutation proposals without direct writes', async () => {
      const resources = new Map([['resource-1', '第一章：青云初试。\n少年名为林远。']]);
      const proposals: ResourceMutationProposal[] = [];
      const adapter: DocumentResourceAdapter = {
        read: async (resourceId) => resources.get(resourceId) ?? null,
        list: async () => Array.from(resources, ([resourceId, content]) => ({ resourceId, size: content.length })),
        search: async (query) =>
          Array.from(resources)
            .filter(([, content]) => content.includes(query))
            .map(([resourceId, content]) => ({ resourceId, snippet: content })),
        proposeMutation: async (proposal) => {
          proposals.push(proposal);
          return {
            proposalId: `proposal-${proposals.length}`,
            status: 'proposed',
            resourceId: proposal.resourceId,
            operation: proposal.operation
          };
        }
      };
      const tools = createDocumentResourceTools(adapter);
      const registry = new ToolRegistry();
      for (const tool of tools) {
        registry.register(tool);
      }

      expect(registry.get('read_resource')).toBeDefined();
      expect(registry.get('list_resources')).toBeDefined();
      expect(registry.get('search_resources')).toBeDefined();
      expect(registry.get('propose_resource_mutation')).toBeDefined();
      expect(registry.get('edit_text')).toBeUndefined();
      expect(registry.get('write_draft')).toBeUndefined();

      const readRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call-1',
        name: 'read_resource',
        arguments: { resourceId: 'resource-1' }
      });
      expect(readRes.isError).toBe(false);
      expect((readRes.content[0] as any).text).toContain('林远');

      const searchRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call-2',
        name: 'search_resources',
        arguments: { query: '青云初试' }
      });
      expect(searchRes.isError).toBe(false);
      expect((searchRes.content[0] as any).text).toContain('resource-1');

      const proposalRes = await registry.executeTool({
        type: 'toolCall',
        id: 'call-3',
        name: 'propose_resource_mutation',
        arguments: {
          resourceId: 'resource-1',
          operation: 'replace',
          content: '第一章：青云初试。\n少年名为林远，手持一柄青玉佩。'
        }
      });
      expect(proposalRes.isError).toBe(false);
      expect((proposalRes.content[0] as any).text).toContain('proposal-1');
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ resourceId: 'resource-1', operation: 'replace' });
      expect(resources.get('resource-1')).not.toContain('青玉佩');

      const invalidProposal = await registry.executeTool({
        type: 'toolCall',
        id: 'call-4',
        name: 'propose_resource_mutation',
        arguments: { resourceId: 'resource-1', operation: 'delete', content: '' }
      });
      expect(invalidProposal.isError).toBe(true);
    });
  });
});
