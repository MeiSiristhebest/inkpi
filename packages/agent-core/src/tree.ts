import type { AgentMessage } from '@inkpi/protocol';

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  message: AgentMessage;
  childrenIds: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export class SessionTree {
  private nodes = new Map<string, SessionTreeNode>();
  private rootId: string | null = null;
  private currentLeafId: string | null = null;

  constructor(initialMessages?: AgentMessage[]) {
    if (initialMessages && initialMessages.length > 0) {
      for (const msg of initialMessages) {
        this.addMessage(msg);
      }
    }
  }

  public addMessage(message: AgentMessage, parentId?: string, metadata?: Record<string, unknown>): string {
    const id = message.id || `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const effectiveParentId = parentId !== undefined ? parentId : this.currentLeafId;

    const node: SessionTreeNode = {
      id,
      parentId: effectiveParentId,
      message: { ...message, id },
      childrenIds: [],
      createdAt: Date.now(),
      metadata
    };

    this.nodes.set(id, node);

    if (effectiveParentId && this.nodes.has(effectiveParentId)) {
      const parent = this.nodes.get(effectiveParentId)!;
      parent.childrenIds.push(id);
    }

    if (!this.rootId) {
      this.rootId = id;
    }

    this.currentLeafId = id;
    return id;
  }

  public fork(fromNodeId: string): string {
    if (!this.nodes.has(fromNodeId)) {
      throw new Error(`Node ${fromNodeId} not found in SessionTree`);
    }
    this.currentLeafId = fromNodeId;
    return fromNodeId;
  }

  public branch(name?: string, hypothesis?: string): SessionTreeNode {
    this.addMessage({ role: 'custom', content: name || '分支', metadata: { hypothesis } } as any);
    return this.nodes.get(this.currentLeafId!)!;
  }

  public navigate(toNodeId: string): boolean {
    if (!this.nodes.has(toNodeId)) return false;
    this.currentLeafId = toNodeId;
    return true;
  }

  public switchBranch(targetLeafId: string): boolean {
    return this.navigate(targetLeafId);
  }

  public getCurrentLeafId(): string | null {
    return this.currentLeafId;
  }

  public getNode(id: string): SessionTreeNode | undefined {
    return this.nodes.get(id);
  }

  public getHistory(leafId?: string): AgentMessage[] {
    const targetId = leafId || this.currentLeafId;
    if (!targetId || !this.nodes.has(targetId)) return [];

    const messages: AgentMessage[] = [];
    let curr: SessionTreeNode | undefined = this.nodes.get(targetId);

    while (curr) {
      messages.unshift(curr.message);
      if (curr.parentId) {
        curr = this.nodes.get(curr.parentId);
      } else {
        break;
      }
    }

    return messages;
  }

  public getBranches(): Array<{ leafId: string; length: number; lastMessage: AgentMessage }> {
    const leaves: Array<{ leafId: string; length: number; lastMessage: AgentMessage }> = [];
    for (const node of this.nodes.values()) {
      if (node.childrenIds.length === 0) {
        const hist = this.getHistory(node.id);
        leaves.push({
          leafId: node.id,
          length: hist.length,
          lastMessage: node.message
        });
      }
    }
    return leaves;
  }

  public getPathToRoot(fromNodeId: string): string[] {
    const path: string[] = [];
    let curr = this.nodes.get(fromNodeId);
    while (curr) {
      path.push(curr.id);
      if (!curr.parentId) break;
      curr = this.nodes.get(curr.parentId);
    }
    return path;
  }

  /**
   * 计算两个分支节点的最近公共祖先 (Lowest Common Ancestor, LCA)
   * 1:1 对标 repos/pi branch-summarization.ts commonAncestorId
   */
  public findCommonAncestor(nodeAId: string, nodeBId: string): string | null {
    if (!this.nodes.has(nodeAId) || !this.nodes.has(nodeBId)) return null;
    if (nodeAId === nodeBId) return nodeAId;

    const pathA = new Set(this.getPathToRoot(nodeAId));
    let curr = this.nodes.get(nodeBId);
    while (curr) {
      if (pathA.has(curr.id)) {
        return curr.id;
      }
      if (!curr.parentId) break;
      curr = this.nodes.get(curr.parentId);
    }
    return null;
  }

  public getAllNodes(): SessionTreeNode[] {
    return Array.from(this.nodes.values());
  }

  public size(): number {
    return this.nodes.size;
  }

  public clear(): void {
    this.nodes.clear();
    this.rootId = null;
    this.currentLeafId = null;
  }
}

