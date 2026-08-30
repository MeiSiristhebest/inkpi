import type { AgentMessage, StateLedger } from '@inkpi/protocol';

export interface LedgerExtractorContext {
  messages: AgentMessage[];
  charactersMap: Map<string, { status?: string; affiliation?: string; relationship?: string; attributes?: Record<string, unknown> }>;
  itemsMap: Map<string, { holder?: string; state?: string; attributes?: Record<string, unknown> }>;
  foreshadowingsMap: Map<string, 'pending' | 'resolved'>;
  locations: Set<string>;
  modifiedResources: Set<string>;
}

export interface LedgerExtractor {
  name: string;
  extract(rawText: string, ctx: LedgerExtractorContext, msg: AgentMessage): void;
}

/**
 * 内置基础结构化提取器 (工具调用参数 + 标准 XML 语义标签 + 基础资源标识)
 */
export const DefaultSemanticLedgerExtractor: LedgerExtractor = {
  name: 'default_semantic_extractor',
  extract(rawText: string, ctx: LedgerExtractorContext, msg: AgentMessage): void {
    // 1. 结构化工具调用提取 (Tool Calls)
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'toolCall' && block.arguments) {
          const args = block.arguments as Record<string, any>;
          if ((block.name === 'update_character' || block.name === 'update_entity') && args.name) {
            ctx.charactersMap.set(args.name, {
              status: args.status,
              affiliation: args.affiliation,
              relationship: args.relationship,
              attributes: args.attributes
            });
          }
          if ((block.name === 'update_item' || block.name === 'update_asset') && args.name) {
            ctx.itemsMap.set(args.name, {
              holder: args.holder,
              state: args.state,
              attributes: args.attributes
            });
          }
          if ((block.name === 'track_foreshadowing' || block.name === 'track_clue' || block.name === 'track') && (args.clue || args.content)) {
            const clue = args.clue || args.content;
            ctx.foreshadowingsMap.set(clue, args.status === 'resolved' ? 'resolved' : 'pending');
          }
          if ((block.name === 'modify_chapter' || block.name === 'modify_document' || block.name === 'modify_resource') && (args.chapterTitle || args.documentTitle || args.title)) {
            ctx.modifiedResources.add(args.chapterTitle || args.documentTitle || args.title);
          }
        }
      }
    }

    if (!rawText) return;

    // 2. 扫描资源引用 (如: "doc_1", "res_abc", "ch_1", "section_1", "第12章")
    const resMatches = rawText.match(/(?:(?:doc|res|ch|section|mod|item|scene|act)[_-\w]+|第[一二三四五六七八九十百千万\d]+[章回幕卷节])/gi);
    if (resMatches) {
      for (const r of resMatches) ctx.modifiedResources.add(r);
    }

    // 3. 扫描结构化 XML 标签: <entity name="..." status="..." /> / <character name="..." status="..." />
    const tagEntityRegex = /<(?:entity|character)\s+name=["']([^"']+)["'](?:\s+status=["']([^"']+)["'])?[^>]*\/>/gi;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagEntityRegex.exec(rawText)) !== null) {
      const name = tagMatch[1];
      const status = tagMatch[2];
      if (name) ctx.charactersMap.set(name, { status });
    }

    // 4. 扫描结构化 XML 标签: <asset name="..." holder="..." /> / <item name="..." holder="..." />
    const tagAssetRegex = /<(?:asset|item)\s+name=["']([^"']+)["'](?:\s+holder=["']([^"']+)["'])?[^>]*\/>/gi;
    let assetTagMatch: RegExpExecArray | null;
    while ((assetTagMatch = tagAssetRegex.exec(rawText)) !== null) {
      const name = assetTagMatch[1];
      const holder = assetTagMatch[2];
      if (name) ctx.itemsMap.set(name, { holder, state: 'active' });
    }

    // 5. 扫描结构化 XML 标签: <track clue="..." status="..." /> / <track content="..." status="..." />
    const tagTrackRegex = /<track\s+(?:clue|content)=["']([^"']+)["'](?:\s+status=["']([^"']+)["'])?[^>]*\/>/gi;
    let trackTagMatch: RegExpExecArray | null;
    while ((trackTagMatch = tagTrackRegex.exec(rawText)) !== null) {
      const clue = trackTagMatch[1];
      const status = trackTagMatch[2];
      if (clue) ctx.foreshadowingsMap.set(clue, status === 'resolved' ? 'resolved' : 'pending');
    }

    // 6. 扫描结构化 XML 标签: <location name="..." />
    const tagLocRegex = /<location\s+name=["']([^"']+)["'][^>]*\/>/gi;
    let locTagMatch: RegExpExecArray | null;
    while ((locTagMatch = tagLocRegex.exec(rawText)) !== null) {
      const name = locTagMatch[1];
      if (name) ctx.locations.add(name);
    }
  }
};

