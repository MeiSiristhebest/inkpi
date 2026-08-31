import * as net from 'node:net';
import type {
  RpcRequest,
  RpcResponse,
  RpcNotification,
  AgentMessage
} from '@meisiristhebest/protocol';
import { RPC_ERROR_CODES } from '@meisiristhebest/protocol';
import { LiveSessionManager } from './sessions.js';
import type { RpcNotificationSender } from './types.js';

export interface DaemonOptions {
  port?: number;
  host?: string;
  sessionManager?: LiveSessionManager;
}

/**
 * InkPi 常驻守护进程与多端会话分发路由服务 (1:1 对标 pi-server daemon)
 */
export class InkPiDaemon {
  private port: number;
  private host: string;
  private sessionManager: LiveSessionManager;
  private tcpServer: net.Server | null = null;
  private isRunning = false;

  constructor(options: DaemonOptions = {}) {
    this.port = options.port || 9876;
    this.host = options.host || '127.0.0.1';
    this.sessionManager = options.sessionManager || new LiveSessionManager();
  }

  public getSessionManager(): LiveSessionManager {
    return this.sessionManager;
  }

  public async start(): Promise<InkPiDaemon> {
    if (this.isRunning) return this;

    return new Promise((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        this.handleClientSocket(socket);
      });

      this.tcpServer.on('error', (err) => {
        reject(err);
      });

      this.tcpServer.listen(this.port, this.host, () => {
        this.isRunning = true;
        resolve(this);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || !this.tcpServer) return;
    return new Promise((resolve) => {
      this.tcpServer!.close(() => {
        this.isRunning = false;
        this.tcpServer = null;
        resolve();
      });
    });
  }

  public getPort(): number {
    return this.port;
  }

  public attachTransport(
    sendNotification: RpcNotificationSender
  ): (request: RpcRequest) => Promise<RpcResponse> {
    return (req) => this.dispatchRequest(req, sendNotification);
  }

  private handleClientSocket(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';

    const sendNotification: RpcNotificationSender = (notif) => {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(notif) + '\n');
      }
    };

    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line) {
          try {
            const req = JSON.parse(line) as RpcRequest;
            const res = await this.dispatchRequest(req, sendNotification);
            if (!socket.destroyed) {
              socket.write(JSON.stringify(res) + '\n');
            }
          } catch (err: any) {
            if (!socket.destroyed) {
              const errRes: RpcResponse = {
                jsonrpc: '2.0',
                id: null as any,
                error: {
                  code: RPC_ERROR_CODES.PARSE_ERROR,
                  message: 'Parse error: ' + (err?.message || String(err))
                }
              };

              socket.write(JSON.stringify(errRes) + '\n');
            }
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });
  }

  public async dispatchRequest(
    req: RpcRequest,
    sendNotification?: RpcNotificationSender
  ): Promise<RpcResponse> {
    try {
      const result = await this.handleMethod(req.method, req.params || {}, sendNotification);
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
          message: err.message || String(err),
          data: err.data
        }
      };
    }
  }

  private async handleMethod(
    method: string,
    params: any,
    sendNotification?: RpcNotificationSender
  ): Promise<any> {
    switch (method) {
      case 'session.create': {
        const sessionId = params.sessionId || `sess_${Date.now()}`;
        const session = this.sessionManager.createSession(sessionId, {
          model: params.model,
          initialText: params.initialText
        });
        return { sessionId: session.sessionId, createdAt: session.createdAt };
      }

      case 'session.list': {
        return this.sessionManager.listSessions();
      }

      case 'session.close': {
        const success = this.sessionManager.closeSession(params.sessionId);
        return { success };
      }

      case 'session.get_state': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        return {
          sessionId: session.sessionId,
          editorText: session.editor.getText(),
          cursor: session.editor.getSelection().to,
          ghostText: session.ghost.getSuggestion(),
          messages: session.messages,
          lastActiveAt: session.lastActiveAt
        };
      }

      case 'session.prompt': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);

        const userMsg: AgentMessage = {
          id: `msg_u_${Date.now()}`,
          role: 'user',
          content: params.prompt
        };
        session.messages.push(userMsg);

        // Stream notification to client
        if (sendNotification) {
          sendNotification({
            jsonrpc: '2.0',
            method: 'session.event',
            params: {
              sessionId: session.sessionId,
              event: { type: 'message_start', message: userMsg }
            }
          });
        }

        const asstMsg: AgentMessage = {
          id: `msg_a_${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: `InkPi Response for [${session.sessionId}]: ${params.prompt}` }]
        };
        session.messages.push(asstMsg);

        if (sendNotification) {
          sendNotification({
            jsonrpc: '2.0',
            method: 'session.event',
            params: {
              sessionId: session.sessionId,
              event: { type: 'message_end', message: asstMsg }
            }
          });
        }

        return { success: true, messageCount: session.messages.length };
      }

      case 'session.abort': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        return { success: true };
      }

      case 'session.editor.insert': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        const pos = params.pos ?? session.editor.getSelection().to;
        session.editor.insertText(pos, params.text || '');
        return { text: session.editor.getText(), cursor: session.editor.getSelection().to };
      }

      case 'session.editor.undo': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        const tr = session.editor.undo();
        return { success: Boolean(tr), text: session.editor.getText() };
      }

      case 'session.editor.redo': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        const tr = session.editor.redo();
        return { success: Boolean(tr), text: session.editor.getText() };
      }

      case 'session.ghost.suggest': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        session.ghost.suggest(params.text || '');
        return { success: true, ghostText: session.ghost.getSuggestion() };
      }

      case 'session.ghost.accept': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        const mode = params.mode || 'all';
        let accepted = false;
        if (mode === 'word') accepted = session.ghost.acceptWord();
        else if (mode === 'line') accepted = session.ghost.acceptLine();
        else accepted = session.ghost.accept();
        return { accepted, currentText: session.editor.getText() };
      }

      case 'session.ghost.dismiss': {
        const session = this.sessionManager.getSession(params.sessionId);
        if (!session) throw new Error(`Session '${params.sessionId}' not found.`);
        session.ghost.dismissGhostText();
        return { success: true };
      }

      default:
        throw {
          code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Method '${method}' not found.`
        };
    }
  }
}
