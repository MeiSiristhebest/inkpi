import type { AgentMessage } from '@meisiristhebest/protocol';
import type { QueueMode } from './types.js';

export class MessageQueue {
  private queue: AgentMessage[] = [];

  public enqueue(...messages: AgentMessage[]): void {
    this.queue.push(...messages);
  }

  public drain(mode: QueueMode = 'all'): AgentMessage[] {
    if (this.queue.length === 0) return [];
    if (mode === 'one-at-a-time') {
      const item = this.queue.shift();
      return item ? [item] : [];
    }
    const items = [...this.queue];
    this.queue = [];
    return items;
  }

  public peek(): AgentMessage | undefined {
    return this.queue[0];
  }

  public size(): number {
    return this.queue.length;
  }

  public clear(): void {
    this.queue = [];
  }

  public toArray(): AgentMessage[] {
    return [...this.queue];
  }
}

export class SteeringQueue extends MessageQueue {}
export class FollowUpQueue extends MessageQueue {}
