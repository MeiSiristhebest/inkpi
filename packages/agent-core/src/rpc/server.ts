import * as net from 'node:net';
import type {
  RpcRequest,
  RpcResponse,
  RpcNotification
} from '@inkpi/protocol';
import { RPC_ERROR_CODES } from '@inkpi/protocol';
import type { Agent } from '../agent.js';
import type { SessionTree } from '../tree.js';
import type { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import type { FtsSearchEngine, InkRepository, AppendOnlySessionJournal, JitMemoryRetriever } from '@inkpi/storage';
import { SlashCommandRegistry } from '../slash-commands.js';
import { BranchSummarizer } from '../branch-summary.js';
import type { WorkflowCoordinator } from '../pipeline/coordinator.js';
import type { TelemetryCollector } from '../telemetry/telemetry.js';
import type { ExtensionHost } from '../extension-host.js';
import type { RpcTransport } from './transport.js';
import { TcpSocketTransport } from './tcp-transport.js';

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
}

export type RpcNotificationSender = (notification: RpcNotification) => void;

/**
 * InkPi JSON-RPC 2.0 无头服务核心 (1:1 对标 pi-server)
 */
export class InkRpcServer {
  private ctx: ServerContext;
  private notificationSender?: RpcNotificationSender;
  private branchSummarizer = new BranchSummarizer();
  private boundTransports = new Set<RpcTransport>();
  private tcpServer: net.Server | null = null;

  constructor(ctx: ServerContext = {}, notificationSender?: RpcNotificationSender) {
    this.ctx = {
      ...ctx,
      slashRegistry: ctx.slashRegistry || new SlashCommandRegistry()
    };
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

  public async close(): Promise<void> {
    for (const t of this.boundTransports) {
      t.close();
    }
    this.boundTransports.clear();
    if (this.tcpServer) {
      await new Promise<void>((res) => this.tcpServer?.close(() => res()));
      this.tcpServer = null;
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
    switch (method) {
      // 1. Agent methods
      case 'agent.prompt': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        await this.ctx.agent.prompt(params.prompt, params.images);
        return { success: true };
      }

      case 'agent.steer': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        this.ctx.agent.steer(params.message);
        return { success: true };
      }

      case 'agent.followUp': {
        if (!this.ctx.agent) throw new Error('Agent not initialized');
        this.ctx.agent.followUp(params.message);
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
        if (!this.ctx.editor) return '';
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
        this.ctx.ghost.suggest(suggestion);
        return { suggestion: this.ctx.ghost.getSuggestion() };
      }

      case 'ghost.accept': {
        if (!this.ctx.ghost) throw new Error('Ghost text manager not initialized');
        const accepted = this.ctx.ghost.accept();
        return { accepted, text: this.ctx.editor?.getText() };
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
        const node = this.ctx.tree.branch(params.name || '分支', params.hypothesis);
        return { leafId: node.id, node };
      }

      case 'tree.getBranches': {
        if (!this.ctx.tree) return [];
        return this.ctx.tree.getBranches ? this.ctx.tree.getBranches() : [];
      }

      case 'tree.switchBranch':
      case 'tree.navigate': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        const targetId = params.targetLeafId || params.nodeId;
        const node = this.ctx.tree.navigate(targetId);
        return { currentLeafId: targetId, node };
      }

      case 'tree.getSummary': {
        if (!this.ctx.tree) throw new Error('SessionTree not initialized');
        const fromLeaf = params.fromLeafId || params.targetNodeId || this.ctx.tree.getCurrentLeafId() || '';
        const toLeaf = params.toLeafId || '';
        const summary = await this.branchSummarizer.summarizeBranch(this.ctx.tree, fromLeaf, toLeaf);
        return { summary };
      }

      // 5. Slash Commands
      case 'slash.execute': {
        const cmd = params.command;
        const res = await this.ctx.slashRegistry!.execute(cmd, {
          agent: this.ctx.agent,
          tree: this.ctx.tree,
          editor: this.ctx.editor
        });
        return res;
      }

      // 6. Pipeline execution
      case 'pipeline.run': {
        if (!this.ctx.pipeline) throw new Error('Pipeline not initialized');
        const bookTitle = params.bookTitle || params.title || '作品';
        const chapterTitle = params.chapterTitle || params.documentTitle || '章节';
        const userPrompt = params.userPrompt || params.initialPrompt || '';
        const res = await this.ctx.pipeline.runPipeline(bookTitle, chapterTitle, userPrompt);
        return res;
      }

      // 7. Journal
      case 'journal.append': {
        if (!this.ctx.journal) throw new Error('Journal not initialized');
        return this.ctx.journal.append(params.type, params.payload, params.id);
      }

      case 'journal.getEntries': {
        if (!this.ctx.journal) return [];
        return this.ctx.journal.getEntries();
      }

      // 8. JIT Memory
      case 'jit.retrieve': {
        if (!this.ctx.jitRetriever) throw new Error('JitRetriever not initialized');
        const mem = await this.ctx.jitRetriever.retrieve(params);
        return mem;
      }

      // 9. FTS search
      case 'storage.searchFts':
      case 'fts.search': {
        if (!this.ctx.fts) return [];
        const results = this.ctx.fts.search(params.query, params.limit);
        return results;
      }

      // 10. Telemetry metrics
      case 'telemetry.getStats':
      case 'telemetry.getMetrics': {
        if (!this.ctx.telemetry) return { totalDurationMs: 0 };
        return this.ctx.telemetry.getMetrics();
      }

      case 'telemetry.exportOtel': {
        if (!this.ctx.telemetry) return '{}';
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
