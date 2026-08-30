import type { AgentMessage } from '@inkpi/protocol';

export const GENERIC_SUMMARIZATION_SYSTEM_PROMPT = `
You are an expert at compressing conversation history into high-fidelity summaries.
Your task is to take earlier conversation context and reasoning traces and compress them into a structured summary for the AI agent.

Please extract and retain:
1. Core intent and instructions from the user.
2. Major decisions, constraints, or conclusions reached.
3. Pending or unresolved items/tasks.
4. Essential context needed for the agent to continue seamlessly.

Output should be concise, well-structured, and provide seamless continuity for the agent.
`.trim();

/**
 * Serialize conversation history for the summarization model
 */
export function serializeConversationForSummary(messages: AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      parts.push(`[USER]: ${text}`);
    } else if (msg.role === 'assistant') {
      const texts: string[] = [];
      const thinkings: string[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') texts.push(b.text);
        if (b.type === 'thinking') thinkings.push(b.thinking);
      }
      if (thinkings.length > 0) {
        parts.push(`[AI REASONING]: ${thinkings.join('\n')}`);
      }
      if (texts.length > 0) {
        parts.push(`[AI RESPONSE]: ${texts.join('\n')}`);
      }
    } else if (msg.role === 'toolResult') {
      parts.push(`[TOOL (${msg.toolName})]: ${JSON.stringify(msg.content)}`);
    }
  }

  return parts.join('\n\n');
}
