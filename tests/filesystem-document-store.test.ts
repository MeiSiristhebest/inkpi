import { ToolRegistry, createDocumentResourceTools } from '@inkpi/agent-core';
import type { DocumentResourceAdapter, ResourceMutationProposal } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core: injected resource adapter boundary', () => {
  it('delegates reads and mutation proposals without writing the authority', async () => {
    let authoritativeContent = '第一章 天元大陆\n少年萧晨立于山巅。';
    const proposals: ResourceMutationProposal[] = [];
    const adapter: DocumentResourceAdapter = {
      read: async (resourceId) => (resourceId === 'chapter_01' ? authoritativeContent : null),
      list: async () => [{ resourceId: 'chapter_01', size: authoritativeContent.length }],
      proposeMutation: async (proposal) => {
        proposals.push(proposal);
        return {
          proposalId: 'proposal-chapter-01',
          status: 'proposed',
          resourceId: proposal.resourceId,
          operation: proposal.operation
        };
      }
    };
    const registry = new ToolRegistry();
    for (const tool of createDocumentResourceTools(adapter)) registry.register(tool);

    const readRes = await registry.executeTool({
      type: 'toolCall',
      id: 'read-1',
      name: 'read_resource',
      arguments: { resourceId: 'chapter_01' }
    });
    expect(readRes.isError).toBe(false);
    expect((readRes.content[0] as any).text).toContain('天元大陆');

    const proposalRes = await registry.executeTool({
      type: 'toolCall',
      id: 'proposal-1',
      name: 'propose_resource_mutation',
      arguments: {
        resourceId: 'chapter_01',
        operation: 'replace',
        content: '第一章 天元大陆\n少年萧晨紧握一卷古朴竹简。'
      }
    });

    expect(proposalRes.isError).toBe(false);
    expect(proposals).toHaveLength(1);
    expect(authoritativeContent).toContain('立于山巅');
    expect(authoritativeContent).not.toContain('古朴竹简');

    // The outer adapter decides when a reviewed proposal becomes authoritative.
    authoritativeContent = proposals[0]!.content;
    const updatedRead = await registry.executeTool({
      type: 'toolCall',
      id: 'read-2',
      name: 'read_resource',
      arguments: { resourceId: 'chapter_01' }
    });
    expect((updatedRead.content[0] as any).text).toContain('古朴竹简');
  });
});
