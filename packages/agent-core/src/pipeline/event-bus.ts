import type { WorkflowEvent, WorkflowEventListener } from '@inkpi/protocol';

/**
 * 工作流事件总线。
 *
 * 订阅者抛出的异常被就地记录并继续派发：单个监听器故障不应中断整条流水线。
 */
export class WorkflowEventBus {
  private listeners: WorkflowEventListener[] = [];

  /** 订阅事件流，返回退订函数。 */
  public subscribe(listener: WorkflowEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /** 按订阅顺序串行派发事件。 */
  public async emit(event: WorkflowEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        console.error('[WorkflowCoordinator] Error in event listener:', err);
      }
    }
  }

  /** 当前订阅者数量，供测试与诊断使用。 */
  public get size(): number {
    return this.listeners.length;
  }
}
