import * as net from 'node:net';
import type {
  RpcRequest,
  RpcResponse,
  RpcNotification
} from '@inkpi/protocol';
import type { AgentMessage } from '@inkpi/protocol';
import { RPC_ERROR_CODES } from '@inkpi/protocol';
import type { Agent } from '@inkpi/agent-core';
import type { SessionTree } from '@inkpi/agent-core';
import type { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import type { FtsSearchEngine, InkRepository, AppendOnlySessionJournal, JitMemoryRetriever } from '@inkpi/storage';
import { SlashCommandRegistry } from '@inkpi/agent-core';
import { BranchSummarizer } from '@inkpi/agent-core';
import type { WorkflowCoordinator } from '@inkpi/agent-core';
import type { TelemetryCollector } from '@inkpi/agent-core';
import type { ExtensionHost } from '@inkpi/agent-core';
import type { RpcTransport } from './transport.js';
import { TcpSocketTransport } from './tcp-transport.js';
import { WebSocketRpcTransport } from './ws-transport.js';

export interface ServerContext {
  agent?: Agent;
  tree?: SessionTree;
  editor?: HeadlessEditorState;
  ghost?: GhostTextManager;
  storage?: InkRepository;
  fts?: FtsSearchEngine;
  slashRegistry?: SlashCommandRegistry;
  journal?: AppendOnlySessionJournal;
  jitRetriever?: JitMemoryRetriever;
  pipeline?: WorkflowCoordinator;
  telemetry?: TelemetryCollector;
  extensionHost?: ExtensionHost;
  branchSummarizer?: BranchSummarizer;
}

export type RpcNotificationSender = (notification: RpcNotification) => void;

/**
 * InkPi JSON-RPC 2.0 无头服务核心
 *
 * 原位于 `@inkpi/agent-core/src/rpc/server.ts`，作为传输层被错误地放在领域核心包内。
 * 现迁移至 `@inkpi/server`，使 agent-core 成为不依赖表现层 / 基础设施 / 传输层的
 * 纯净领域核心。详见 ARCHITECTURE.md §5。
 */
export class InkRpcServer {
  private ctx: ServerContext;
  private notificationSender?: RpcNotificationSender;
  private branchSummarizer?: BranchSummarizer;
  private boundTransports = new Set<RpcTransport>();
  private tcpServer: net.Server | null = null;
  private wsServer: any | null = null;
  private customHandlers = new Map<string, (params: any) => Promise<any> | any>();

  constructor(ctx: ServerContext = {}, notificationSender?: RpcNotificationSender) {
    this.ctx = {
      ...ctx,
      slashRegistry: ctx.slashRegistry || new SlashCommandRegistry()
    };
    this.branchSummarizer = this.ctx.branchSummarizer;
    this.notificationSender = notificationSender;

    // Attach agent event listener to stream notifications
    if (this.ctx.agent) {
      this.ctx.agent.subscribe((event) => {
        this.notify('agent.event', event);
      });
    }

    // Attach pipeline event listener if present
    if (this.ctx.pipeline) {
      this.ctx.pipeline.subscribe((event: any) => {
        this.notify('pipeline.event', event);
      });
    }
  }

  public setNotificationSender(sender: RpcNotificationSender): void {
    this.notificationSender = sender;
  }

  public registerMethod(name: string, handler: (params: any) => Promise<any> | any): void {
    this.customHandlers.set(name, handler);
  }


  public bindTransport(transport: RpcTransport): void {
    this.boundTransports.add(transport);
    transport.onMessage(async (msgStr) => {
      try {
        const req: RpcRequest = JSON.parse(msgStr);
        const res = await this.handleRequest(req);
        transport.send(JSON.stringify(res));
      } catch (err) {
        transport.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC_ERROR_CODES.PARSE_ERROR, message: 'Invalid JSON message' }
        }));
      }
    });
  }

  public async listenTcp(port: number, host = '127.0.0.1'): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const transport = new TcpSocketTransport(socket);
        this.bindTransport(transport);
        socket.on('close', () => {
          this.boundTransports.delete(transport);
        });
      });

      server.on('error', reject);
      server.listen(port, host, () => {
        this.tcpServer = server;
        resolve(server);
      });
    });
  }

  /**
   * 监听 WebSocket 连接 (浏览器 / Tauri WebView 等 GUI 客户端可直接接入)
   * 复用与 TCP 完全相同的换行无关 JSON-RPC 消息协议 (每条 WS 消息即一条 RPC 消息)
   */
  public async listenWebSocket(port: number, host = '127.0.0.1'): Promise<any> {
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    const { WebSocketServer } = nodeRequire('ws');
    const wss = new WebSocketServer({ port, host });
    wss.on('connection', (ws: any) => {
      const transport = new WebSocketRpcTransport(ws);
      this.bindTransport(transport);
      const cleanup = () => {
        this.boundTransports.delete(transport);
      };
      if (typeof ws.on === 'function') {
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      }
    });
    this.wsServer = wss;
    return wss;
  }

  public async close(): Promise<void> {
    for (const t of this.boundTransports) {
      t.close();
    }
    this.boundTransports.clear();
    if (this.tcpServer) {
      await new Promise<void>((res) => this.tcpServer?.close(() => res()));
      this.tcpServer = null;
    }
    if (this.wsServer) {
      await new Promise<void>((res) => this.wsServer.close(() => res()));
      this.wsServer = null;
    }
  }

  public notify(method: string, params?: any): void {
    const notif: RpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    };
    if (this.notificationSender) {
      this.notificationSender(notif);
    }
    const notifStr = JSON.stringify(notif);
    for (const transport of this.boundTransports) {
      if (transport.isOpen()) {
        transport.send(notifStr);
      }
    }
  }

  public async handleRequest(req: RpcRequest): Promise<RpcResponse> {
    if (!req || req.jsonrpc !== '2.0' || !req.method) {
      return {
        jsonrpc: '2.0',
        id: req?.id ?? null,
        error: {
          code: RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid RPC request structure'
        }
      };
    }

    try {
      const result = await this.dispatch(req.method, req.params || {});
      return {
        jsonrpc: '2.0',
        id: req.id,
        result
      };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: err.code || RPC_ERROR_CODES.INTERNAL_ERROR,
          message: err.message || 'Internal server error',
          data: err.data
        }
      };
    }
  }

  private async dispatch(method: string, params: any): Promise<any> {
    if (this.customHandlers.has(method)) {
      return await this.customHandlers.get(method)!(params);
    }

    switch (method) {
      // 1. Agent methods

      case 'agent.prompt': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        if (typeof params.prompt !== 'string' || params.prompt.trim().length === 0) {
          throw new Error('agent.prompt requires a non-empty prompt');
        }
        await this.ctx.agent.prompt(params.prompt, params.images);
        return { success: true };
      }

      case 'agent.steer': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        this.ctx.agent.steer(normalizeAgentMessage(params.message ?? params.prompt, 'agent.steer'));
        return { success: true };
      }

      case 'agent.followUp': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        this.ctx.agent.followUp(normalizeAgentMessage(params.message ?? params.prompt, 'agent.followUp'));
        return { success: true };
      }

      case 'agent.getState': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        return {
          messages: this.ctx.agent.state.messages,
          isStreaming: this.ctx.agent.state.isStreaming,
          thinkingLevel: this.ctx.agent.state.thinkingLevel,
          model: this.ctx.agent.state.model.id
        };
      }

      case 'agent.abort': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        this.ctx.agent.abort();
        return { success: true };
      }

      // 2. Editor methods
      case 'editor.getText': {
        if (!this.ctx.editor) throw new Error('Editor not initialized');
        return this.ctx.editor.getText();
      }

      case 'editor.insert':
      case 'editor.insertText': {
        if (!this.ctx.editor) throw new Error('Editor not initialized');
        const pos = params.pos !== undefined ? params.pos : this.ctx.editor.getText().length;
        this.ctx.editor.insertText(pos, params.text);
        return { text: this.ctx.editor.getText() };
      }

      case 'editor.replaceRange': {
        if (!this.ctx.editor) throw new Error('Editor not initialized');
        this.ctx.editor.replaceRange(params.start, params.end, params.text);
        return { text: this.ctx.editor.getText() };
      }

      case 'editor.delete': {
        if (!this.ctx.editor) throw new Error('Editor not initialized');
        const from = params.from ?? params.start ?? 0;
        const to = params.to ?? params.end ?? this.ctx.editor.getText().length;
        this.ctx.editor.replaceRange(from, to, '');
        return { text: this.ctx.editor.getText() };
      }

      case 'editor.undo': {
        if (!this.ctx.editor) throw new Error('Editor not initialized');
        return { success: this.ctx.editor.undo() };
      }

      case 'editor.redo': {
        if (!this.ctx.editor) throw new Error('Editor not initialized');
        return { success: this.ctx.editor.redo() };
      }

      // 3. Ghost text methods
      case 'ghost.set':
      case 'ghost.suggest': {
        if (!this.ctx.ghost) throw new Error('Ghost text manager not initialized');
        const suggestion = params.suggestion || params.text;
        this.ctx.ghost.suggest(suggestion, params.pos);
        const current = this.ctx.ghost.getSuggestion();
        return { suggestion: current, ghostText: current, success: true };
      }

      case 'ghost.accept': {
        if (!this.ctx.ghost) throw new Error('Ghost text manager not initialized');
        let accepted: boolean;
        if (params.mode === 'word') {
          accepted = this.ctx.ghost.acceptWord();
        } else if (params.mode === 'line') {
          accepted = this.ctx.ghost.acceptLine();
        } else {
          accepted = this.ctx.ghost.accept();
        }
        return { accepted, success: accepted, text: this.ctx.editor?.getText() };
      }

      case 'ghost.dismiss': {
        if (!this.ctx.ghost) throw new Error('Ghost text manager not initialized');
        this.ctx.ghost.dismiss();
        return { success: true };
      }

      // 4. Session Tree & Branches
      case 'tree.branch': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        const node = this.ctx.tree.branch(params.name, params.hypothesis);
        return { node };
      }

      case 'tree.fork': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        const fromNodeId = params.fromNodeId || params.targetNodeId;
        if (typeof fromNodeId !== 'string' || fromNodeId.length === 0) {
          throw new Error('tree.fork requires fromNodeId');
        }
        this.ctx.tree.selectLeaf(fromNodeId);
        const node = this.ctx.tree.getNode(fromNodeId);
        return { leafId: fromNodeId, currentLeafId: fromNodeId, created: false, node };
      }

      case 'tree.getBranches': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        return this.ctx.tree.getBranches();
      }

      case 'tree.switchBranch':
      case 'tree.navigate': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        const targetId = params.targetLeafId || params.nodeId;
        if (typeof targetId !== 'string' || targetId.length === 0) {
          throw new Error('tree.navigate requires targetLeafId or nodeId');
        }
        if (!this.ctx.tree.navigate(targetId)) {
          throw new Error(`SessionTree node '${targetId}' not found`);
        }
        const node = this.ctx.tree.getNode(targetId);
        return { currentLeafId: targetId, node };
      }

      case 'tree.getSummary': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        if (!this.branchSummarizer) throw new Error('Branch summarization capability not configured');
        const fromLeaf = params.fromLeafId || this.ctx.tree.getCurrentLeafId();
        const toLeaf = params.toLeafId;
        if (typeof fromLeaf !== 'string' || fromLeaf.length === 0) {
          throw new Error('tree.getSummary requires fromLeafId');
        }
        if (typeof toLeaf !== 'string' || toLeaf.length === 0) {
          throw new Error('tree.getSummary requires toLeafId');
        }
        const summary = await this.branchSummarizer.summarizeBranch(this.ctx.tree, fromLeaf, toLeaf);
        return { summary };
      }

      // 5. Slash Commands (command.execute 为 client SDK 兼容别名)
      case 'slash.execute':
      case 'command.execute': {
        const argSuffix = typeof params.args === 'string' && params.args.length > 0 ? ` ${params.args}` : '';
        const cmd = `${params.command ?? params.cmd ?? ''}${argSuffix}`.trim();
        const res = await this.ctx.slashRegistry!.execute(cmd, {
          agent: this.ctx.agent,
          tree: this.ctx.tree,
          editor: this.ctx.editor
        });
        return res;
      }

      // 6. Pipeline execution
      case 'workflow.run': {
        if (!this.ctx.pipeline) throw new Error('Pipeline not initialized');
        return this.ctx.pipeline.runWorkflow(params);
      }

      case 'pipeline.run': {
        if (!this.ctx.pipeline) throw new Error('Pipeline not initialized');
        const bookTitle = params.bookTitle || params.title;
        const chapterTitle = params.chapterTitle || params.documentTitle || params.title;
        const userPrompt = params.userPrompt || params.initialPrompt;
        if (typeof bookTitle !== 'string' || bookTitle.trim().length === 0) {
          throw new Error('pipeline.run requires bookTitle or title in legacy compatibility mode');
        }
        if (typeof chapterTitle !== 'string' || chapterTitle.trim().length === 0) {
          throw new Error('pipeline.run requires chapterTitle or documentTitle in legacy compatibility mode');
        }
        if (typeof userPrompt !== 'string' || userPrompt.trim().length === 0) {
          throw new Error('pipeline.run requires userPrompt or initialPrompt in legacy compatibility mode');
        }
        const res = await this.ctx.pipeline.runPipeline(bookTitle, chapterTitle, userPrompt);
        return res;
      }

      // 7. Journal
      case 'journal.append': {
        if (!this.ctx.journal) throw new Error('Journal not initialized');
        return this.ctx.journal.append(params.type, params.payload, params.id);
      }

      case 'journal.getEntries': {
        if (!this.ctx.journal) throw new Error('Journal not initialized');
        return this.ctx.journal.getEntries();
      }

      // 8. JIT Memory (storage.queryMemory 为 client SDK 兼容别名)
      case 'jit.retrieve':
      case 'storage.queryMemory': {
        if (!this.ctx.jitRetriever) throw new Error('JitRetriever not initialized');
        const mem = await this.ctx.jitRetriever.retrieve(params);
        return mem;
      }

      // 9. FTS search
      case 'storage.searchFts':
      case 'fts.search': {
        if (!this.ctx.fts) throw new Error('FTS search capability not initialized');
        const results = this.ctx.fts.search(params.query, params.limit);
        return results;
      }

      // 10. Telemetry metrics
      case 'telemetry.getStats':
      case 'telemetry.getMetrics': {
        if (!this.ctx.telemetry) throw new Error('Telemetry capability not initialized');
        return this.ctx.telemetry.getMetrics();
      }

      case 'telemetry.exportOtel': {
        if (!this.ctx.telemetry) throw new Error('Telemetry capability not initialized');
        return this.ctx.telemetry.exportOpenTelemetryJson();
      }

      default:
        throw {
          code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Method '${method}' not found`
        };
    }
  }
}

function normalizeAgentMessage(message: unknown, method: string): AgentMessage {
  if (typeof message === 'string') {
    if (message.trim().length === 0) throw new Error(`${method} requires a non-empty message`);
    return { role: 'user', content: message, timestamp: Date.now() };
  }
  if (!message || typeof message !== 'object' || !('role' in message)) {
    throw new Error(`${method} requires a string or AgentMessage`);
  }
  return message as AgentMessage;
}
