import { createHash } from 'node:crypto';
import type { AgentTool, ModelToolDefinition, ToolRegistrationDescriptor, ToolResult } from '@inkpi/protocol';

export const TOOL_SEARCH_NAME = 'tool_search';
export const TOOL_SEARCH_MAX_RESULTS = 8;
export const TOOL_SEARCH_MAX_DESCRIPTION_LENGTH = 240;
export const TOOL_SEARCH_MAX_SCHEMA_BYTES = 4096;
export const TOOL_SEARCH_MAX_RESULT_BYTES = 16 * 1024;
const TOOL_SEARCH_MAX_QUERY_LENGTH = 256;
const TOOL_SEARCH_DETAILS_KEY = '__inkpi_tool_search_v1';

export interface ToolSearchCandidate {
  tool: AgentTool;
  registration: ToolRegistrationDescriptor;
}

export interface ToolSearchExecutionContext {
  toolSearch: {
    candidates: ToolSearchCandidate[];
  };
}

export interface ToolSearchActivation {
  name: string;
  fingerprint: string;
}

interface RenderedToolSearchResult {
  name: string;
  description: string;
  parameters?: unknown;
  parametersOmitted?: true;
}

const toolSearchInstances = new WeakSet<AgentTool>();

export function createToolSearchTool(): AgentTool {
  const tool: AgentTool = {
    name: TOOL_SEARCH_NAME,
    description: 'Search locally registered deferred tools. Matching tools are declared on the next provider request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: TOOL_SEARCH_MAX_QUERY_LENGTH }
      }
    },
    replay: 'never',
    implementationVersion: '1',
    async execute(_toolCallId, params, signal, _onUpdate, context): Promise<ToolResult> {
      if (signal?.aborted) return toolSearchError('Tool search was cancelled.');
      const query = (params as { query?: unknown } | null)?.query;
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > TOOL_SEARCH_MAX_QUERY_LENGTH) {
        return toolSearchError('Tool search requires a non-empty query within the length limit.');
      }

      const executionContext = context as Partial<ToolSearchExecutionContext> | undefined;
      const candidates = Array.isArray(executionContext?.toolSearch?.candidates)
        ? executionContext.toolSearch.candidates
        : [];
      const matches = findDeferredToolMatches(query, candidates, TOOL_SEARCH_MAX_RESULTS);
      const rendered = renderMatches(matches);
      if (signal?.aborted) return toolSearchError('Tool search was cancelled.');

      return {
        content: [{ type: 'text', text: rendered.text }],
        details: {
          [TOOL_SEARCH_DETAILS_KEY]: {
            version: 1,
            activations: rendered.matches.map(({ tool, registration }) => ({
              name: tool.name,
              fingerprint: toolDiscoveryFingerprint(tool, registration)
            }))
          }
        }
      };
    }
  };
  toolSearchInstances.add(tool);
  return tool;
}

export function isToolSearchTool(tool: AgentTool | undefined): boolean {
  return tool !== undefined && toolSearchInstances.has(tool);
}

export function modelToolDefinition(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>): ModelToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object' } };
}

export function modelToolDefinitionKey(definition: ModelToolDefinition): string {
  return JSON.stringify(definition);
}

export function toolDiscoveryFingerprint(tool: AgentTool, registration: ToolRegistrationDescriptor): string {
  const contract = {
    definition: modelToolDefinition(tool),
    registration,
    implementationVersion: tool.implementationVersion ?? null
  };
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function readToolSearchActivations(details: unknown): ToolSearchActivation[] {
  if (!isRecord(details)) return [];
  const payload = details[TOOL_SEARCH_DETAILS_KEY];
  if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.activations)) return [];
  return payload.activations.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !/^[a-f0-9]{64}$/.test(String(entry.fingerprint ?? '')))
      return [];
    return [{ name: entry.name, fingerprint: entry.fingerprint as string }];
  });
}

function findDeferredToolMatches(
  query: string,
  candidates: readonly ToolSearchCandidate[],
  maxResults: number
): ToolSearchCandidate[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const phrase = terms.join(' ');
  const ranked = candidates.flatMap((candidate) => {
    if (candidate.registration.exposure !== 'deferred' || candidate.tool.name === TOOL_SEARCH_NAME) return [];
    const name = normalizeSearchText(candidate.tool.name).replace(/[_-]+/gu, ' ');
    const description = normalizeSearchText(candidate.tool.description);
    if (!terms.every((term) => name.includes(term) || description.includes(term))) return [];

    let score = 0;
    if (name === phrase) score += 1000;
    else if (name.startsWith(phrase)) score += 700;
    else if (name.includes(phrase)) score += 450;
    for (const term of terms) {
      if (name.includes(term)) score += 80;
      else if (description.includes(term)) score += 20;
    }
    return [{ candidate, score }];
  });

  ranked.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.candidate.tool.name < right.candidate.tool.name) return -1;
    if (left.candidate.tool.name > right.candidate.tool.name) return 1;
    return 0;
  });
  return ranked.slice(0, Math.min(TOOL_SEARCH_MAX_RESULTS, Math.max(0, maxResults))).map(({ candidate }) => candidate);
}

function renderMatches(matches: ToolSearchCandidate[]): { text: string; matches: ToolSearchCandidate[] } {
  let selected = matches.map((candidate) => ({ candidate, ...renderCandidate(candidate) }));
  let serialized = JSON.stringify(selected.map(({ result }) => result));
  while (selected.length > 0 && Buffer.byteLength(serialized, 'utf8') > TOOL_SEARCH_MAX_RESULT_BYTES) {
    selected = selected.slice(0, -1);
    serialized = JSON.stringify(selected.map(({ result }) => result));
  }
  if (selected.length === 0) {
    return {
      text: matches.length === 0 ? 'No deferred tools matched.' : 'Matching tool results exceeded the response limit.',
      matches: []
    };
  }
  return {
    text: serialized,
    matches: selected.flatMap(({ candidate, activatable }) => (activatable ? [candidate] : []))
  };
}

function renderCandidate(candidate: ToolSearchCandidate): { result: RenderedToolSearchResult; activatable: boolean } {
  const definition = modelToolDefinition(candidate.tool);
  const parametersText = JSON.stringify(definition.parameters);
  const parametersFit = Buffer.byteLength(parametersText, 'utf8') <= TOOL_SEARCH_MAX_SCHEMA_BYTES;
  return {
    result: {
      name: candidate.tool.name,
      description: truncateCodePoints(candidate.tool.description, TOOL_SEARCH_MAX_DESCRIPTION_LENGTH),
      ...(parametersFit ? { parameters: definition.parameters } : { parametersOmitted: true })
    },
    activatable: parametersFit
  };
}

function tokenize(value: string): string[] {
  return [...new Set(normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function truncateCodePoints(value: string, maxLength: number): string {
  const points = Array.from(value);
  return points.length <= maxLength ? value : `${points.slice(0, maxLength).join('')}…`;
}

function toolSearchError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
