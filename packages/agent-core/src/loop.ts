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

      state.isStreaming = true;

      const initialAssistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        timestamp: Date.now()
      };
      state.streamingMessage = initialAssistantMsg;
      await emitEvent({ type: 'message_start', message: initialAssistantMsg });

      stream.on(async (msgEvent) => {
        if (state.streamingMessage) {
          await emitEvent({
            type: 'message_update',
            message: state.streamingMessage,
            assistantMessageEvent: msgEvent
          });
        }
      });

      const assistantMessage = await stream.collect();
      state.isStreaming = false;
      state.streamingMessage = undefined;
      state.messages.push(assistantMessage);
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
        // Execute tools
        for (const call of toolCalls) {
          if (signal?.aborted) break;

          state.pendingToolCalls.add(call.id);
          await emitEvent({
            type: 'tool_execution_start',
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments
          });

          // Check beforeToolCall gate
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

          let toolRes: ToolResultMessage & { terminate?: boolean };

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
              }
            );
          }

          // Check afterToolCall gate
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

          if (toolRes.terminate) {
            shouldTerminateFromTools = true;
          }

          state.pendingToolCalls.delete(call.id);
          await emitEvent({
            type: 'tool_execution_end',
            toolCallId: call.id,
            result: toolRes.content
          });

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
  } finally {
    state.isStreaming = false;
    state.streamingMessage = undefined;
    state.pendingToolCalls.clear();
    await emitEvent({ type: 'agent_end', messages: state.messages });
  }

  return state.messages;
}
