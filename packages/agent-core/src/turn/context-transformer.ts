import type { AgentMessage } from '@inkpi/protocol';
import { ContextBudgetPlanner } from '../compaction/context-budget.js';
import type { ConversationContext } from '../conversation-context.js';
import { adoptMessage, commitMessage } from '../journal-commit.js';
import type { AgentOptions, AgentState, IncrementalContextUpdate } from '../types.js';
import type { TurnContext } from './turn-context.js';

interface MessageHistoryTracker {
  appendRevision: number;
  resetRevision: number;
  revision: number;
}

interface IncrementalContextCache {
  state: AgentState;
  source: AgentMessage[];
  appendRevision: number;
  resetRevision: number;
  processedLength: number;
  transformer: NonNullable<AgentOptions['incrementalTransformContext']>;
  view: readonly AgentMessage[];
}

const messageHistoryTrackers = new WeakMap<AgentState, MessageHistoryTracker>();

function arrayIndex(property: PropertyKey): number | undefined {
  if (typeof property !== 'string' || !/^(0|[1-9]\d*)$/.test(property)) return undefined;
  const index = Number(property);
  return Number.isSafeInteger(index) && index < 0xffff_ffff ? index : undefined;
}

/** Track array-level history edits so the incremental path can distinguish appends from rewrites. */
function trackMessageHistory(state: AgentState): MessageHistoryTracker | undefined {
  const existing = messageHistoryTrackers.get(state);
  if (existing) return existing;

  const descriptor = Object.getOwnPropertyDescriptor(state, 'messages');
  if ((descriptor && !descriptor.configurable) || !Array.isArray(state.messages)) return undefined;

  const tracker: MessageHistoryTracker = {
    appendRevision: 0,
    resetRevision: 0,
    revision: 0
  };

  const wrap = (target: AgentMessage[]): AgentMessage[] =>
    new Proxy(target, {
      set(array, property, value) {
        const previous = Reflect.get(array, property, array);
        const index = arrayIndex(property);
        const append = index !== undefined && index === array.length;
        const changed = previous !== value;
        const succeeded = Reflect.set(array, property, value, array);
        if (succeeded && changed && (index !== undefined || property === 'length')) {
          tracker.revision += 1;
          if (append) tracker.appendRevision += 1;
          else tracker.resetRevision += 1;
        }
        return succeeded;
      },
      deleteProperty(array, property) {
        const existed = Reflect.has(array, property);
        const succeeded = Reflect.deleteProperty(array, property);
        if (succeeded && existed && arrayIndex(property) !== undefined) {
          tracker.resetRevision += 1;
          tracker.revision += 1;
        }
        return succeeded;
      },
      defineProperty(array, property, propertyDescriptor) {
        const previous = Reflect.get(array, property, array);
        const index = arrayIndex(property);
        const append = index !== undefined && index === array.length;
        const succeeded = Reflect.defineProperty(array, property, propertyDescriptor);
        const current = Reflect.get(array, property, array);
        if (succeeded && previous !== current && (index !== undefined || property === 'length')) {
          tracker.revision += 1;
          if (append) tracker.appendRevision += 1;
          else tracker.resetRevision += 1;
        }
        return succeeded;
      }
    });

  let current = wrap(state.messages);
  try {
    Object.defineProperty(state, 'messages', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => current,
      set: (messages: AgentMessage[]) => {
        if (messages === current) return;
        if (!Array.isArray(messages)) throw new TypeError('AgentState.messages must be an array.');
        current = wrap(messages);
        tracker.resetRevision += 1;
        tracker.revision += 1;
      }
    });
  } catch {
    return undefined;
  }

  messageHistoryTrackers.set(state, tracker);
  return tracker;
}

function messageHeadId(messages: readonly AgentMessage[], revision: number): string | null {
  if (messages.length === 0) return null;
  const head = messages[messages.length - 1] as AgentMessage & { id?: unknown };
  return typeof head.id === 'string' && head.id.length > 0 ? head.id : `history:${revision}:${messages.length}`;
}

/**
 * 管线第一段：准备本轮投喂给模型的消息。
 *
 * 依次完成三件事：
 * 1. 排空 steering 队列，把消息并入会话历史并派发生命周期事件；
 * 2. 应用 `transformContext`（可选）做上下文裁剪/压缩；
 * 3. 应用 `convertToLlm`（可选）转换为模型可接受的格式。
 */
export class ContextTransformer {
  private incrementalCache?: IncrementalContextCache;
  private canonicalIncrementalCache?: {
    conversation: ConversationContext;
    headId: string | null;
    processedLength: number;
    transformer: NonNullable<AgentOptions['incrementalTransformContext']>;
    view: readonly AgentMessage[];
  };

  /** 返回应当发送给模型的消息列表。 */
  public async prepare(ctx: TurnContext): Promise<AgentMessage[]> {
    await this.drainSteering(ctx);

    await this.compact(ctx);

    let workingMessages = ctx.options.incrementalTransformContext
      ? await this.transformIncrementally(ctx, ctx.options.incrementalTransformContext)
      : ctx.options.conversation
        ? ctx.options.conversation.getModelMessages()
        : [...ctx.state.messages];
    if (ctx.options.transformContext) {
      workingMessages = await ctx.options.transformContext(workingMessages, ctx.signal);
    }

    return ctx.options.convertToLlm ? await ctx.options.convertToLlm(workingMessages) : workingMessages;
  }

