import type {
  AgentMessage,
  AssetRecord,
  EntityRecord,
  LocationRecord,
  StateLedger,
  TrackRecord
} from '@meisiristhebest/protocol';

export interface LedgerExtractorContext {
  messages: AgentMessage[];
  entitiesMap: Map<string, EntityRecord>;
  assetsMap: Map<string, AssetRecord>;
  tracksMap: Map<string, TrackRecord>;
  locationsMap: Map<string, LocationRecord>;
  modifiedResources: Set<string>;

  /** @deprecated Use entitiesMap. Kept for existing domain adapters. */
  charactersMap: Map<string, EntityRecord>;
  /** @deprecated Use assetsMap. Kept for existing domain adapters. */
  itemsMap: Map<string, AssetRecord>;
  /** @deprecated Use tracksMap. Kept for existing domain adapters. */
  foreshadowingsMap: Map<string, TrackRecord>;
}

export interface LedgerExtractor {
  name: string;
  extract(rawText: string, ctx: LedgerExtractorContext, msg: AgentMessage): void;
}

/**
 * Narrative-specific projection. It is intentionally not part of the generic
 * extractor pipeline; callers must opt in through extractNovelStateLedger().
 */
export const NarrativeSemanticLedgerExtractor: LedgerExtractor = {
  name: 'narrative_semantic_extractor',
  extract(rawText, ctx, msg): void {
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type !== 'toolCall') continue;
        const args = block.arguments;

        if ((block.name === 'update_character' || block.name === 'update_entity') && typeof args.name === 'string') {
          ctx.entitiesMap.set(args.name, {
            name: args.name,
            status: typeof args.status === 'string' ? args.status : undefined,
            affiliation: typeof args.affiliation === 'string' ? args.affiliation : undefined,
            relationship: typeof args.relationship === 'string' ? args.relationship : undefined,
            attributes: isRecord(args.attributes) ? args.attributes : undefined
          });
        }

        if ((block.name === 'update_item' || block.name === 'update_asset') && typeof args.name === 'string') {
          ctx.assetsMap.set(args.name, {
            name: args.name,
            holder: typeof args.holder === 'string' ? args.holder : undefined,
            state: typeof args.state === 'string' ? args.state : undefined,
            attributes: isRecord(args.attributes) ? args.attributes : undefined
          });
        }

        if (
          (block.name === 'track_foreshadowing' || block.name === 'track_clue' || block.name === 'track') &&
          typeof (args.clue || args.content) === 'string'
        ) {
          const clue = String(args.clue || args.content);
          ctx.tracksMap.set(clue, {
            clue,
            status: args.status === 'resolved' ? 'resolved' : 'pending'
          });
        }

        if (
          (block.name === 'modify_chapter' || block.name === 'modify_document' || block.name === 'modify_resource') &&
          typeof (args.chapterTitle || args.documentTitle || args.title) === 'string'
        ) {
          ctx.modifiedResources.add(String(args.chapterTitle || args.documentTitle || args.title));
        }
      }
    }

    if (!rawText) return;

    const resourceMatches = rawText.match(
      /(?:(?:doc|res|ch|section|mod|item|scene|act)[_-\w]+|第[一二三四五六七八九十百千万\d]+[章回幕卷节])/gi
    );
    for (const resource of resourceMatches || []) ctx.modifiedResources.add(resource);

    const entityTag = /<(?:entity|character)\s+name=["']([^"']+)["'](?:\s+status=["']([^"']+)["'])?[^>]*\/>/gi;
    for (let match = entityTag.exec(rawText); match; match = entityTag.exec(rawText)) {
      ctx.entitiesMap.set(match[1], { name: match[1], status: match[2] });
    }

    const assetTag = /<(?:asset|item)\s+name=["']([^"']+)["'](?:\s+holder=["']([^"']+)["'])?[^>]*\/>/gi;
    for (let match = assetTag.exec(rawText); match; match = assetTag.exec(rawText)) {
      ctx.assetsMap.set(match[1], { name: match[1], holder: match[2], state: 'active' });
    }

    const trackTag = /<track\s+(?:clue|content)=["']([^"']+)["'](?:\s+status=["']([^"']+)["'])?[^>]*\/>/gi;
    for (let match = trackTag.exec(rawText); match; match = trackTag.exec(rawText)) {
      ctx.tracksMap.set(match[1], {
        clue: match[1],
        status: match[2] === 'resolved' ? 'resolved' : 'pending'
      });
    }

    const locationTag = /<location\s+name=["']([^"']+)["'][^>]*\/>/gi;
    for (let match = locationTag.exec(rawText); match; match = locationTag.exec(rawText)) {
      ctx.locationsMap.set(match[1], { name: match[1] });
    }
  }
};