/**
 * 结构化抽取实体与会话状态账本 (1:1 对标 repos/pi extractFileOperations 机制)
 * 优先执行内置语义提取器，并允许注入任意自定义领域提取器 (如剧本/视觉小说/短剧/长篇小说提取器)。
 */
export function extractStateLedger(
  messages: AgentMessage[],
  customExtractors: LedgerExtractor[] = []
): StateLedger {
  const ctx: LedgerExtractorContext = {
    messages,
    charactersMap: new Map(),
    itemsMap: new Map(),
    foreshadowingsMap: new Map(),
    locations: new Set(),
    modifiedResources: new Set()
  };

  const extractors = [DefaultSemanticLedgerExtractor, ...customExtractors];

  for (const msg of messages) {
    let rawText = '';
    if (msg.role === 'user') {
      rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    } else if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'text') rawText += ' ' + block.text;
        if (block.type === 'thinking') rawText += ' ' + block.thinking;
      }
    } else if (msg.role === 'toolResult') {
      rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }

    for (const extractor of extractors) {
      extractor.extract(rawText, ctx, msg);
    }
  }

  const entities = Array.from(ctx.charactersMap.entries()).map(([name, info]) => ({
    name,
    ...info
  }));

  const assets = Array.from(ctx.itemsMap.entries()).map(([name, info]) => ({
    name,
    ...info
  }));

  const tracks = Array.from(ctx.foreshadowingsMap.entries()).map(([clue, status]) => ({
    clue,
    status
  }));

  const locations = Array.from(ctx.locations).map((name) => ({ name }));
  const modifiedResources = Array.from(ctx.modifiedResources);

  return {
    entities,
    assets,
    tracks,
    locations,
    modifiedResources,
    // 兼容字段
    characters: entities,
    items: assets,
    foreshadowings: tracks,
    modifiedChapters: modifiedResources,
    modifiedDocuments: modifiedResources
  };
}

export const extractNovelStateLedger = extractStateLedger;

/**
 * 将状态账本格式化为紧凑的系统 Prompt 注入块 (可自定义注入格式化器)
 */
export function formatStateLedger(
  ledger?: StateLedger,
  customFormatter?: (ledger: StateLedger) => string
): string {
  if (!ledger) return '';
  if (customFormatter) {
    return customFormatter(ledger);
  }

  const sections: string[] = [];

  const ents = ledger.entities || ledger.characters || [];
  if (ents.length > 0) {
    const list = ents.map((c) => `${c.name}${c.status ? `(${c.status})` : ''}`).join(', ');
    sections.push(`📌 Active Entities: ${list}`);
  }

  const asts = ledger.assets || ledger.items || [];
  if (asts.length > 0) {
    const list = asts.map((i) => `${i.name}${i.holder ? `[holder:${i.holder}]` : ''}`).join(', ');
    sections.push(`📦 Key Assets & Items: ${list}`);
  }

  const trks = ledger.tracks || ledger.foreshadowings || [];
  if (trks.length > 0) {
    const clues = trks
      .map((f) => `- [${f.status === 'resolved' ? 'RESOLVED' : 'PENDING'}] ${f.clue}`)
      .join('\n');
    sections.push(`🔍 Tracks & Open Threads:\n${clues}`);
  }

  const res = ledger.modifiedResources || ledger.modifiedChapters || (ledger as any).modifiedDocuments || [];
  if (res.length > 0) {
    sections.push(`📄 Active Resources: ${res.join(', ')}`);
  }

  return sections.join('\n\n');
}

export const formatNovelStateLedger = formatStateLedger;

