import { performance } from 'node:perf_hooks';
import { type ContextFragment, ContextPipeline, type ContextProvider } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { FtsSearchEngine, InkDb, InkRepository, JitMemoryRetriever, formatJitContextAsPrompt } from '@inkpi/storage';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * P7 scale baseline: a full-length manuscript is ~1000 chapters and ~1M words, so every
 * correctness claim a three-chapter fixture makes has to survive that size.
 *
 * Timing is asserted as a growth ratio against a 4x smaller corpus instead of an absolute
 * budget. CI machines differ by an order of magnitude, but "4x the data must not cost 16x the
 * time" is a portable tripwire against quadratic blow-up.
 */

const BASE_TIME = 1_700_000_000_000;
const MAIN_WORKSPACE = 'ws-scale-main';
const CONTROL_WORKSPACE = 'ws-scale-control';
const DOCUMENTS_PER_FOLDER = 250;
/** ~1050 characters per chapter, so 1000 chapters cross the 1M-character mark. */
const WORDS_PER_CHAPTER = 1000;
const CORPUS_GROWTH_FACTOR = 4;
/** Indexed lookups should stay near-flat, so a 4x corpus gets a 6x ceiling. */
const INDEXED_GROWTH_CEILING = 6;
/** Scan-and-compile work is legitimately linear, so a 4x corpus gets a 12x ceiling. */
const LINEAR_GROWTH_CEILING = 12;

const WORDS = [
  'beacon',
  'frost',
  'ravine',
  'ledger',
  'lantern',
  'oath',
  'ember',
  'harbor',
  'quill',
  'thicket',
  'glacier',
  'saffron',
  'vellum',
  'anvil',
  'cistern',
  'tundra',
  'sable',
  'citadel',
  'orchard',
  'sigil',
  'tide',
  'marrow',
  'compass',
  'relay',
  'vigil',
  'garden',
  'signal',
  'thunder',
  'anchor',
  'meridian',
  'cascade',
  'hollow'
];

/** Rare two-word phrases planted into exactly one chapter each, for exact-hit assertions. */
const PLANTED_PHRASES: Record<number, string> = {
  7: 'kaleidoscope obsidian',
  233: 'cartographer labyrinthine',
  872: 'astrolabe pendulum'
};

function chapterProse(orderIndex: number, wordCount: number, planted?: Record<number, string>): string {
  const parts: string[] = [];
  for (let word = 0; word < wordCount; word += 1) {
    parts.push(WORDS[(orderIndex * 31 + word * 7) % WORDS.length]);
  }
  const phrase = planted?.[orderIndex];
  return phrase ? `${parts.join(' ')} The ${phrase} surfaced once more.` : parts.join(' ');
}

function chapterId(orderIndex: number, workspaceId = MAIN_WORKSPACE): string {
  return `${workspaceId}-ch-${String(orderIndex).padStart(4, '0')}`;
}

interface CorpusOptions {
  workspaceId: string;
  documentCount: number;
  wordsPerChapter?: number;
  plant?: Record<number, string>;
  db?: InkDb;
}

interface Corpus {
  db: InkDb;
  repo: InkRepository;
  fts: FtsSearchEngine;
  documentCount: number;
  totalChars: number;
}

