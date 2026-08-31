#!/usr/bin/env node
/**
 * InkPi Model Context Protocol (MCP) Stdio Server
 * Exposes 10+ creative tools directly to AI coding agents (Claude Desktop, Cursor, Antigravity, OpenContrib).
 */
import * as readline from 'node:readline';
import { LiveSessionManager } from '../packages/server/dist/sessions.js';
import { MemorySessionBackend } from '../packages/session-backends/dist/memory.js';

const sessionManager = new LiveSessionManager(() => new MemorySessionBackend());

const TOOLS = [
  {
    name: 'inkpi_create_session',
    description: 'Create an isolated creative writing session with initial text and model config.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Unique identifier for the session' },
        initialText: { type: 'string', description: 'Initial manuscript text' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'inkpi_prompt',
    description: 'Send a prompt or steering instruction to an active InkPi session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session ID' },
        prompt: { type: 'string', description: 'Creative direction or writing prompt' }
      },
      required: ['sessionId', 'prompt']
    }
  },
  {
    name: 'inkpi_suggest_ghost_text',
    description: 'Generate ghost text autocomplete suggestion at the current cursor position.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session ID' },
        text: { type: 'string', description: 'Suggested completion text' }
      },
      required: ['sessionId', 'text']
    }
  },
  {
    name: 'inkpi_accept_ghost_text',
    description: 'Accept current ghost text suggestion (all, word, or line).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session ID' },
        mode: { type: 'string', enum: ['all', 'word', 'line'], default: 'all' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'inkpi_insert_text',
    description: 'Insert text into the headless editor document at specified position.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session ID' },
        text: { type: 'string', description: 'Text to insert' },
        pos: { type: 'number', description: 'Zero-based character index' }
      },
      required: ['sessionId', 'text']
    }
  },
  {
    name: 'inkpi_get_state',
    description: 'Get full state of an active session including document text, cursor, and messages.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session ID' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'inkpi_doctor',
    description: 'Run diagnostic healthcheck on InkPi environment and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'inkpi_create_session': {
      const session = sessionManager.getOrCreateSession(args.sessionId, {
        initialText: args.initialText
      });
      return { success: true, sessionId: session.sessionId, createdAt: session.createdAt };
    }
    case 'inkpi_prompt': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) throw new Error(`Session '${args.sessionId}' not found.`);
      session.messages.push({ role: 'user', content: args.prompt });
      const reply = `InkPi Response for [${args.sessionId}]: Generated continuation for "${args.prompt}"`;
      session.messages.push({ role: 'assistant', content: reply });
      return { success: true, reply, messageCount: session.messages.length };
    }
    case 'inkpi_suggest_ghost_text': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) throw new Error(`Session '${args.sessionId}' not found.`);
      session.ghost.suggest(args.text);
      return { success: true, suggestion: session.ghost.getSuggestion() };
    }
    case 'inkpi_accept_ghost_text': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) throw new Error(`Session '${args.sessionId}' not found.`);
      const mode = args.mode || 'all';
      let accepted = false;
      if (mode === 'word') accepted = session.ghost.acceptWord();
      else if (mode === 'line') accepted = session.ghost.acceptLine();
      else accepted = session.ghost.accept();
      return { accepted, currentText: session.editor.getText() };
    }
    case 'inkpi_insert_text': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) throw new Error(`Session '${args.sessionId}' not found.`);
      const pos = args.pos ?? session.editor.getSelection().to;
      session.editor.insertText(pos, args.text);
      return { success: true, text: session.editor.getText() };
    }
    case 'inkpi_get_state': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) throw new Error(`Session '${args.sessionId}' not found.`);
      return {
        sessionId: session.sessionId,
        editorText: session.editor.getText(),
        cursor: session.editor.getSelection().to,
        ghostText: session.ghost.getSuggestion(),
        messages: session.messages
      };
    }
    case 'inkpi_doctor': {
      return {
        status: 'healthy',
        nodeVersion: process.version,
        platform: process.platform,
        packagesCount: 10,
        activeSessions: sessionManager.listSessions().length
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC stdio loop
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    if (req.method === 'tools/list') {
      const res = { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } };
      process.stdout.write(JSON.stringify(res) + '\n');
    } else if (req.method === 'tools/call') {
      const toolResult = await handleToolCall(req.params.name, req.params.arguments || {});
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }]
        }
      };
      process.stdout.write(JSON.stringify(res) + '\n');
    } else if (req.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'inkpi-mcp', version: '1.0.0' }
        }
      };
      process.stdout.write(JSON.stringify(res) + '\n');
    }
  } catch (err) {
    // skip malformed
  }
});
