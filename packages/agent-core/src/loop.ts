import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCallContent,
  AgentEventListener
} from '@inkpi/protocol';
import { streamAi } from '@inkpi/ai';
import type { AgentOptions, AgentState } from './types.js';
import type { ToolRegistry } from './tools.js';
import type { SteeringQueue, FollowUpQueue } from './queues.js';

export interface RunLoopParams {
  state: AgentState;
  options: AgentOptions;
  toolRegistry: ToolRegistry;
  steeringQueue: SteeringQueue;
  followUpQueue: FollowUpQueue;
  emitEvent: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
}

export async function runAgentLoop(params: RunLoopParams): Promise<AgentMessage[]> {
  const { state, options, toolRegistry, steeringQueue, followUpQueue, emitEvent, signal } = params;

  state.errorMessage = undefined;
  await emitEvent({ type: 'agent_start' });

  try {
    let continueLoop = true;

    while (continueLoop) {
      if (signal?.aborted) break;

      await emitEvent({ type: 'turn_start' });

      // 1. Drain steering messages if available before LLM invocation
      const steeringMsgs = steeringQueue.drain(options.steeringMode || 'all');
      if (steeringMsgs.length > 0) {
        for (const sMsg of steeringMsgs) {
          state.messages.push(sMsg);
          await emitEvent({ type: 'message_start', message: sMsg });
          await emitEvent({ type: 'message_end', message: sMsg });
        }
      }

      // 2. Transform context pipeline
      let workingMessages = [...state.messages];
      if (options.transformContext) {
        workingMessages = await options.transformContext(workingMessages, signal);
      }

      let llmMessages = workingMessages;
      if (options.convertToLlm) {
        llmMessages = await options.convertToLlm(workingMessages);
      }

      // 3. Invoke LLM Stream
      const streamFn = options.streamFn || streamAi;
      const toolsMetadata = toolRegistry.getAll().map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }));

      const stream = streamFn(state.model, llmMessages, {
        signal,
        systemPrompt: state.systemPrompt,
        thinkingBudget: state.thinkingLevel === 'off' ? 0 : 2000,
        tools: toolsMetadata
      });
      const abortStream = (): void => stream.abort();
      if (signal?.aborted) {
        stream.abort();
      } else {
        signal?.addEventListener('abort', abortStream, { once: true });
      }

      state.isStreaming = true;

      const initialAssistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        timestamp: Date.now()
      };
      state.streamingMessage = initialAssistantMsg;

      // Providers may start producing as soon as streamFn returns. Attach the
      // listener before awaiting any lifecycle listener, then gate updates so
      // message_start still settles before the first message_update.
      let releaseMessageStart!: () => void;
      const messageStartSettled = new Promise<void>((resolve) => {
        releaseMessageStart = resolve;
      });
      stream.on(async (msgEvent) => {
        await messageStartSettled;
        if (state.streamingMessage) {
          if (msgEvent.type === 'text_delta') {
            let textBlock = state.streamingMessage.content.find((b: any) => b.type === 'text') as any;
            if (!textBlock) {
              textBlock = { type: 'text', text: '' };
              state.streamingMessage.content.push(textBlock);
            }
            textBlock.text += msgEvent.textDelta;
          } else if (msgEvent.type === 'thinking_delta') {
            let thinkBlock = state.streamingMessage.content.find((b: any) => b.type === 'thinking') as any;
            if (!thinkBlock) {
              thinkBlock = { type: 'thinking', thinking: '' };
              state.streamingMessage.content.push(thinkBlock);
            }
            thinkBlock.thinking += msgEvent.thinkingDelta;
          }

          await emitEvent({
            type: 'message_update',
            message: state.streamingMessage,
            assistantMessageEvent: msgEvent
          });
        }
      });

      await emitEvent({ type: 'message_start', message: initialAssistantMsg });
      releaseMessageStart();

      let assistantMessage: AssistantMessage;
      try {
        assistantMessage = await stream.collect();
        await stream.waitForListeners?.();
      } finally {
        signal?.removeEventListener('abort', abortStream);
      }
      state.isStreaming = false;
      state.streamingMessage = undefined;
      state.messages.push(assistantMessage);
      if (assistantMessage.stopReason === 'error') {
        state.errorMessage = assistantMessage.errorMessage || 'Model stream ended with an error.';
      }
      await emitEvent({ type: 'message_end', message: assistantMessage });

      // 4. Extract tool calls
      const toolCalls: ToolCallContent[] = [];
      for (const item of assistantMessage.content) {
        if (item.type === 'toolCall') {
          toolCalls.push(item);
        }
      }

      const toolResults: ToolResultMessage[] = [];
      let shouldTerminateFromTools = false;

      if (toolCalls.length > 0) {
        const executeOne = async (call: ToolCallContent): Promise<ToolResultMessage & { terminate?: boolean }> => {
          if (signal?.aborted) {
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
              content: [{ type: 'text', text: 'Tool execution aborted by signal' }],
              timestamp: Date.now()
            };
          }

          state.pendingToolCalls.add(call.id);
          await emitEvent({
            type: 'tool_execution_start',
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments
          });

          let toolRes: ToolResultMessage & { terminate?: boolean };
          try {
            let blocked = false;
            let blockReason = 'Tool execution blocked by gate';
            if (options.beforeToolCall) {
              const beforeRes = await options.beforeToolCall({
                assistantMessage,
                toolCall: call,
                args: call.arguments,
                context: { messages: state.messages }
              });
              if (beforeRes?.block) {
                blocked = true;
                blockReason = beforeRes.reason || blockReason;
                if (beforeRes.terminate) shouldTerminateFromTools = true;
              }
            }

            if (blocked) {
              toolRes = {
                role: 'toolResult',
                toolCallId: call.id,
                toolName: call.name,
                isError: true,
                content: [{ type: 'text', text: blockReason }],
                timestamp: Date.now()
              };
            } else {
              toolRes = await toolRegistry.executeTool(
                call,
                signal,
                async (update) => {
                  await emitEvent({
                    type: 'tool_execution_update',
                    toolCallId: call.id,
                    partialResult: update
                  });
                },
                { messages: state.messages }
              );
            }

            if (options.afterToolCall) {
              const afterRes = await options.afterToolCall({
                assistantMessage,
                toolCall: call,
                args: call.arguments,
                result: { content: toolRes.content, details: toolRes.details },
                isError: toolRes.isError ?? false
              });
              if (afterRes) {
                if (afterRes.content) toolRes.content = afterRes.content;
                if (afterRes.details !== undefined) toolRes.details = afterRes.details;
                if (afterRes.isError !== undefined) toolRes.isError = afterRes.isError;
                if (afterRes.terminate) shouldTerminateFromTools = true;
              }
            }
          } catch (error) {
            shouldTerminateFromTools = true;
            const message = error instanceof Error ? error.message : String(error);
            toolRes = {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
              terminate: true,
              content: [{ type: 'text', text: `Tool lifecycle error: ${message}` }],
              timestamp: Date.now()
            };
          } finally {
            state.pendingToolCalls.delete(call.id);
          }

          if (toolRes.terminate) shouldTerminateFromTools = true;
          await emitEvent({
            type: 'tool_execution_end',
            toolCallId: call.id,
            result: toolRes.content
          });
          return toolRes;
        };

        const results = options.toolExecution === 'sequential'
          ? await executeSequential(toolCalls, executeOne)
          : await Promise.all(toolCalls.map((call) => executeOne(call)));

        for (const toolRes of results) {
          toolResults.push(toolRes);
          state.messages.push(toolRes);
          await emitEvent({ type: 'message_start', message: toolRes });
          await emitEvent({ type: 'message_end', message: toolRes });
        }
      }

      await emitEvent({
        type: 'turn_end',
        message: assistantMessage,
        toolResults
      });

      // Check termination conditions
      if (shouldTerminateFromTools) {
        continueLoop = false;
        break;
      }

      if (options.shouldStopAfterTurn) {
        const stop = await options.shouldStopAfterTurn(
          { assistantMessage, toolResults },
          signal
        );
        if (stop) {
          continueLoop = false;
          break;
        }
      }

      // If tool calls were made, loop automatically continues for LLM to process results
      if (toolCalls.length > 0) {
        continue;
      }

      // If steering queue has items, continue loop for steering
      if (steeringQueue.size() > 0) {
        continue;
      }

      // If follow-up queue has items, drain one and continue loop
      if (followUpQueue.size() > 0) {
        const followUps = followUpQueue.drain(options.followUpMode || 'one-at-a-time');
        for (const fMsg of followUps) {
          state.messages.push(fMsg);
          await emitEvent({ type: 'message_start', message: fMsg });
          await emitEvent({ type: 'message_end', message: fMsg });
        }
        continue;
      }

      // No more tools, steering, or follow-ups -> settle loop
      continueLoop = false;
    }
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.isStreaming = false;
    state.streamingMessage = undefined;
    state.pendingToolCalls.clear();
    await emitEvent({ type: 'agent_end', messages: state.messages });
  }

  return state.messages;
}

async function executeSequential<T>(
  items: T[],
  execute: (item: T) => Promise<ToolResultMessage & { terminate?: boolean }>
): Promise<Array<ToolResultMessage & { terminate?: boolean }>> {
  const results: Array<ToolResultMessage & { terminate?: boolean }> = [];
  for (const item of items) results.push(await execute(item));
  return results;
}