/** Deterministic manuscript-shaped data: one folder per volume, contiguous chapter order. */
function seedCorpus(options: CorpusOptions): Corpus {
  const db = options.db ?? new InkDb(':memory:');
  const repo = new InkRepository(db);
  const fts = new FtsSearchEngine(db);
  const wordsPerChapter = options.wordsPerChapter ?? WORDS_PER_CHAPTER;
  const plant = options.plant ?? PLANTED_PHRASES;
  let totalChars = 0;

  db.transaction(() => {
    repo.createWorkspace({
      id: options.workspaceId,
      title: 'Scale Baseline Manuscript',
      owner: 'author',
      category: 'novel',
      targetSize: options.documentCount * wordsPerChapter * 8,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME
    });
    const folderCount = Math.max(1, Math.ceil(options.documentCount / DOCUMENTS_PER_FOLDER));
    for (let folder = 0; folder < folderCount; folder += 1) {
      const folderId = `${options.workspaceId}-vol-${String(folder + 1).padStart(2, '0')}`;
      repo.createFolder({
        id: folderId,
        workspaceId: options.workspaceId,
        title: `Volume ${folder + 1}`,
        orderIndex: folder + 1,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME
      });
      for (let offset = 1; offset <= DOCUMENTS_PER_FOLDER; offset += 1) {
        const orderIndex = folder * DOCUMENTS_PER_FOLDER + offset;
        if (orderIndex > options.documentCount) break;
        const id = chapterId(orderIndex, options.workspaceId);
        const text = chapterProse(orderIndex, wordsPerChapter, plant);
        totalChars += text.length;
        repo.createDocument({
          id,
          folderId,
          workspaceId: options.workspaceId,
          title: `Chapter ${String(orderIndex).padStart(4, '0')}`,
          orderIndex,
          synopsis: `Chapter ${orderIndex} closes the ${WORDS[orderIndex % WORDS.length]} thread.`,
          contentSize: text.length,
          status: 'completed',
          createdAt: BASE_TIME + orderIndex,
          updatedAt: BASE_TIME + orderIndex
        });
        repo.upsertSnapshot({
          documentId: id,
          version: 1,
          contentJson: '{}',
          contentMarkdown: text,
          contentSize: text.length,
          updatedAt: BASE_TIME + orderIndex
        });
      }
    }
  });

  return { db, repo, fts, documentCount: options.documentCount, totalChars };
}

function countRows(db: InkDb, sql: string): number {
  return Number((db.prepare(sql).get() as Record<string, number | bigint>).count);
}

/** Warm up, then keep the best of `runs` batches so scheduler noise cannot inflate a ratio. */
async function measureMs(runs: number, repeats: number, operation: () => unknown): Promise<number> {
  await operation();
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    for (let repeat = 0; repeat < repeats; repeat += 1) await operation();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Floors tiny baselines: a sub-millisecond small corpus would manufacture a meaningless ratio. */
function growthRatio(smallMs: number, largeMs: number): number {
  return largeMs / Math.max(smallMs, 1);
}

class BulkFragmentProvider implements ContextProvider {
  readonly id = 'scale.bulk-fragments';
  provideCalls = 0;
  fragmentCount: number;
  wordsPerFragment: number;

  constructor(fragmentCount: number, wordsPerFragment: number) {
    this.fragmentCount = fragmentCount;
    this.wordsPerFragment = wordsPerFragment;
  }

  provide(): ContextFragment[] {
    this.provideCalls += 1;
    const fragments: ContextFragment[] = [];
    for (let index = 0; index < this.fragmentCount; index += 1) {
      fragments.push({
        id: fragmentId(index),
        source: this.id,
        kind: 'story-state',
        // 37 is coprime with any fragment count used here, so priorities are distinct and in a
        // permutation of the arrival order. That makes a priority-correct cut distinguishable
        // from "whatever the provider happened to emit first".
        priority: (index * 37) % this.fragmentCount,
        text: chapterProse(index, this.wordsPerFragment)
      });
    }
    return fragments;
  }
}

function fragmentId(index: number): string {
  return `frag-${String(index).padStart(5, '0')}`;
}

function bulkTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'scale-bulk-task',
    kind: 'narrative.continuity',
    scope: { workspaceId: MAIN_WORKSPACE, workspaceRevision: 1 },
    input: { documentId: chapterId(600), text: 'The beacon waits at the harbor.' },
    contextPolicy: { providerIds: ['scale.bulk-fragments'], maxTokens: 2000 },
    outputContract: { format: 'text' },
    ...overrides
  };
}

type CompiledPacket = Awaited<ReturnType<ContextPipeline['build']>>;

async function compileBulk(fragmentCount: number): Promise<{ ms: number; packet: CompiledPacket }> {
  // A budget above the total keeps every fragment, so the measurement covers the full compile.
  const pipeline = new ContextPipeline({ maxTokens: 200_000, cache: { enabled: false } });
  pipeline.register(new BulkFragmentProvider(fragmentCount, 40));
  const task = bulkTask({ contextPolicy: { providerIds: ['scale.bulk-fragments'], maxTokens: 200_000 } });
  try {
    const ms = await measureMs(3, 5, () => pipeline.build(task));
    return { ms, packet: await pipeline.build(task) };
  } finally {
    pipeline.dispose();
  }
}