  public async compact(ctx: TurnContext, force = false): Promise<boolean> {
    const compactor = ctx.options.sessionCompactor;
    if (!compactor || ctx.signal?.aborted) return false;
    const conversation = ctx.options.conversation;
    const headId = conversation?.getHeadId() ?? null;
    const input = conversation ? conversation.getModelMessages() : [...ctx.state.messages];
    const configuration = () =>
      JSON.stringify({
        model: {
          id: ctx.state.model?.id,
          provider: ctx.state.model?.provider,
          baseUrl: ctx.state.model?.baseUrl,
          contextWindow: ctx.state.model?.contextWindow,
          maxTokens: ctx.state.model?.maxTokens
        },
        instructions: ctx.state.systemPrompt,
        tools: ctx.toolRegistry.getAll().map(({ name, description, parameters }) => ({ name, description, parameters }))
      });
    const originalConfiguration = configuration();
    const planner = ctx.options.contextBudgetPlanner ?? new ContextBudgetPlanner();
    if (
      !force &&
      !planner.shouldCompact(
        {
          messages: input,
          contextWindowTokens: ctx.state.model?.contextWindow,
          outputReserveTokens: ctx.state.model?.maxTokens
        },
        compactor
      )
    )
      return false;
    // Instructions and tool definitions remain in the canonical transcript.
    const history = input.filter((message) => message.role !== 'system');
    if (!compactor.canCompact(history)) return false;
    const compacted = await compactor.compact(history, ctx.signal);
    if (ctx.signal?.aborted || configuration() !== originalConfiguration) return false;
    if (conversation) {
      if (!(await conversation.commitCompaction(compacted, headId, ctx.signal))) return false;
    } else {
      if (
        ctx.state.messages.length !== input.length ||
        ctx.state.messages.some((message, index) => message !== input[index])
      )
        return false;
      ctx.state.messages = [...input.filter((message) => message.role === 'system'), ...compacted.compactedMessages];
    }
    this.clearIncrementalCache();
    return true;
  }

  /** Release the cached view after an idle retention period or an explicit reset. */
  public clearIncrementalCache(): void {
    this.incrementalCache = undefined;
    this.canonicalIncrementalCache = undefined;
  }

  private async transformIncrementally(
    ctx: TurnContext,
    transformer: NonNullable<AgentOptions['incrementalTransformContext']>
  ): Promise<AgentMessage[]> {
    const conversation = ctx.options.conversation;
    if (conversation) {
      const prior = this.canonicalIncrementalCache;
      const cache = prior?.conversation === conversation && prior.transformer === transformer ? prior : undefined;
      const update = conversation.getModelUpdate(cache?.headId, cache?.processedLength);
      if (cache && update.headId === cache.headId && !update.reset) return [...cache.view];
      const view = await transformer({ ...update, previousView: update.reset ? [] : (cache?.view ?? []) }, ctx.signal);
      const ownedView = Object.freeze(structuredClone(view));
      this.canonicalIncrementalCache = {
        conversation,
        headId: update.headId,
        processedLength: update.totalMessageCount,
        transformer,
        view: ownedView
      };
      return [...ownedView];
    }
    const tracker = trackMessageHistory(ctx.state);
    const history = ctx.state.messages;
    const cache = this.incrementalCache;
    const canAppend =
      tracker !== undefined &&
      cache?.state === ctx.state &&
      cache.source === history &&
      cache.resetRevision === tracker.resetRevision &&
      cache.transformer === transformer &&
      cache.processedLength <= history.length;

    if (canAppend && cache.appendRevision === tracker.appendRevision && cache.processedLength === history.length) {
      return [...cache.view];
    }

    const reset = !canAppend;
    const messages = reset ? [...history] : history.slice(cache.processedLength);
    const revision = tracker?.revision ?? 0;
    const update: IncrementalContextUpdate = {
      headId: messageHeadId(history, revision),
      messages,
      previousView: reset ? [] : cache.view,
      reset,
      revision,
      totalMessageCount: history.length
    };
    const view = await transformer(update, ctx.signal);
    const cachedView = Object.freeze([...view]);

    if (tracker) {
      this.incrementalCache = {
        state: ctx.state,
        source: history,
        appendRevision: tracker.appendRevision,
        resetRevision: tracker.resetRevision,
        processedLength: history.length,
        transformer,
        view: cachedView
      };
    } else {
      this.incrementalCache = undefined;
    }

    return [...cachedView];
  }

  /**
   * 排空 steering 队列并入历史。
   *
   * 每条消息都完整派发 `message_start` / `message_end`，
   * 使其与模型产出的消息在事件流中不可区分。
   */
  private async drainSteering(ctx: TurnContext): Promise<void> {
    const steeringMsgs = ctx.steeringQueue.drain(ctx.options.steeringMode || 'all');
    for (const sMsg of steeringMsgs) {
      const message = await commitMessage(ctx.options.journal, sMsg);
      adoptMessage(ctx.state, ctx.options.journal, message);
      await ctx.emitEvent({ type: 'message_start', message });
      await ctx.emitEvent({ type: 'message_end', message });
    }
  }
}
