import type { AgentMessage, ModelToolDefinition, SystemMessage } from '@inkpi/protocol';
import type { StreamOptions } from './types.js';

/** Resolve typed history changes before an adapter creates its provider payload. */
export function resolveModelTranscript(
  messages: AgentMessage[],
  options?: StreamOptions,
  inPlace = false
): { messages: AgentMessage[]; options?: StreamOptions } {
  if (
    !messages.some(
      (message) => message.role === 'system' && (message.sections || message.toolsAdded || message.toolsRemoved)
    )
  )
    return { messages, options };
  const content: string[] = options?.systemPrompt ? [options.systemPrompt] : [];
  const sections = new Map<string, string>();
  const tools = new Map<string, ModelToolDefinition>();
  let leading = true;
  const positioned = messages.map((message) => {
    if (message.role !== 'system') return message;
    if (message.content) content.push(message.content);
    for (const [name, text] of Object.entries(message.sections ?? {})) {
      if (text === null) sections.delete(name);
      else sections.set(name, text);
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    const rendered = leading ? renderLeading(message) : renderUpdate(message);
    leading = false;
    return { ...message, content: rendered, sections: undefined, toolsAdded: undefined, toolsRemoved: undefined };
  });
  return {
    messages: inPlace ? positioned : messages.filter((message) => message.role !== 'system'),
    options: {
      ...options,
      systemPrompt: inPlace
        ? (options?.systemPrompt ?? '')
        : [...content, ...sections.values()].filter(Boolean).join('\n\n'),
      tools: options?.tools ?? [...tools.values()]
    }
  };
}

function renderLeading(message: SystemMessage): string {
  return [
    message.content,
    ...Object.values(message.sections ?? {}).filter((value) => value !== null),
    ...(message.toolsAdded?.length ? [`Initial tool definitions:\n${JSON.stringify(message.toolsAdded)}`] : [])
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderUpdate(message: SystemMessage): string {
  const updates: string[] = message.content ? [message.content] : [];
  for (const [name, value] of Object.entries(message.sections ?? {}))
    updates.push(
      value === null ? `Removed instruction section "${name}".` : `Replaced instruction section "${name}":\n${value}`
    );
  if (message.toolsRemoved?.length)
    updates.push(`Removed tools: ${message.toolsRemoved.map((tool) => tool.name).join(', ')}.`);
  if (message.toolsAdded?.length)
    updates.push(`Added or replaced tool definitions:\n${JSON.stringify(message.toolsAdded)}`);
  return updates.join('\n\n');
}
