import type { AgentMessage } from '@inkpi/protocol';
import type { Clock, IdGenerator } from './ports/index.js';

export interface SessionTreeOptions {
  idGenerator?: IdGenerator;
  clock?: Clock;
}

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
  private readonly idGenerator: IdGenerator;
  private readonly clock: Clock;
  private generatedId = 0;

  constructor(initialMessages?: AgentMessage[], options: SessionTreeOptions = {}) {
    this.idGenerator = options.idGenerator || (() => `node_${++this.generatedId}`);
    this.clock = options.clock || Date.now;
    if (initialMessages && initialMessages.length > 0) {
      for (const msg of initialMessages) {
        this.addMessage(msg);
      }
    }
  }

  public addMessage(message: AgentMessage, parentId?: string, metadata?: Record<string, unknown>): string {
    const id = message.id || this.idGenerator();
    const effectiveParentId = parentId !== undefined ? parentId : this.currentLeafId;

    if (this.nodes.has(id)) {
      throw new Error(`Node '${id}' already exists in SessionTree`);
    }
    if (effectiveParentId !== null && effectiveParentId !== undefined && !this.nodes.has(effectiveParentId)) {
      throw new Error(`Parent node '${effectiveParentId}' not found in SessionTree`);
    }

    const node: SessionTreeNode = {
      id,
      parentId: effectiveParentId ?? null,
      message: { ...message, id },
      childrenIds: [],
      createdAt: this.clock(),
      metadata
    };

    this.nodes.set(id, node);

    if (effectiveParentId) {
      const parent = this.nodes.get(effectiveParentId)!;
      parent.childrenIds.push(id);
    }

    if (!this.rootId) {
      this.rootId = id;
    }

    this.currentLeafId = id;
    return id;
  }

  /**
   * Move the active leaf to an existing node.
   *
   * Adding a message after this call creates a new in-memory branch. This
   * method does not clone or persist a separate session; durable session
   * forking belongs to the storage/session repository layer.
   */
  public selectLeaf(fromNodeId: string): string {
    if (!this.nodes.has(fromNodeId)) {
      throw new Error(`Node ${fromNodeId} not found in SessionTree`);
    }
    this.currentLeafId = fromNodeId;
    return fromNodeId;
  }

  /**
   * 在当前叶子处追加一条"分支标记"消息（命名一个推演点），不创建新节点、不改变拓扑。
   * 命名说明：旧名 branch() 曾让调用方误以为会真正分叉出新分支，故更名为 addBranchMarker。
   */
  public addBranchMarker(name: string, hypothesis?: string): SessionTreeNode {
    if (!name || !name.trim()) {
      throw new Error('SessionTree.addBranchMarker requires a non-empty label');
    }
    this.addMessage({
      role: 'custom',
      customType: 'branch',
      content: { label: name, hypothesis }
    });
    return this.nodes.get(this.currentLeafId!)!;
  }

  /** @deprecated 名实不符（只追加标记消息，并不分叉），已由 addBranchMarker 取代。 */
  public branch(name: string, hypothesis?: string): SessionTreeNode {
    return this.addBranchMarker(name, hypothesis);
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
   * 返回两个节点最近公共祖先的 id；任一节点不存在时抛错。
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

  /**
   * 提取从根节点到指定目标叶子节点的主链历史路径，并安全清理纯标签/纯标记节点（如分支推演点），
   * 确保压缩边界（Compaction firstKeptEntryId）不会因标签被剪除而游离失效（对齐上游 PR #8990）。
   */
  public getCleanHistoryPath(targetLeafId?: string): AgentMessage[] {
    const rawHistory = this.getHistory(targetLeafId);
    if (rawHistory.length === 0) return [];

    const cleaned: AgentMessage[] = [];
    const replacementByLabelId = new Map<string, string>();
    const pendingLabelIds: string[] = [];

    for (const msg of rawHistory) {
      const isLabel = msg.role === 'custom' && (msg as any).customType === 'branch';
      if (isLabel) {
        if (msg.id) pendingLabelIds.push(msg.id);
        continue;
      }
      if (msg.id) {
        for (const labelId of pendingLabelIds) {
          replacementByLabelId.set(labelId, msg.id);
        }
        pendingLabelIds.length = 0;
      }

      // 如果这是压缩摘要条目，修复其 firstKeptEntryId 边界
      if ((msg as any).firstKeptEntryId) {
        const origBoundary = (msg as any).firstKeptEntryId;
        const mappedBoundary = replacementByLabelId.get(origBoundary) ?? origBoundary;
        cleaned.push({
          ...msg,
          firstKeptEntryId: mappedBoundary
        } as any);
      } else {
        cleaned.push(msg);
      }
    }

    return cleaned;
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