/** @deprecated Use NarrativeSemanticLedgerExtractor explicitly. */
export const DefaultSemanticLedgerExtractor = NarrativeSemanticLedgerExtractor;

export function extractStateLedger(messages: AgentMessage[], customExtractors: LedgerExtractor[] = []): StateLedger {
  return extractLedger(messages, customExtractors, false);
}

/**
 * Compatibility adapter for the former novel-oriented default behavior.
 * Generic code should use extractStateLedger() and pass its own extractors.
 */
export function extractNovelStateLedger(
  messages: AgentMessage[],
  customExtractors: LedgerExtractor[] = []
): StateLedger {
  return extractLedger(messages, [NarrativeSemanticLedgerExtractor, ...customExtractors], true);
}

function extractLedger(
  messages: AgentMessage[],
  extractors: LedgerExtractor[],
  includeLegacyAliases: boolean
): StateLedger {
  const entitiesMap = new Map<string, EntityRecord>();
  const assetsMap = new Map<string, AssetRecord>();
  const tracksMap = new Map<string, TrackRecord>();
  const locationsMap = new Map<string, LocationRecord>();
  const ctx: LedgerExtractorContext = {
    messages,
    entitiesMap,
    assetsMap,
    tracksMap,
    locationsMap,
    modifiedResources: new Set(),
    charactersMap: entitiesMap,
    itemsMap: assetsMap,
    foreshadowingsMap: tracksMap
  };

  for (const msg of messages) {
    const rawText = messageText(msg);
    for (const extractor of extractors) extractor.extract(rawText, ctx, msg);
  }

  const entities = [...entitiesMap.values()];
  const assets = [...assetsMap.values()];
  const tracks = [...tracksMap.values()];
  const locations = [...locationsMap.values()];
  const modifiedResources = [...ctx.modifiedResources];
  const ledger: StateLedger = {
    entities,
    assets,
    tracks,
    locations,
    modifiedResources
  };

  if (includeLegacyAliases) {
    Object.assign(ledger, {
      characters: entities,
      items: assets,
      foreshadowings: tracks,
      modifiedChapters: modifiedResources,
      modifiedDocuments: modifiedResources
    });
  }

  return ledger;
}

function messageText(msg: AgentMessage): string {
  if (msg.role === 'user' || msg.role === 'system' || msg.role === 'custom') {
    return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  }
  if (msg.role === 'toolResult') return JSON.stringify(msg.content);
  return msg.content
    .filter((block) => block.type === 'text' || block.type === 'thinking')
    .map((block) => (block.type === 'text' ? block.text : block.thinking))
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function formatStateLedger(
  ledger?: StateLedger,
  customFormatter?: (ledger: StateLedger) => string
): string {
  if (!ledger) return '';
  if (customFormatter) return customFormatter(ledger);

  const sections: string[] = [];
  const entities = ledger.entities || ledger.characters || [];
  const assets = ledger.assets || ledger.items || [];
  const tracks = ledger.tracks || ledger.foreshadowings || [];
  const resources = ledger.modifiedResources || ledger.modifiedChapters || ledger.modifiedDocuments || [];

  if (entities.length > 0) {
    sections.push(`Entities: ${entities.map((entity) => `${entity.name}${entity.status ? `(${entity.status})` : ''}`).join(', ')}`);
  }
  if (assets.length > 0) {
    sections.push(`Assets: ${assets.map((asset) => `${asset.name}${asset.holder ? `[holder:${asset.holder}]` : ''}`).join(', ')}`);
  }
  if (tracks.length > 0) {
    sections.push(`Tracks:\n${tracks.map((track) => `- [${track.status}] ${track.clue}`).join('\n')}`);
  }
  if (resources.length > 0) sections.push(`Resources: ${resources.join(', ')}`);
  return sections.join('\n\n');
}

/** @deprecated Use formatStateLedger() with an explicit narrative adapter. */
export const formatNovelStateLedger = formatStateLedger;
