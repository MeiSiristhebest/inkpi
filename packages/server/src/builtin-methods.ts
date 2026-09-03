import type { BranchSummarizer } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import type { ServerContext } from './server.js';

export type RpcMethodHandler = (
  params: any,
  ctx: ServerContext,
  branchSummarizer?: BranchSummarizer
) => Promise<any> | any;

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

/**
 * 内建 RPC 核心方法模块映射表 (OCP 重构：消灭 35 个 case 的硬编码 switch 分发)
 * 允许无痛扩展新方法而无须修改分发核心。
 */
export const BUILTIN_RPC_METHODS: Record<string, RpcMethodHandler> = {
  // 1. Agent methods
  'agent.prompt': async (params, ctx) => {
    if (!ctx.agent) throw new Error('Agent not initialized');
    if (typeof params.prompt !== 'string' || params.prompt.trim().length === 0) {
      throw new Error('agent.prompt requires a non-empty prompt');
    }
    await ctx.agent.prompt(params.prompt, params.images);
    return { success: true };
  },

  'agent.steer': (params, ctx) => {
    if (!ctx.agent) throw new Error('Agent not initialized');
    ctx.agent.steer(normalizeAgentMessage(params.message ?? params.prompt, 'agent.steer'));
    return { success: true };
  },

  'agent.followUp': (params, ctx) => {
    if (!ctx.agent) throw new Error('Agent not initialized');
    ctx.agent.followUp(normalizeAgentMessage(params.message ?? params.prompt, 'agent.followUp'));
    return { success: true };
  },

  'agent.getState': (_params, ctx) => {
    if (!ctx.agent) throw new Error('Agent not initialized');
    return {
      messages: ctx.agent.state.messages,
      isStreaming: ctx.agent.state.isStreaming,
      thinkingLevel: ctx.agent.state.thinkingLevel,
      model: ctx.agent.state.model.id
    };
  },

  'agent.abort': (_params, ctx) => {
    if (!ctx.agent) throw new Error('Agent not initialized');
    ctx.agent.abort();
    return { success: true };
  },

  // 2. Editor methods
  'editor.getText': (_params, ctx) => {
    if (!ctx.editor) throw new Error('Editor not initialized');
    return ctx.editor.getText();
  },

  'editor.insert': (params, ctx) => BUILTIN_RPC_METHODS['editor.insertText'](params, ctx),
  'editor.insertText': (params, ctx) => {
    if (!ctx.editor) throw new Error('Editor not initialized');
    const pos = params.pos !== undefined ? params.pos : ctx.editor.getText().length;
    ctx.editor.insertText(pos, params.text);
    return { text: ctx.editor.getText() };
  },

  'editor.replaceRange': (params, ctx) => {
    if (!ctx.editor) throw new Error('Editor not initialized');
    ctx.editor.replaceRange(params.start, params.end, params.text);
    return { text: ctx.editor.getText() };
  },

  'editor.delete': (params, ctx) => {
    if (!ctx.editor) throw new Error('Editor not initialized');
    const from = params.from ?? params.start ?? 0;
    const to = params.to ?? params.end ?? ctx.editor.getText().length;
    ctx.editor.replaceRange(from, to, '');
    return { text: ctx.editor.getText() };
  },

  'editor.undo': (_params, ctx) => {
    if (!ctx.editor) throw new Error('Editor not initialized');
    return { success: ctx.editor.undo() };
  },

  'editor.redo': (_params, ctx) => {
    if (!ctx.editor) throw new Error('Editor not initialized');
    return { success: ctx.editor.redo() };
  },

  // 3. Ghost text methods
  'ghost.set': (params, ctx) => BUILTIN_RPC_METHODS['ghost.suggest'](params, ctx),
  'ghost.suggest': (params, ctx) => {
    if (!ctx.ghost) throw new Error('Ghost text manager not initialized');
    const suggestion = params.suggestion || params.text;
    ctx.ghost.suggest(suggestion, params.pos);
    const current = ctx.ghost.getSuggestion();
    return { suggestion: current, ghostText: current, success: true };
  },

  'ghost.accept': (params, ctx) => {
    if (!ctx.ghost) throw new Error('Ghost text manager not initialized');
    let accepted: boolean;
    if (params.mode === 'word') {
      accepted = ctx.ghost.acceptWord();
    } else if (params.mode === 'line') {
      accepted = ctx.ghost.acceptLine();
    } else {
      accepted = ctx.ghost.accept();
    }
    return { accepted, success: accepted, text: ctx.editor?.getText() };
  },

  'ghost.dismiss': (_params, ctx) => {
    if (!ctx.ghost) throw new Error('Ghost text manager not initialized');
    ctx.ghost.dismiss();
    return { success: true };
  },

  // 4. Session Tree & Branches
  'tree.branch': (params, ctx) => {
    if (!ctx.tree) throw new Error('SessionTree not initialized');
    const node = ctx.tree.addBranchMarker(params.name, params.hypothesis);
    return { node };
  },

  'tree.fork': (params, ctx) => {
    if (!ctx.tree) throw new Error('SessionTree not initialized');
    const fromNodeId = params.fromNodeId || params.targetNodeId;
    if (typeof fromNodeId !== 'string' || fromNodeId.length === 0) {
      throw new Error('tree.fork requires fromNodeId');
    }
    ctx.tree.selectLeaf(fromNodeId);
    const node = ctx.tree.getNode(fromNodeId);
    return { leafId: fromNodeId, currentLeafId: fromNodeId, created: false, node };
  },

  'tree.getBranches': (_params, ctx) => {
    if (!ctx.tree) throw new Error('SessionTree not initialized');
    return ctx.tree.getBranches();
  },

  'tree.switchBranch': (params, ctx) => BUILTIN_RPC_METHODS['tree.navigate'](params, ctx),
  'tree.navigate': (params, ctx) => {
    if (!ctx.tree) throw new Error('SessionTree not initialized');
    const targetId = params.targetLeafId || params.nodeId;
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new Error('tree.navigate requires targetLeafId or nodeId');
    }
    if (!ctx.tree.navigate(targetId)) {
      throw new Error(`SessionTree node '${targetId}' not found`);
    }
    const node = ctx.tree.getNode(targetId);
    return { currentLeafId: targetId, node };
  },

  'tree.getSummary': async (params, ctx, branchSummarizer) => {
    if (!ctx.tree) throw new Error('SessionTree not initialized');
    if (!branchSummarizer) throw new Error('Branch summarization capability not configured');
    const fromLeaf = params.fromLeafId || ctx.tree.getCurrentLeafId();
    const toLeaf = params.toLeafId;
    if (typeof fromLeaf !== 'string' || fromLeaf.length === 0) {
      throw new Error('tree.getSummary requires fromLeafId');
    }
    if (typeof toLeaf !== 'string' || toLeaf.length === 0) {
      throw new Error('tree.getSummary requires toLeafId');
    }
    const summary = await branchSummarizer.summarizeBranch(ctx.tree, fromLeaf, toLeaf);
    return { summary };
  },

  // 5. Slash Commands
  'slash.execute': async (params, ctx) => BUILTIN_RPC_METHODS['command.execute'](params, ctx),
  'command.execute': async (params, ctx) => {
    const argSuffix = typeof params.args === 'string' && params.args.length > 0 ? ` ${params.args}` : '';
    const cmd = `${params.command ?? params.cmd ?? ''}${argSuffix}`.trim();
    const res = await ctx.slashRegistry!.execute(cmd, {
      agent: ctx.agent,
      tree: ctx.tree,
      editor: ctx.editor
    });
    return res;
  },

  // 6. Pipeline execution
  'workflow.run': (params, ctx) => {
    if (!ctx.pipeline) throw new Error('Pipeline not initialized');
    return ctx.pipeline.runWorkflow(params);
  },

  'pipeline.run': async (params, ctx) => {
    if (!ctx.pipeline) throw new Error('Pipeline not initialized');
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
    const res = await ctx.pipeline.runPipeline(bookTitle, chapterTitle, userPrompt);
    return res;
  },

  // 7. Journal
  'journal.append': (params, ctx) => {
    if (!ctx.journal) throw new Error('Journal not initialized');
    return ctx.journal.append(params.type, params.payload, params.id);
  },

  'journal.getEntries': (_params, ctx) => {
    if (!ctx.journal) throw new Error('Journal not initialized');
    return ctx.journal.getEntries();
  },

  // 8. JIT Memory
  'jit.retrieve': (params, ctx) => BUILTIN_RPC_METHODS['storage.queryMemory'](params, ctx),
  'storage.queryMemory': async (params, ctx) => {
    if (!ctx.jitRetriever) throw new Error('JitRetriever not initialized');
    const mem = await ctx.jitRetriever.retrieve(params);
    return mem;
  },

  // 9. FTS search
  'storage.searchFts': (params, ctx) => BUILTIN_RPC_METHODS['fts.search'](params, ctx),
  'fts.search': (params, ctx) => {
    if (!ctx.fts) throw new Error('FTS search capability not initialized');
    const results = ctx.fts.search(params.query, params.limit);
    return results;
  },

  // 10. Telemetry metrics
  'telemetry.getStats': (_params, ctx) => BUILTIN_RPC_METHODS['telemetry.getMetrics'](_params, ctx),
  'telemetry.getMetrics': (_params, ctx) => {
    if (!ctx.telemetry) throw new Error('Telemetry capability not initialized');
    return ctx.telemetry.getMetrics();
  },

  'telemetry.exportOtel': (_params, ctx) => {
    if (!ctx.telemetry) throw new Error('Telemetry capability not initialized');
    return ctx.telemetry.exportOpenTelemetryJson();
  }
};
