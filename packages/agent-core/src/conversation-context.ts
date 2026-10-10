import {
  AgentMessageSchema,
  SessionCommitError,
  assertJsonValue,
  assertToolParameterSchema,
  assertValid
} from '@inkpi/protocol';
import type {
  AgentMessage,
  ContextEdit,
  JournalAppend,
  JournalEntry,
  ModelLoadout,
  ModelToolDefinition,
  SystemMessage
} from '@inkpi/protocol';
import type { CompactionResult } from './compaction/compaction.js';
import { commitJournal } from './journal-commit.js';
import { messageFromSessionEntry } from './reducer/session-reducer.js';
import { type AssistantStreamFrame, reduceAssistantFrames } from './turn/assistant-frames.js';
import type { AgentOptions } from './types.js';

export interface ConversationModelContext {
  headId: string | null;
  rawMessages: AgentMessage[];
  messages: AgentMessage[];
  loadout?: ModelLoadout;
  usageTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
}

interface CompactionModelView {
  version: 1;
  baseHeadId: string | null;
  summaryMessage: AgentMessage;
  keptIds: string[];
}

interface ContextProjection {
  headId: string | null;
  entryCount: number;
  rawMessages: AgentMessage[];
  timeline: AgentMessage[];
  editableMessages: Map<string, AgentMessage>;
  edits: Map<string, AgentMessage | null>;
  tools: JournalEntry[];
  frames: AssistantStreamFrame[];
  loadout?: ModelLoadout;
  usageTotals: ConversationModelContext['usageTotals'];
}

/** Owns branch placement and model-view metadata; the supplied writer owns persistence. */
export class ConversationContext {
  readonly sessionId: string;
  readonly recordAssistantFrames: boolean;
  private readonly entries: JournalEntry[];
  private readonly index: Map<string, JournalEntry>;
  private headId: string | null;
  private cached?: ConversationModelContext;
  private projection?: ContextProjection;
  private scannedEntries = 0;
  private rebuilds = 0;

  constructor(
    private readonly writer: AgentOptions['journal'],
    private readonly clock: () => number
  ) {
    this.sessionId = writer.sessionId ?? '';
    this.recordAssistantFrames = writer.recordAssistantFrames !== false;
    this.entries = structuredClone(writer.getEntries());
    this.index = new Map(this.entries.map((entry) => [entry.id, entry]));
    this.headId = this.entries[this.entries.length - 1]?.id ?? null;
  }

  getEntries(): JournalEntry[] {
    return structuredClone(this.entries);
  }
  getHeadId(): string | null {
    return this.headId;
  }

  clearCache(): void {
    this.cached = undefined;
    this.projection = undefined;
  }

  getCacheStats(): { scannedEntries: number; rebuilds: number; cachedEntries: number } {
    return {
      scannedEntries: this.scannedEntries,
      rebuilds: this.rebuilds,
      cachedEntries: this.projection?.entryCount ?? 0
    };
  }

  getModelMessages(): AgentMessage[] {
    return structuredClone(this.materialize(this.headId).messages);
  }

  getLoadout(): ModelLoadout | undefined {
    return structuredClone(this.readProjection(this.headId).loadout);
  }

  getModelUpdate(
    previousHeadId?: string | null,
    previousLength = 0
  ): {
    headId: string | null;
    messages: AgentMessage[];
    reset: boolean;
    revision: number;
    totalMessageCount: number;
  } {
    const delta = previousHeadId === undefined ? undefined : this.pathAfter(previousHeadId, this.headId);
    const reset =
      !delta ||
      delta.some(
        (entry) =>
          entry.type === 'context_edit' ||
          entry.type === 'compaction' ||
          (entry.type === 'custom' && entry.payload?.kind === 'context_head') ||
          (entry.type === 'tool_execution' &&
            previousHeadId &&
            this.index.get(previousHeadId)?.type === 'tool_execution')
      );
    const context = this.materialize(this.headId);
    return {
      headId: this.headId,
      messages: structuredClone(reset ? context.messages : context.messages.slice(previousLength)),
      reset,
      revision: this.headId ? this.index.get(this.headId)!.seq : 0,
      totalMessageCount: context.messages.length
    };
  }

