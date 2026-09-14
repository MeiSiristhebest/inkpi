import type { AgentTool } from '@inkpi/protocol';
import { enforceOutputGuard } from './output-guard.js';

/** A generic resource summary returned by an injected adapter. */
export interface ResourceDescriptor {
  resourceId: string;
  title?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

/** A generic search hit returned by an injected adapter. */
export interface ResourceSearchHit {
  resourceId: string;
  title?: string;
  snippet: string;
  metadata?: Record<string, unknown>;
}

/** A proposed resource mutation; it is never applied by the Runtime. */
export interface ResourceMutationProposal {
  resourceId: string;
  operation: 'create' | 'replace' | 'append';
  content: string;
  baseRevision?: number;
  metadata?: Record<string, unknown>;
}

/** Receipt returned after an outer adapter records a proposal. */
export interface ResourceMutationReceipt {
  proposalId: string;
  status: 'proposed';
  resourceId: string;
  operation: ResourceMutationProposal['operation'];
}

/**
 * Composition-root port for resources.
 *
 * There is deliberately no `write` method.  Desktop or an extension owns the
 * authoritative store and decides how a proposal becomes a reviewed commit.
 */
export interface DocumentResourceAdapter {
  read(resourceId: string): Promise<string | null>;
  list(): Promise<ResourceDescriptor[]>;
  search?(query: string, limit?: number): Promise<ResourceSearchHit[]>;
  proposeMutation(proposal: ResourceMutationProposal): Promise<ResourceMutationReceipt>;
}

/**
 * Build generic resource tools for an injected adapter.
 *
 * The returned tools can read resources and submit mutation proposals.  They
 * cannot mutate an authoritative document directly.
 */
export function createDocumentResourceTools(adapter: DocumentResourceAdapter): AgentTool[] {
  assertAdapter(adapter);

  const readResourceTool: AgentTool = {
    name: 'read_resource',
    description: 'Read a bounded slice of a resource through the injected resource adapter.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', description: 'Stable resource identifier' },
        startLine: { type: 'number', description: '1-based starting line' },
        maxLines: { type: 'number', description: 'Maximum number of lines' }
      },
      required: ['resourceId']
    },
    execute: async (_toolCallId, args) => {
      const resourceId = String(args.resourceId);
      const content = await adapter.read(resourceId);
      if (content === null) {
        return {
          content: [{ type: 'text', text: `Resource '${resourceId}' not found.` }],
          isError: true
        };
      }

      let result = content;
      if (typeof args.startLine === 'number' || typeof args.maxLines === 'number') {
        const lines = content.split('\n');
        const start = Math.max(0, (Number(args.startLine) || 1) - 1);
        const count = Number(args.maxLines) || lines.length;
        result = lines.slice(start, start + count).join('\n');
      }

      return { content: [{ type: 'text', text: enforceOutputGuard(result).content }] };
    }
  };

  const listResourcesTool: AgentTool = {
    name: 'list_resources',
    description: 'List resources through the injected resource adapter.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const resources = await adapter.list();
      if (resources.length === 0) {
        return { content: [{ type: 'text', text: 'Resource workspace is empty.' }] };
      }

      const lines = resources.map((resource) => {
        const size = typeof resource.size === 'number' ? ` (${resource.size} units)` : '';
        return `- [${resource.resourceId}] ${resource.title || resource.resourceId}${size}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  };

  const searchResourcesTool: AgentTool = {
    name: 'search_resources',
    description: 'Search resources through the injected resource adapter.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum number of hits' }
      },
      required: ['query']
    },
    execute: async (_toolCallId, args) => {
      if (!adapter.search) {
        return {
          content: [{ type: 'text', text: 'Resource search capability is not enabled by this adapter.' }],
          isError: true
        };
      }

      const hits = await adapter.search(String(args.query), Number(args.limit) || 5);
      if (hits.length === 0) return { content: [{ type: 'text', text: 'No matching resources found.' }] };

      const text = hits
        .map(
          (hit, index) => `[${index + 1}] ${hit.title || hit.resourceId}\n${enforceOutputGuard(hit.snippet).content}`
        )
        .join('\n\n');
      return { content: [{ type: 'text', text }] };
    }
  };

  const proposeMutationTool: AgentTool = {
    name: 'propose_resource_mutation',
    description: 'Submit a resource mutation proposal for outer-layer review and commit.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', description: 'Stable resource identifier' },
        operation: { type: 'string', enum: ['create', 'replace', 'append'] },
        content: { type: 'string', description: 'Proposed resource content' },
        baseRevision: { type: 'number', description: 'Optional optimistic-concurrency revision' }
      },
      required: ['resourceId', 'operation', 'content']
    },
    execute: async (_toolCallId, args) => {
      const operation = String(args.operation);
      if (!isMutationOperation(operation)) {
        return {
          content: [{ type: 'text', text: `Unsupported mutation operation '${operation}'.` }],
          isError: true
        };
      }

      const receipt = await adapter.proposeMutation({
        resourceId: String(args.resourceId),
        operation,
        content: String(args.content),
        ...(typeof args.baseRevision === 'number' ? { baseRevision: args.baseRevision } : {})
      });
      return {
        content: [
          {
            type: 'text',
            text: `Mutation proposal '${receipt.proposalId}' recorded for '${receipt.resourceId}' (${receipt.operation}).`
          }
        ],
        details: receipt
      };
    }
  };

  return [readResourceTool, listResourcesTool, searchResourcesTool, proposeMutationTool];
}

function assertAdapter(adapter: DocumentResourceAdapter): void {
  if (!adapter || typeof adapter.read !== 'function' || typeof adapter.list !== 'function') {
    throw new Error('DocumentResourceAdapter requires read() and list() capabilities.');
  }
  if (typeof adapter.proposeMutation !== 'function') {
    throw new Error('DocumentResourceAdapter requires proposeMutation(); direct writes are not supported.');
  }
}

function isMutationOperation(value: string): value is ResourceMutationProposal['operation'] {
  return value === 'create' || value === 'replace' || value === 'append';
}
