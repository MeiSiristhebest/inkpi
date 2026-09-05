import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage, Usage } from './messages.js';

export type AssistantMessageEvent =
  | { type: 'text_delta'; textDelta: string }
  | { type: 'thinking_delta'; thinkingDelta: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string }
  | { type: 'tool_call_delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool_call_end'; toolCall: ToolCallContent }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: string };

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown }
  | { type: 'journal_entry_appended'; entry: unknown }
  | { type: 'projection_updated'; table: string; id: string }
  | { type: 'pipeline_stage_span'; stage: string; role: string; durationMs: number; usage?: Usage }
  | { type: 'ui_prompt_start'; promptId: string; title?: string }
  | { type: 'ui_prompt_end'; promptId: string; response?: unknown };

export type AgentEventListener = (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void;