  async commitCompaction(result: CompactionResult, baseHeadId: string | null, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || baseHeadId !== this.headId) return false;
    const [summary, ...kept] = result.compactedMessages;
    if (!summary) throw new Error('Compaction did not produce a summary.');
    const modelView: CompactionModelView = {
      version: 1,
      baseHeadId,
      summaryMessage: { ...structuredClone(summary), id: crypto.randomUUID() },
      keptIds: kept.map((message) => {
        if (!message.id) throw new Error('Compaction retained a message without an identity.');
        return message.id;
      })
    };
    await commitJournal(this, [{ type: 'compaction', payload: { ...result.entry, modelView } }]);
    return true;
  }

  async recordLoadout(systemPrompt: string, tools: ModelToolDefinition[]): Promise<SystemMessage | undefined> {
    const previous = this.getLoadout();
    const next: ModelLoadout = { version: 1, systemPrompt, tools: structuredClone(tools) };
    if (JSON.stringify(previous) === JSON.stringify(next)) return undefined;
    const entries = await commitJournal(this, [{ type: 'model_loadout', payload: next }]);
    return loadoutMessage(entries[0], next, previous);
  }

  getPath(headId: string | null = this.headId): JournalEntry[] {
    return structuredClone(this.pathAfter(null, headId)!);
  }

  private pathAfter(ancestor: string | null, headId: string | null): JournalEntry[] | undefined {
    const path: JournalEntry[] = [];
    const seen = new Set<string>();
    let current = headId;
    while (current !== ancestor) {
      if (current === null) return undefined;
      if (seen.has(current)) throw new Error(`Conversation journal has a cycle at '${current}'.`);
      seen.add(current);
      const entry = this.index.get(current);
      if (!entry) throw new Error(`Conversation head '${current}' not found.`);
      path.push(entry);
      current = entry.parentId;
    }
    return path.reverse();
  }

  selectHead(headId: string | null): void {
    if (headId !== null && !this.index.has(headId)) throw new Error(`Conversation head '${headId}' not found.`);
    this.headId = headId;
    this.cached = undefined;
  }

  async appendBatch(appends: readonly JournalAppend[]): Promise<JournalEntry[]> {
    const staged: JournalEntry[] = [];
    let parentId = this.headId;
    try {
      for (const append of appends) {
        const id = append.id ?? crypto.randomUUID();
        if (this.index.has(id) || staged.some((entry) => entry.id === id))
          throw new SessionCommitError(`Conversation entry '${id}' already exists.`, 'rejected');
        const entry: JournalEntry = {
          id,
          sessionId: this.sessionId,
          seq: this.entries.length + staged.length + 1,
          parentId: append.parentId !== undefined ? append.parentId : parentId,
          type: append.type,
          timestamp: this.clock(),
          payload: structuredClone(append.payload)
        };
        if (entry.type === 'model_loadout') validateLoadout(entry.payload);
        if (entry.type === 'context_edit') {
          const projection = this.readProjection(this.headId);
          validateEdit(entry.payload, [
            ...projection.editableMessages.values(),
            ...orderedTools(projection.tools).map((tool) => messageFromSessionEntry(tool)!)
          ]);
        }
        if (entry.type === 'compaction' && entry.payload.modelView) {
          if (entry.payload.modelView.baseHeadId !== this.headId || entry.parentId !== this.headId)
            throw new Error('Compaction context has changed.');
          validateCompactionView(entry.payload.modelView, this.getContext().messages);
        }
        staged.push(entry);
        parentId = id;
      }
    } catch (error) {
      throw new SessionCommitError(error instanceof Error ? error.message : String(error), 'rejected', {
        cause: error
      });
    }
    const writes = staged.map((entry) => ({
      type: entry.type,
      payload: entry.payload,
      id: entry.id,
      parentId: entry.parentId
    }));
    let committed: JournalEntry[];
    if (this.writer.appendBatch) committed = await this.writer.appendBatch(writes);
    else {
      committed = [];
      try {
        for (const write of writes) {
          const result = await this.writer.append(write.type, write.payload, write.id, write.parentId);
          if (!result || typeof result.id !== 'string')
            throw new SessionCommitError('Conversation journal did not return a committed entry.', 'unknown');
          committed.push(result);
        }
      } catch (error) {
        if (committed.length > 0)
          throw new SessionCommitError('Conversation journal partially committed a batch.', 'unknown', {
            cause: error
          });
        throw error;
      }
    }
    try {
      if (committed.length !== staged.length) throw new Error('Conversation journal returned an incomplete commit.');
      for (const [position, entry] of committed.entries()) {
        if (
          entry.id !== staged[position].id ||
          entry.parentId !== staged[position].parentId ||
          entry.type !== staged[position].type ||
          JSON.stringify(entry.payload) !== JSON.stringify(staged[position].payload)
        )
          throw new Error('Conversation journal changed entry placement or payload.');
        const owned = structuredClone(entry);
        this.entries.push(owned);
        this.index.set(owned.id, owned);
      }
      this.headId = parentId;
      this.cached = undefined;
      return structuredClone(committed);
    } catch (error) {
      throw new SessionCommitError('Conversation journal committed but adoption failed.', 'unknown', { cause: error });
    }
  }

  async append(
    type: JournalAppend['type'],
    payload: unknown,
    id?: string,
    parentId?: string | null
  ): Promise<JournalEntry> {
    return (await this.appendBatch([{ type, payload, id, parentId }]))[0];
  }

  getContext(headId: string | null = this.headId): ConversationModelContext {
    return structuredClone(this.materialize(headId));
  }

  private materialize(headId: string | null): ConversationModelContext {
    if (headId === this.headId && this.cached) return this.cached;
    const projection = this.readProjection(headId);
    const pending = orderedTools(projection.tools).map((entry) => messageFromSessionEntry(entry)!);
    const partial = reduceAssistantFrames(projection.frames);
    const tail = partial ? [...pending, partial] : pending;
    const context = {
      headId,
      rawMessages: [...projection.rawMessages, ...tail],
      messages: projectEdits([...projection.timeline, ...tail], projection.edits),
      loadout: projection.loadout,
      usageTotals: { ...projection.usageTotals }
    };
    if (headId === this.headId) this.cached = context;
    return context;
  }

  private readProjection(headId: string | null): ContextProjection {
    let projection = headId === this.headId ? this.projection : undefined;
    let suffix = projection ? this.pathAfter(projection.headId, headId) : undefined;
    if (!projection || !suffix) {
      projection = {
        headId: null,
        entryCount: 0,
        rawMessages: [],
        timeline: [],
        editableMessages: new Map(),
        edits: new Map(),
        tools: [],
        frames: [],
        usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
      suffix = this.pathAfter(null, headId)!;
      this.rebuilds++;
    }
    try {
      for (const entry of suffix) {
        applyProjectionEntry(projection, entry);
        projection.headId = entry.id;
        projection.entryCount++;
        this.scannedEntries++;
      }
    } catch (error) {
      if (headId === this.headId) this.clearCache();
      throw error;
    }
    if (headId === this.headId) this.projection = projection;
    return projection;
  }
}

