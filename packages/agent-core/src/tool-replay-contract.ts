import { assertJsonValue } from '@inkpi/protocol';
import type { AgentTool, ToolRegistrationDescriptor, ToolReplayContract } from '@inkpi/protocol';

export function captureToolReplayContract(
  tool: AgentTool,
  registration?: ToolRegistrationDescriptor
): ToolReplayContract | undefined {
  const implementationVersion = tool.implementationVersion ?? registration?.skillVersion;
  if (typeof implementationVersion !== 'string' || !implementationVersion.trim()) return undefined;
  const schema = tool.parameters ?? { type: 'object' };
  assertJsonValue(schema, 'Tool replay schema');
  return {
    version: 1,
    implementationVersion,
    schema: canonicalJson(schema),
    source: registration?.source ?? 'runtime',
    ...(registration?.skillId ? { skillId: registration.skillId } : {}),
    ...(registration?.skillVersion ? { skillVersion: registration.skillVersion } : {}),
    capabilities: [...(registration?.capabilities ?? [])].sort()
  };
}

export function toolReplayContractsMatch(historical: unknown, current?: ToolReplayContract): boolean {
  if (
    !current ||
    !historical ||
    typeof historical !== 'object' ||
    !('version' in historical) ||
    historical.version !== 1
  )
    return false;
  return canonicalJson(historical) === canonicalJson(current);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
