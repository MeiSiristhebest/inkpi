import type {
  InstructionDefinition,
  InstructionEntry,
  InstructionProvenance,
  InstructionReference,
  InstructionScope
} from '@inkpi/protocol';

export type {
  InstructionDefinition,
  InstructionEntry,
  InstructionProvenance,
  InstructionReference,
  InstructionScope
} from '@inkpi/protocol';

export interface InstructionQuery {
  scopes?: InstructionScope[];
  tags?: string[];
  maxCharacters?: number;
}

export interface ComposedInstructions {
  text: string;
  entryIds: string[];
  truncated: boolean;
  version: string;
  /** Safe metadata for task-result provenance; instruction content stays in-process. */
  references?: InstructionReference[];
}

export class InstructionRegistry {
  private readonly entries = new Map<string, InstructionEntry>();
  private revision = 0;

  register(entry: InstructionEntry): void {
    if (!entry.id.trim() || !entry.content.trim()) throw new Error('Instruction id and content are required');
    if (this.entries.has(entry.id)) throw new Error(`Instruction already registered: ${entry.id}`);
    this.entries.set(entry.id, cloneEntry(entry));
    this.revision += 1;
  }

  registerDefinition(definition: InstructionDefinition): void {
    this.register({
      id: definition.id,
      scope: 'task',
      content: definition.systemInstruction,
      version: definition.version,
      source: `task:${definition.taskKind}`,
      tags: [`task:${definition.taskKind}`],
      provenance: definition.provenance
    });
  }

  upsert(entry: InstructionEntry): void {
    if (!entry.id.trim() || !entry.content.trim()) throw new Error('Instruction id and content are required');
    this.entries.set(entry.id, cloneEntry(entry));
    this.revision += 1;
  }

  unregister(id: string): boolean {
    const deleted = this.entries.delete(id);
    if (deleted) this.revision += 1;
    return deleted;
  }

  list(): InstructionEntry[] {
    return [...this.entries.values()].map(cloneEntry);
  }

  /** Return metadata-only references suitable for a cross-process status or result. */
  listReferences(): InstructionReference[] {
    return [...this.entries.values()].map(toReference);
  }

  compose(query: InstructionQuery = {}): ComposedInstructions {
    const maxCharacters = Math.max(0, query.maxCharacters ?? Number.MAX_SAFE_INTEGER);
    const selected = [...this.entries.values()]
      .filter((entry) => entry.enabled !== false)
      .filter((entry) => !query.scopes || query.scopes.includes(entry.scope))
      .filter((entry) => !query.tags || query.tags.every((tag) => entry.tags?.includes(tag)))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));
    const contents: string[] = [];
    const entryIds: string[] = [];
    const references: InstructionReference[] = [];
    let length = 0;
    let truncated = false;
    for (const entry of selected) {
      const separator = contents.length ? '\n\n' : '';
      const remaining = maxCharacters - length - separator.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (entry.content.length > remaining) {
        contents.push(`${separator}${entry.content.slice(0, remaining)}`);
        entryIds.push(entry.id);
        references.push(toReference(entry));
        truncated = true;
        break;
      }
      contents.push(`${separator}${entry.content}`);
      entryIds.push(entry.id);
      references.push(toReference(entry));
      length += separator.length + entry.content.length;
    }
    return { text: contents.join(''), entryIds, truncated, version: this.version(), references };
  }

  composeForTask(taskKind: string, maxCharacters?: number): ComposedInstructions {
    return this.compose({ tags: [`task:${taskKind}`], maxCharacters });
  }

  resolve(taskKind: string): InstructionEntry | undefined {
    return this.list()
      .filter((entry) => entry.enabled !== false && entry.tags?.includes(`task:${taskKind}`))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))[0];
  }

  version(): string {
    return `instructions-${this.revision}`;
  }
}

function cloneEntry(entry: InstructionEntry): InstructionEntry {
  return {
    ...entry,
    tags: entry.tags ? [...entry.tags] : undefined,
    provenance: entry.provenance ? { ...entry.provenance } : undefined
  };
}

function toReference(entry: InstructionEntry): InstructionReference {
  return {
    id: entry.id,
    scope: entry.scope,
    version: entry.version,
    source: entry.source,
    tags: entry.tags ? [...entry.tags] : undefined,
    provenance: entry.provenance ? { ...entry.provenance } : undefined
  };
}