function orderedTools(tools: readonly JournalEntry[]): JournalEntry[] {
  return [...tools].sort(
    (left, right) =>
      (left.payload.sourceIndex ?? Number.MAX_SAFE_INTEGER) - (right.payload.sourceIndex ?? Number.MAX_SAFE_INTEGER)
  );
}

function flushProjectionTools(projection: ContextProjection): void {
  for (const entry of orderedTools(projection.tools)) {
    const message = messageFromSessionEntry(entry)!;
    projection.rawMessages.push(message);
    projection.timeline.push(message);
    projection.editableMessages.set(entry.id, message);
  }
  projection.tools = [];
}

function applyProjectionEntry(projection: ContextProjection, entry: JournalEntry): void {
  if (entry.type === 'tool_execution') {
    projection.tools.push(entry);
    return;
  }
  if (entry.type === 'assistant_frame') {
    if (entry.payload?.frame) projection.frames.push(entry.payload.frame);
    return;
  }
  if (entry.type === 'model_loadout') {
    flushProjectionTools(projection);
    validateLoadout(entry.payload);
    projection.timeline.push(loadoutMessage(entry, entry.payload, projection.loadout));
    projection.loadout = entry.payload;
  } else if (entry.type === 'context_edit') {
    flushProjectionTools(projection);
    validateEdit(entry.payload, [...projection.editableMessages.values()]);
    for (const edit of (entry.payload as ContextEdit).edits)
      projection.edits.set(edit.messageId, edit.action === 'exclude' ? null : { ...edit.message, id: edit.messageId });
  } else if (entry.type === 'compaction' && entry.payload?.modelView) {
    flushProjectionTools(projection);
    const view = entry.payload.modelView as CompactionModelView;
    const visible = projectEdits(projection.timeline, projection.edits);
    if (view.baseHeadId !== entry.parentId) throw new Error('Compaction does not match its journal cut point.');
    validateCompactionView(view, visible);
    const byId = new Map(visible.map((message) => [message.id, message]));
    projection.timeline = [
      ...visible.filter((message) => message.role === 'system'),
      view.summaryMessage,
      ...view.keptIds.map((id) => byId.get(id)!)
    ];
    projection.editableMessages.set(view.summaryMessage.id!, view.summaryMessage);
  } else {
    const message = messageFromSessionEntry(entry);
    if (!message) return;
    flushProjectionTools(projection);
    projection.rawMessages.push(message);
    projection.timeline.push(message);
    projection.editableMessages.set(entry.id, message);
    if (message.role === 'assistant') {
      projection.frames = [];
      projection.usageTotals.inputTokens += message.usage?.inputTokens || 0;
      projection.usageTotals.outputTokens += message.usage?.outputTokens || 0;
      projection.usageTotals.totalTokens += message.usage?.totalTokens || 0;
    }
  }
}