const sharedDb = new InkDb(':memory:');
const world = seedCorpus({ db: sharedDb, workspaceId: MAIN_WORKSPACE, documentCount: 1000 });
// The control workspace shares the database and repeats one rare phrase, so workspace scoping is
// the only thing that can exclude it.
const control = seedCorpus({
  db: sharedDb,
  workspaceId: CONTROL_WORKSPACE,
  documentCount: 4,
  wordsPerChapter: 40,
  plant: { 2: PLANTED_PHRASES[7] }
});

afterAll(() => sharedDb.close());

describe('P7 runtime scale baseline', () => {
  it('holds a 1000-chapter, 1M-word manuscript without loss', () => {
    expect(world.documentCount).toBe(1000);
    expect(world.documentCount * WORDS_PER_CHAPTER).toBe(1_000_000);
    expect(world.totalChars).toBeGreaterThanOrEqual(5_000_000);

    // What the seeding pass reported is what actually landed in storage.
    expect(
      countRows(sharedDb, `SELECT COUNT(*) AS count FROM documents WHERE workspace_id = '${MAIN_WORKSPACE}'`)
    ).toBe(1000);
    expect(
      countRows(
        sharedDb,
        `SELECT COALESCE(SUM(LENGTH(s.content_markdown)), 0) AS count
         FROM document_snapshots s JOIN documents d ON d.id = s.document_id
         WHERE d.workspace_id = '${MAIN_WORKSPACE}'`
      )
    ).toBe(world.totalChars);
    // The snapshot triggers must have indexed every chapter, not a prefix of them.
    expect(countRows(sharedDb, 'SELECT COUNT(*) AS count FROM documents_fts')).toBe(
      world.documentCount + control.documentCount
    );

    const folders = world.repo.getFolders(MAIN_WORKSPACE);
    expect(folders.map((folder) => folder.orderIndex)).toEqual([1, 2, 3, 4]);
    let previousOrder = 0;
    let seen = 0;
    for (const folder of folders) {
      const chapters = world.repo.getDocuments(folder.id);
      expect(chapters.length).toBe(DOCUMENTS_PER_FOLDER);
      for (const chapter of chapters) {
        expect(chapter.orderIndex).toBeGreaterThan(previousOrder);
        expect(chapter.workspaceId).toBe(MAIN_WORKSPACE);
        previousOrder = chapter.orderIndex;
        seen += 1;
      }
    }
    expect(seen).toBe(1000);

    // Round-trip a deterministic sample spanning the whole manuscript, not just its head.
    for (const orderIndex of [1, 97, 250, 251, 512, 873, 1000]) {
      const stored = world.repo.getDocument(chapterId(orderIndex));
      expect(stored?.id).toBe(chapterId(orderIndex));
      expect(stored?.title).toBe(`Chapter ${String(orderIndex).padStart(4, '0')}`);
      expect(stored?.contentSize).toBeGreaterThan(800);
      expect(stored?.synopsis).toContain('closes the');
    }
  });

  it('keeps BM25 ranking, limits, and workspace isolation exact at manuscript scale', () => {
    const broad = world.fts.search({ query: 'beacon', workspaceId: MAIN_WORKSPACE, limit: 20 });
    expect(broad.length).toBe(20);
    // BM25 ordering is only verifiable if the FTS5 backend scored every hit.
    const ranks = broad.map((hit) => hit.rank).filter((rank): rank is number => typeof rank === 'number');
    expect(ranks.length).toBe(broad.length);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    for (const hit of broad) {
      expect(world.repo.getDocument(hit.documentId)?.workspaceId).toBe(MAIN_WORKSPACE);
    }

    // A phrase unique to one chapter resolves to exactly that chapter.
    expect(
      world.fts.search({ query: 'kaleidoscope obsidian', workspaceId: MAIN_WORKSPACE }).map((hit) => hit.documentId)
    ).toEqual([chapterId(7)]);
    // Unscoped search still sees both workspaces, so scoping is what excludes the control row.
    const global = world.fts.search({ query: 'kaleidoscope obsidian' });
    expect(new Set(global.map((hit) => hit.documentId))).toEqual(
      new Set([chapterId(7), chapterId(2, CONTROL_WORKSPACE)])
    );
    expect(
      control.fts
        .search({ query: 'kaleidoscope obsidian', workspaceId: CONTROL_WORKSPACE })
        .map((hit) => hit.documentId)
    ).toEqual([chapterId(2, CONTROL_WORKSPACE)]);

    // A limit far above the match count neither fabricates nor drops rows.
    expect(
      world.fts
        .search({ query: 'astrolabe pendulum', workspaceId: MAIN_WORKSPACE, limit: 500 })
        .map((hit) => hit.documentId)
    ).toEqual([chapterId(872)]);

    // Rebuilding from snapshots reproduces the trigger-maintained index exactly.
    const before = world.fts.search({ query: 'beacon', workspaceId: MAIN_WORKSPACE, limit: 20 });
    world.fts.rebuildIndex();
    expect(countRows(sharedDb, 'SELECT COUNT(*) AS count FROM documents_fts')).toBe(
      world.documentCount + control.documentCount
    );
    expect(
      world.fts.search({ query: 'beacon', workspaceId: MAIN_WORKSPACE, limit: 20 }).map((hit) => hit.documentId)
    ).toEqual(before.map((hit) => hit.documentId));
  });

  it('resolves L2 neighbourhoods and L3 keyword limits out of 1000 chapters', async () => {
    const retriever = new JitMemoryRetriever({
      repository: world.repo,
      ftsEngine: world.fts,
      formatContext: formatJitContextAsPrompt
    });
    const currentDocumentId = chapterId(600);
    const result = await retriever.retrieve({
      workspaceId: MAIN_WORKSPACE,
      currentDocumentId,
      currentText: 'The beacon and the lantern stay lit.',
      keywords: ['beacon', 'lantern', 'cartographer labyrinthine'],
      maxSummaryDocuments: 3,
      maxFtsResults: 2
    });

    // L2 must be the three immediately preceding chapters by order, not an arbitrary slice.
    expect(result.l2RecentSummaries.map((item) => item.documentId)).toEqual([
      chapterId(597),
      chapterId(598),
      chapterId(599)
    ]);
    expect(result.l2RecentSummaries.every((item) => item.summary.length > 0)).toBe(true);

    // L3 is capped per keyword, de-duplicated across keywords, and never echoes the draft itself.
    expect(result.l3GlobalLore.length).toBeGreaterThan(0);
    expect(result.l3GlobalLore.length).toBeLessThanOrEqual(6);
    const loreIds = new Set(result.l3GlobalLore.map((item) => item.documentId));
    expect(loreIds.size).toBe(result.l3GlobalLore.length);
    expect(loreIds.has(currentDocumentId)).toBe(false);
    for (const item of result.l3GlobalLore) {
      expect(world.repo.getDocument(item.documentId)?.workspaceId).toBe(MAIN_WORKSPACE);
    }

    expect(result.assembledPromptBlock).toContain('Chapter 0597');
    expect(result.assembledPromptBlock).toContain('=== Full-Text Matches ===');

    // Isolation: scoped retrieval cannot reach into the 1000-chapter corpus.
    const isolated = await retriever.retrieve({
      workspaceId: CONTROL_WORKSPACE,
      currentText: 'kaleidoscope obsidian',
      keywords: ['kaleidoscope obsidian'],
      maxSummaryDocuments: 5,
      maxFtsResults: 5
    });
    expect(isolated.l3GlobalLore.map((item) => item.documentId)).toEqual([chapterId(2, CONTROL_WORKSPACE)]);
    for (const item of isolated.l2RecentSummaries) {
      expect(item.documentId.startsWith(CONTROL_WORKSPACE)).toBe(true);
    }
  });

  it('compiles 1200 context fragments with a priority-correct cut inside the token budget', async () => {
    const provider = new BulkFragmentProvider(1200, 50);
    const pipeline = new ContextPipeline({ maxTokens: 2000 });
    pipeline.register(provider);

    const packet = await pipeline.build(bulkTask());
    expect(packet.truncated).toBe(true);
    expect(packet.fragments.length).toBeGreaterThan(4);
    expect(packet.fragments.length).toBeLessThan(1200);
    // The greedy fill slices the fragment that straddles the limit, so a budget this tight is
    // saturated exactly rather than left with a fragment's worth of slack.
    expect(packet.tokenEstimate).toBe(2000);

    // The compiler keeps the highest-scoring fragments, independent of arrival order.
    const fragments = provider.provide();
    const priorities = new Map<string, number>();
    for (const fragment of fragments) priorities.set(fragment.id, fragment.priority ?? 0);
    const acceptedIds = new Set(packet.fragments.map((fragment) => fragment.id));
    const acceptedPriorities: number[] = [];
    const rejectedPriorities: number[] = [];
    for (const [id, priority] of priorities) {
      (acceptedIds.has(id) ? acceptedPriorities : rejectedPriorities).push(priority);
    }
    expect(acceptedPriorities.length).toBeGreaterThan(4);
    expect(rejectedPriorities.length).toBeGreaterThan(4);
    expect(Math.min(...acceptedPriorities)).toBeGreaterThan(Math.max(...rejectedPriorities));

    // Deterministic: the same task recompiled from scratch yields an identical packet.
    pipeline.clearCache();
    const replay = await pipeline.build(bulkTask());
    expect(replay.fingerprint).toBe(packet.fingerprint);
    expect(replay.fragments.map((fragment) => fragment.id)).toEqual(packet.fragments.map((fragment) => fragment.id));

    // maxFragments truncates on top of the token budget.
    const capped = await pipeline.build(
      bulkTask({ contextPolicy: { providerIds: ['scale.bulk-fragments'], maxTokens: 2000, maxFragments: 3 } })
    );
    expect(capped.fragments.length).toBe(3);
    expect(capped.truncated).toBe(true);
    pipeline.dispose();
  });

  it('serves repeated large compiles from cache instead of re-invoking providers', async () => {
    const provider = new BulkFragmentProvider(800, 40);
    const pipeline = new ContextPipeline({ maxTokens: 2000 });
    pipeline.register(provider);

    const first = await pipeline.build(bulkTask());
    const cached = await pipeline.build(bulkTask({ id: 'another-task-id' }));
    expect(provider.provideCalls).toBe(1);
    expect(cached.fingerprint).toBe(first.fingerprint);
    expect(pipeline.cacheStats()).toMatchObject({ hits: 1, misses: 1 });

    // Identical content for another workspace must not reuse the compiled packet.
    await pipeline.build(
      bulkTask({ id: 'other-workspace-task', scope: { workspaceId: 'ws-other', workspaceRevision: 1 } })
    );
    expect(provider.provideCalls).toBe(2);
    expect(pipeline.cacheStats()).toMatchObject({ hits: 1, misses: 2 });
    pipeline.dispose();
  });

  it('grows sub-quadratically from a 250- to a 1000-chapter workspace', async () => {
    const small = seedCorpus({ workspaceId: MAIN_WORKSPACE, documentCount: 250 });
    const large = seedCorpus({ workspaceId: MAIN_WORKSPACE, documentCount: 1000 });
    try {
      expect(large.totalChars / small.totalChars).toBeCloseTo(CORPUS_GROWTH_FACTOR, 1);

      const search = (corpus: Corpus) => () =>
        corpus.fts.search({ query: 'beacon', workspaceId: MAIN_WORKSPACE, limit: 20 });
      const smallSearchMs = await measureMs(3, 20, search(small));
      const largeSearchMs = await measureMs(3, 20, search(large));
      const searchRatio = growthRatio(smallSearchMs, largeSearchMs);
      expect(large.fts.search({ query: 'beacon', workspaceId: MAIN_WORKSPACE, limit: 20 }).length).toBe(20);
      expect(searchRatio).toBeLessThanOrEqual(INDEXED_GROWTH_CEILING);

      const retrieve = (corpus: Corpus, currentDocumentId: string) => {
        const retriever = new JitMemoryRetriever({ repository: corpus.repo, ftsEngine: corpus.fts });
        return () =>
          retriever.retrieve({
            workspaceId: MAIN_WORKSPACE,
            currentDocumentId,
            currentText: 'The beacon and the lantern stay lit.',
            keywords: ['beacon', 'lantern', 'ember', 'harbor', 'quill'],
            maxSummaryDocuments: 3,
            maxFtsResults: 2
          });
      };
      const smallJitMs = await measureMs(3, 4, retrieve(small, chapterId(200)));
      const largeJitMs = await measureMs(3, 4, retrieve(large, chapterId(200)));
      const jitRatio = growthRatio(smallJitMs, largeJitMs);
      expect(jitRatio).toBeLessThanOrEqual(LINEAR_GROWTH_CEILING);

      console.log(
        `P7 baseline @ ${CORPUS_GROWTH_FACTOR}x corpus: fts ${smallSearchMs.toFixed(1)}ms -> ${largeSearchMs.toFixed(1)}ms ` +
          `(x${searchRatio.toFixed(2)} of ceiling ${INDEXED_GROWTH_CEILING}), jit ${smallJitMs.toFixed(1)}ms -> ` +
          `${largeJitMs.toFixed(1)}ms (x${jitRatio.toFixed(2)} of ceiling ${LINEAR_GROWTH_CEILING})`
      );
    } finally {
      small.db.close();
      large.db.close();
    }
  });

  it('compiles context linearly as the fragment count grows', async () => {
    const small = await compileBulk(300);
    const large = await compileBulk(1200);
    const ratio = growthRatio(small.ms, large.ms);

    // Every fragment plus the task-input fragment is retained at this budget.
    expect(small.packet.fragments.length).toBe(301);
    expect(large.packet.fragments.length).toBe(1201);
    expect(large.packet.truncated).toBe(false);
    // A quadratic sort or fingerprint pass would cost 16x here.
    expect(ratio).toBeLessThanOrEqual(LINEAR_GROWTH_CEILING);

    console.log(
      `P7 compile baseline: 300 fragments ${small.ms.toFixed(1)}ms -> 1200 fragments ${large.ms.toFixed(1)}ms ` +
        `(x${ratio.toFixed(2)} of ceiling ${LINEAR_GROWTH_CEILING})`
    );
  });

  it('persists a manuscript linearly as the chapter count grows', async () => {
    const smallMs = await measureSeed(250);
    const largeMs = await measureSeed(1000);
    const ratio = growthRatio(smallMs, largeMs);
    expect(ratio).toBeLessThanOrEqual(LINEAR_GROWTH_CEILING);
    console.log(
      `P7 write baseline: 250 chapters ${smallMs.toFixed(1)}ms -> 1000 chapters ${largeMs.toFixed(1)}ms ` +
        `(x${ratio.toFixed(2)} of ceiling ${LINEAR_GROWTH_CEILING})`
    );
  });

  it('purges one large workspace completely without disturbing another', () => {
    const db = new InkDb(':memory:');
    try {
      const purgeable = seedCorpus({ db, workspaceId: 'ws-purge', documentCount: 300 });
      const kept = seedCorpus({ db, workspaceId: 'ws-keep', documentCount: 120 });
      expect(countRows(db, 'SELECT COUNT(*) AS count FROM documents_fts')).toBe(
        purgeable.documentCount + kept.documentCount
      );

      const purged = purgeable.repo.purgeWorkspace('ws-purge');
      expect(purged).toMatchObject({ documents: 300, folders: 2, documentSnapshots: 300 });
      expect(countRows(db, "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = 'ws-purge'")).toBe(0);
      expect(countRows(db, "SELECT COUNT(*) AS count FROM documents_fts WHERE document_id LIKE 'ws-purge%'")).toBe(0);

      // The surviving workspace is untouched and still fully searchable.
      expect(countRows(db, 'SELECT COUNT(*) AS count FROM documents_fts')).toBe(kept.documentCount);
      expect(kept.repo.getFolders('ws-keep').length).toBe(1);
      expect(kept.fts.search({ query: 'beacon', workspaceId: 'ws-keep', limit: 20 }).length).toBe(20);
      expect(kept.fts.search({ query: 'kaleidoscope obsidian', workspaceId: 'ws-keep' }).length).toBe(1);
    } finally {
      db.close();
    }
  });
});

async function measureSeed(documentCount: number): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 2; run += 1) {
    const started = performance.now();
    const corpus = seedCorpus({ workspaceId: MAIN_WORKSPACE, documentCount });
    best = Math.min(best, performance.now() - started);
    corpus.db.close();
  }
  return best;
}