export function loadoutMessage(
  entry: Pick<JournalEntry, 'id' | 'timestamp'>,
  next: ModelLoadout,
  previous?: ModelLoadout
): SystemMessage {
  const prior = new Map((previous?.tools ?? []).map((tool) => [tool.name, tool]));
  const current = new Map(next.tools.map((tool) => [tool.name, tool]));
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    role: 'system',
    content: '',
    ...(next.systemPrompt !== previous?.systemPrompt ? { sections: { instructions: next.systemPrompt || null } } : {}),
    toolsAdded: next.tools.filter((tool) => JSON.stringify(tool) !== JSON.stringify(prior.get(tool.name))),
    toolsRemoved: [...prior.keys()].filter((name) => !current.has(name)).map((name) => ({ name }))
  };
}

export function validateLoadout(value: unknown): asserts value is ModelLoadout {
  const loadout = value as ModelLoadout;
  if (!loadout || loadout.version !== 1 || typeof loadout.systemPrompt !== 'string' || !Array.isArray(loadout.tools))
    throw new Error('Invalid model loadout.');
  assertJsonValue(value, 'Model loadout');
  const names = new Set<string>();
  for (const tool of loadout.tools) {
    if (
      !tool ||
      typeof tool.name !== 'string' ||
      !tool.name.trim() ||
      names.has(tool.name) ||
      typeof tool.description !== 'string'
    )
      throw new Error('Invalid or duplicate loadout tool.');
    names.add(tool.name);
    assertToolParameterSchema(tool.parameters, tool.name);
    assertJsonValue(tool.parameters, `Tool '${tool.name}' declaration`);
  }
}

export function validateEdit(value: unknown, messages: readonly AgentMessage[]): asserts value is ContextEdit {
  const edit = value as ContextEdit;
  if (!edit || edit.version !== 1 || !Array.isArray(edit.edits) || edit.edits.length === 0)
    throw new Error('Invalid context edit.');
  const ids = new Map(messages.map((message) => [message.id, message]));
  assertJsonValue(value, 'Context edit');
  for (const operation of edit.edits) {
    if (!operation || typeof operation.messageId !== 'string' || !operation.messageId.trim())
      throw new Error('Invalid context edit target.');
    const original = ids.get(operation.messageId);
    if (!original) throw new Error(`Context edit target '${operation.messageId}' is not on this conversation path.`);
    if (operation.action === 'replace') {
      assertValid(AgentMessageSchema, operation.message, 'Context replacement');
      assertJsonValue(operation.message, 'Context replacement');
      if (operation.message.role !== original.role)
        throw new Error('Context replacement must preserve the message role.');
    } else if (operation.action !== 'exclude') throw new Error('Unsupported context edit action.');
  }
}

function projectEdits(messages: readonly AgentMessage[], edits: Map<string, AgentMessage | null>): AgentMessage[] {
  return messages.flatMap((message) => {
    if (!message.id || !edits.has(message.id)) return [message];
    const replacement = edits.get(message.id);
    return replacement ? [replacement] : [];
  });
}

function validateCompactionView(
  value: unknown,
  messages: readonly AgentMessage[]
): asserts value is CompactionModelView {
  const view = value as CompactionModelView;
  if (!view || view.version !== 1 || !Array.isArray(view.keptIds) || view.keptIds.length === 0)
    throw new Error('Invalid compaction model view.');
  assertJsonValue(view, 'Compaction model view');
  assertValid(AgentMessageSchema, view.summaryMessage, 'Compaction summary');
  if (view.summaryMessage.role !== 'assistant' || !view.summaryMessage.id)
    throw new Error('Compaction requires an identified assistant summary.');
  const history = messages.filter((message) => message.role !== 'system');
  const suffix = history.slice(-view.keptIds.length);
  if (
    history.length <= view.keptIds.length ||
    new Set(view.keptIds).size !== view.keptIds.length ||
    suffix.some((message, index) => message.id !== view.keptIds[index]) ||
    suffix[0]?.role === 'toolResult' ||
    messages.some((message) => message.id === view.summaryMessage.id)
  )
    throw new Error('Compaction must retain the current conversation tail.');
}
