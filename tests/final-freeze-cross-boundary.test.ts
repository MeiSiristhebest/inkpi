import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactRuntime,
  ContextPipeline,
  DomainProposalLedger,
  InstructionRegistry,
  RuntimeCacheCoordinator,
  type ScheduledWork,
  TaskRegistry,
  TaskRouter,
  TaskScheduler
} from '@inkpi/agent-core';
import { AssistantEventStream } from '@inkpi/ai';
import type {
  AiTask,
  Artifact,
  DomainChange,
  DomainChangeSet,
  DomainProjectionSnapshot,
  InstructionDefinition,
  InstructionRegistryStatus,
  JitContextResult,
  ModelConfig,
  ProposalProjectionState,
  TaskResult
} from '@inkpi/protocol';
import { RUNTIME_ARTIFACT_TYPES, calculateDomainChangeSetChecksum } from '@inkpi/protocol';
import {
  InkPiDaemon,
  InkRpcClient,
  JitContextProvider,
  ProviderResponseCache,
  TaskModelHandler,
  createDaemonPersistence
} from '@inkpi/server';
import type { JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

const model: ModelConfig = {
  id: 'final-freeze-cross-boundary-model',
  name: 'Final freeze cross-boundary model',
  provider: 'faux'
};

interface PersistentRuntime {
  daemon: InkPiDaemon;
  client: InkRpcClient;
  persistence: ReturnType<typeof createDaemonPersistence>;
}

async function openPersistentRuntime(dbPath: string, withCache = false): Promise<PersistentRuntime> {
  const persistence = createDaemonPersistence({ dbPath });
  if (withCache && !persistence.cachePersistence) {
    throw new Error('Expected file-backed cache persistence for the cross-boundary test');
  }
  const daemon = new InkPiDaemon({
    host: '127.0.0.1',
    context: persistence.context,
    ...(withCache ? { cachePersistence: persistence.cachePersistence } : {})
  });
  await daemon.start(0, '127.0.0.1');
  const client = await InkRpcClient.connectTcp(daemon.getPort(), '127.0.0.1');
  return { daemon, client, persistence };
}

async function closePersistentRuntime(runtime: PersistentRuntime): Promise<void> {
  await runtime.client.close();
  await runtime.daemon.stop();
  runtime.persistence.close();
}

function makeChangeSet(
  id: string,
  workspaceId: string,
  baseRevision: number,
  revision: number,
  changes: DomainChange[],
  sourceDeviceId = 'desktop-final-freeze'
): DomainChangeSet {
  const unsigned = {
    id,
    workspaceId,
    sourceDeviceId,
    baseRevision,
    revision,
    changes,
    createdAt: revision * 10
  } satisfies Omit<DomainChangeSet, 'checksum'>;
  return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
}

function makeChange(
  id: string,
  aggregateType: string,
  aggregateId: string,
  revision: number,
  payload: unknown
): DomainChange {
  return {
    id,
    aggregateType,
    aggregateId,
    operation: 'upsert',
    revision,
    payload,
    occurredAt: revision * 10
  };
}

describe('Runtime final-freeze cross-boundary evidence', () => {
  it('persists StoryState provenance, ordered projections, proposals, and artifact lineage over TCP and restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-final-freeze-domain-'));
    const dbPath = join(root, 'state.sqlite');
    const first = await openPersistentRuntime(dbPath);
    let storySnapshot: DomainProjectionSnapshot | undefined;
    let childArtifact: Artifact | undefined;

    try {
      const storyWorkspace = 'final-freeze-story-workspace';
      const storyStateV1 = {
        revision: 1,
        entities: [
          {
            id: 'character:lyra',
            name: 'Lyra',
            factLevel: 'canonical-fact',
            provenance: {
              sourceDocumentId: 'chapter-1',
              sourceBlockId: 'block-2',
              sourceRevision: 7,
              sourceType: 'ai-extracted',
              confidence: 0.91
            }
          }
        ],
        relations: [
          {
            id: 'belief:lyra-beacon',
            from: 'character:lyra',
            to: 'entity:beacon',
            kind: 'believes',
            factLevel: 'character-belief',
            provenance: {
              sourceDocumentId: 'chapter-1',
              sourceBlockId: 'block-3',
              sourceRevision: 7,
              sourceType: 'ai-proposed',
              confidence: 0.62
            }
          }
        ],
        events: [],
        scenes: [],
        timelines: [],
        promises: [],
        constraints: []
      };
      const storyStateV2 = {
        ...storyStateV1,
        revision: 2,
        entities: storyStateV1.entities.map((entity) => ({ ...entity, name: 'Lyra of the North' }))
      };
      const storyRevision2 = makeChangeSet('story-change-2', storyWorkspace, 1, 2, [
        makeChange('story-state-2', 'story.state', 'story-1', 2, { storyState: storyStateV2 })
      ]);
      const storyRevision1 = makeChangeSet('story-change-1', storyWorkspace, 0, 1, [
        makeChange('story-state-1', 'story.state', 'story-1', 1, {
          storyState: storyStateV1,
          provenance: { sourceType: 'derived', sourceRevision: 7 }
        })
      ]);

      expect(await first.client.pushDomainChangeSet(storyRevision2)).toMatchObject({
        accepted: false,
        duplicate: false,
        revision: 0,
        reason: 'revision-conflict'
      });
      expect(await first.client.pushDomainChangeSet(storyRevision1)).toMatchObject({
        accepted: true,
        duplicate: false,
        revision: 1
      });
      expect(await first.client.pushDomainChangeSet(storyRevision1)).toMatchObject({
        accepted: true,
        duplicate: true,
        revision: 1
      });
      expect(await first.client.pushDomainChangeSet(storyRevision2)).toMatchObject({
        accepted: true,
        duplicate: false,
        revision: 2
      });

      expect(await first.client.pullDomainChangeSets(storyWorkspace)).toEqual([storyRevision1, storyRevision2]);
      storySnapshot = await first.client.snapshotDomain(storyWorkspace);
      expect(storySnapshot).toMatchObject({
        workspaceId: storyWorkspace,
        revision: 2,
        changeSets: [storyRevision1, storyRevision2]
      });
      expect(
        first.persistence.context.domainProjection?.getGenericProjection(storyWorkspace, 'story.state', 'story-1')
      ).toMatchObject({
        workspaceId: storyWorkspace,
        aggregateType: 'story.state',
        aggregateId: 'story-1',
        revision: 2,
        payload: { storyState: storyStateV2 }
      });

      const independentClient = await InkRpcClient.connectTcp(first.daemon.getPort(), '127.0.0.1');
      try {
        const raceWorkspace = 'final-freeze-race-workspace';
        const raceA = makeChangeSet(
          'race-a',
          raceWorkspace,
          0,
          1,
          [makeChange('race-change-a', 'story.state', 'race-story', 1, { source: 'a' })],
          'desktop-a'
        );
        const raceB = makeChangeSet(
          'race-b',
          raceWorkspace,
          0,
          1,
          [makeChange('race-change-b', 'story.state', 'race-story', 1, { source: 'b' })],
          'desktop-b'
        );
        const raceResults = await Promise.all([
          first.client.pushDomainChangeSet(raceA),
          independentClient.pushDomainChangeSet(raceB)
        ]);
        expect(raceResults.filter((result) => result.accepted)).toHaveLength(1);
        expect(raceResults.filter((result) => result.reason === 'revision-conflict')).toHaveLength(1);
      } finally {
        await independentClient.close();
      }

      const ledger = new DomainProposalLedger(() => 100);
      let domainRevision = 0;
      let proposalProjectionRevision = 0;
      const proposalWorkspace = 'final-freeze-proposal-workspace';
      const syncProposal = async (proposal: ProposalProjectionState): Promise<void> => {
        const pushed = await first.client.pushProposalState(proposalWorkspace, proposalProjectionRevision, proposal);
        expect(pushed).toMatchObject({ accepted: true, duplicate: false });
        proposalProjectionRevision = pushed.revision;
      };
      const proposal = ledger.create(
        {
          id: 'proposal-chain-1',
          taskId: 'task-chain-1',
          baseRevision: 0,
          sourceHash: 'story-hash-0',
          target: { type: 'story.document', id: 'chapter-1' },
          operation: 'update',
          patch: { text: 'new text' },
          evidence: [{ documentId: 'chapter-1', blockId: 'block-2', excerpt: 'old text' }]
        },
        100
      );
      await syncProposal(proposal);
      const accepted = ledger.accept(proposal.id);
      await syncProposal(accepted);

      const committed = await ledger.commit(
        proposal.id,
        domainRevision,
        async (patch, nextRevision) => {
          expect(patch).toEqual({ text: 'new text' });
          expect(nextRevision).toBe(1);
          const pushed = await first.client.pushDomainChangeSet(
            makeChangeSet('proposal-domain-1', proposalWorkspace, domainRevision, nextRevision, [
              makeChange('proposal-commit-1', 'story.document', 'chapter-1', nextRevision, patch)
            ])
          );
          expect(pushed).toMatchObject({ accepted: true, revision: nextRevision });
          domainRevision = pushed.revision;
          return { inversePatch: { text: 'old text' } };
        },
        'story-hash-0'
      );
      expect(committed).toMatchObject({ proposalId: proposal.id, revision: 1, inversePatch: { text: 'old text' } });
      await syncProposal(ledger.get(proposal.id)!);

      const undone = await ledger.undo(proposal.id, domainRevision, async (patch, nextRevision) => {
        const pushed = await first.client.pushDomainChangeSet(
          makeChangeSet('proposal-domain-2', proposalWorkspace, domainRevision, nextRevision, [
            makeChange('proposal-undo-1', 'story.document', 'chapter-1', nextRevision, patch)
          ])
        );
        expect(pushed).toMatchObject({ accepted: true, revision: nextRevision });
        domainRevision = pushed.revision;
      });
      expect(undone).toMatchObject({ proposalId: proposal.id, revision: 2, patch: { text: 'old text' } });
      await syncProposal(ledger.get(proposal.id)!);

      const modifyRecord = ledger.create(
        {
          id: 'proposal-modify',
          taskId: 'task-modify',
          baseRevision: 2,
          target: { type: 'story.document', id: 'chapter-1' },
          operation: 'update',
          patch: { text: 'draft' }
        },
        101
      );
      expect(ledger.modify(modifyRecord.id, { patch: { text: 'modified' }, reason: 'reviewed' })).toMatchObject({
        status: 'pending',
        patch: { text: 'modified' },
        reason: 'reviewed'
      });
      const stale = ledger.create(
        {
          id: 'proposal-stale',
          taskId: 'task-stale',
          baseRevision: 2,
          target: { type: 'story.document', id: 'chapter-1' },
          operation: 'update',
          patch: { text: 'stale' }
        },
        102
      );
      ledger.accept(stale.id);
      await expect(ledger.commit(stale.id, 3, () => ({ inversePatch: {} }))).rejects.toMatchObject({
        code: 'PROPOSAL_CONFLICT'
      });
      expect(ledger.get(stale.id)?.status).toBe('stale');
      expect(ledger.rebase(stale.id, 3, (patch) => ({ ...(patch as object), rebased: true })).status).toBe('pending');
      const rejected = ledger.create(
        {
          id: 'proposal-rejected',
          taskId: 'task-rejected',
          baseRevision: 2,
          target: { type: 'story.document', id: 'chapter-1' },
          operation: 'delete'
        },
        103
      );
      expect(ledger.reject(rejected.id).status).toBe('rejected');

      const parentArtifact: Artifact = {
        id: 'artifact:lineage-parent',
        type: RUNTIME_ARTIFACT_TYPES.chapterSummary,
        version: 1,
        content: { summary: 'parent' },
        provenance: { taskId: 'task-parent', sessionId: 'session-1' },
        createdAt: 200,
        updatedAt: 200
      };
      await expect(first.client.saveArtifact(parentArtifact)).resolves.toEqual({
        saved: true,
        id: parentArtifact.id
      });
      const artifactTask: AiTask = {
        id: 'artifact-lineage-task',
        kind: 'distillation.checkpoint',
        input: { documentId: 'chapter-1', selection: { documentId: 'chapter-1', from: 0, to: 9, revision: 2 } },
        outputContract: {
          format: 'structured',
          persistence: 'artifact',
          schemaId: RUNTIME_ARTIFACT_TYPES.distillationCheckpoint
        },
        metadata: {
          artifactType: RUNTIME_ARTIFACT_TYPES.distillationCheckpoint,
          parentArtifactId: parentArtifact.id,
          sessionId: 'session-1'
        }
      };
      const artifactResult: TaskResult = {
        taskId: artifactTask.id,
        kind: artifactTask.kind,
        status: 'completed',
        output: { format: 'structured', data: { checkpoint: 'chunk-2', facts: ['stable'] } },
        provenance: { executionRunId: 'run:artifact-lineage-task', sourceRevision: 2 }
      };
      childArtifact = await new ArtifactRuntime(first.persistence.context.artifactStore!, () => 201).persistTaskResult(
        artifactTask,
        artifactResult
      );
      expect(childArtifact).toMatchObject({
        id: 'artifact:artifact-lineage-task',
        type: RUNTIME_ARTIFACT_TYPES.distillationCheckpoint,
        provenance: {
          taskId: artifactTask.id,
          executionRunId: 'run:artifact-lineage-task',
          sessionId: 'session-1',
          parentArtifactId: parentArtifact.id,
          sourceRevision: 2
        }
      });
      expect(await first.client.getArtifact(childArtifact!.id)).toEqual(childArtifact);
      expect(await first.client.listArtifacts({ taskId: artifactTask.id })).toEqual([childArtifact]);
    } finally {
      await closePersistentRuntime(first);
    }

    const second = await openPersistentRuntime(dbPath);
    try {
      expect(await second.client.pullDomainChangeSets('final-freeze-story-workspace')).toEqual(
        storySnapshot?.changeSets
      );
      expect(
        second.persistence.context.domainProjection?.getGenericProjection(
          'final-freeze-story-workspace',
          'story.state',
          'story-1'
        )
      ).toMatchObject({ revision: 2 });
      expect(await second.client.snapshotProposals('final-freeze-proposal-workspace')).toMatchObject({
        revision: 4,
        proposals: [expect.objectContaining({ id: 'proposal-chain-1', status: 'undone' })]
      });
      expect(await second.client.getArtifact(childArtifact!.id)).toEqual(childArtifact);
      expect(await second.client.listArtifacts({ taskId: 'artifact-lineage-task' })).toEqual([childArtifact]);
    } finally {
      await closePersistentRuntime(second);
    }

    const restored = await openPersistentRuntime(join(root, 'restored.sqlite'));
    try {
      expect(storySnapshot).toBeDefined();
      expect(await restored.client.restoreDomainSnapshot(storySnapshot!)).toMatchObject({
        workspaceId: 'final-freeze-story-workspace',
        revision: 2
      });
      expect(await restored.client.pullDomainChangeSets('final-freeze-story-workspace')).toEqual(
        storySnapshot?.changeSets
      );
      expect(
        restored.persistence.context.domainProjection?.getGenericProjection(
          'final-freeze-story-workspace',
          'story.state',
          'story-1'
        )
      ).toMatchObject({ revision: 2 });
    } finally {
      await closePersistentRuntime(restored);
    }
  }, 30_000);

  it('restores all three cache layers and their statistics across a daemon restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-final-freeze-cache-'));
    const dbPath = join(root, 'state.sqlite');
    const first = await createCacheRuntime(dbPath, 'cached answer');

    try {
      const firstResult = await runCacheTask(first.client, makeCacheTask('cache-first', 1, 1024));
      expect(firstResult).toMatchObject({
        status: 'completed',
        output: { format: 'text', text: 'cached answer' },
        provenance: { providerCacheHit: false, projectRevision: 1 }
      });
      const secondResult = await runCacheTask(first.client, makeCacheTask('cache-second', 1, 2048));
      expect(secondResult).toMatchObject({
        status: 'completed',
        provenance: { providerCacheHit: true, projectRevision: 1 }
      });
      expect(first.calls).toEqual({ retrieval: 1, stream: 1 });
      expect(await first.client.getCacheStatus()).toMatchObject({
        version: 1,
        stats: {
          provider: { hits: 1, misses: 1 },
          context: { hits: 0, misses: 2 },
          retrieval: { hits: 1, misses: 1 }
        }
      });
    } finally {
      await closeCacheRuntime(first);
    }

    expect(existsSync(`${dbPath}.cache.json`)).toBe(true);
    const second = await createCacheRuntime(dbPath, 'must not call provider after restore');
    try {
      const contextHit = await runCacheTask(second.client, makeCacheTask('cache-context-hit', 1, 2048));
      expect(contextHit).toMatchObject({
        output: { format: 'text', text: 'cached answer' },
        provenance: { providerCacheHit: true }
      });
      const retrievalHit = await runCacheTask(second.client, makeCacheTask('cache-retrieval-hit', 1, 4096));
      expect(retrievalHit).toMatchObject({
        output: { format: 'text', text: 'cached answer' },
        provenance: { providerCacheHit: true }
      });
      expect(second.calls).toEqual({ retrieval: 0, stream: 0 });

      expect(await second.client.getCacheStatus()).toMatchObject({
        stats: {
          provider: { hits: 3, misses: 1 },
          context: { hits: 1, misses: 3 },
          retrieval: { hits: 2, misses: 1 }
        }
      });
      expect(await second.client.invalidateCache({ reason: 'revision', projectRevision: 2 })).toMatchObject({
        accepted: true,
        status: {
          stats: { provider: { invalidations: 1 }, context: { invalidations: 1 }, retrieval: { invalidations: 1 } }
        }
      });

      const revised = await runCacheTask(second.client, makeCacheTask('cache-revised', 2, 1024));
      expect(revised).toMatchObject({
        status: 'completed',
        output: { format: 'text', text: 'must not call provider after restore' },
        provenance: { providerCacheHit: false, projectRevision: 2 }
      });
      expect(second.calls).toEqual({ retrieval: 1, stream: 1 });
      expect(await second.client.getCacheStatus()).toMatchObject({
        stats: {
          provider: { hits: 3, misses: 2, invalidations: 1 },
          context: { hits: 1, misses: 4, invalidations: 1 },
          retrieval: { hits: 2, misses: 2, invalidations: 1 }
        }
      });
    } finally {
      await closeCacheRuntime(second);
    }
  }, 30_000);

  it('synchronizes domain and proposal projections between two persistent daemon instances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-final-freeze-devices-'));
    const deviceA = await openPersistentRuntime(join(root, 'device-a.sqlite'));
    const deviceB = await openPersistentRuntime(join(root, 'device-b.sqlite'));
    const workspaceId = 'final-freeze-cross-device-workspace';

    try {
      const revision1 = makeChangeSet(
        'cross-device-change-1',
        workspaceId,
        0,
        1,
        [makeChange('cross-device-state-1', 'story.state', 'cross-device-story', 1, { chapter: 1, title: 'Arrival' })],
        'device-a'
      );
      const revision2 = makeChangeSet(
        'cross-device-change-2',
        workspaceId,
        1,
        2,
        [
          makeChange('cross-device-state-2', 'story.state', 'cross-device-story', 2, { chapter: 2, title: 'Departure' })
        ],
        'device-b'
      );

      await expect(deviceA.client.pushDomainChangeSet(revision1)).resolves.toMatchObject({
        accepted: true,
        revision: 1
      });
      const snapshotA = await deviceA.client.snapshotDomain(workspaceId);
      await expect(deviceB.client.restoreDomainSnapshot(snapshotA)).resolves.toMatchObject({
        workspaceId,
        revision: 1
      });
      await expect(deviceB.client.pushDomainChangeSet(revision2)).resolves.toMatchObject({
        accepted: true,
        revision: 2
      });
      await expect(deviceA.client.pushDomainChangeSet(revision2)).resolves.toMatchObject({
        accepted: true,
        duplicate: false,
        revision: 2
      });
      await expect(deviceA.client.pushDomainChangeSet(revision2)).resolves.toMatchObject({
        accepted: true,
        duplicate: true,
        revision: 2
      });

      const proposal: ProposalProjectionState = {
        id: 'cross-device-proposal',
        taskId: 'cross-device-task',
        baseRevision: 2,
        target: { type: 'story.document', id: 'chapter-2' },
        operation: 'update',
        patch: { text: 'Synced draft' },
        status: 'pending',
        createdAt: 10,
        updatedAt: 10
      };
      await expect(deviceB.client.pushProposalState(workspaceId, 0, proposal)).resolves.toMatchObject({
        accepted: true,
        revision: 1
      });
      await expect(deviceA.client.pushProposalState(workspaceId, 0, proposal)).resolves.toMatchObject({
        accepted: true,
        revision: 1
      });

      const acceptedProposal = { ...proposal, status: 'accepted' as const, updatedAt: 11 };
      await expect(deviceB.client.pushProposalState(workspaceId, 1, acceptedProposal)).resolves.toMatchObject({
        accepted: true,
        revision: 2
      });
      await expect(deviceA.client.pushProposalState(workspaceId, 1, acceptedProposal)).resolves.toMatchObject({
        accepted: true,
        revision: 2
      });

      const finalA = await deviceA.client.snapshotDomain(workspaceId);
      const finalB = await deviceB.client.snapshotDomain(workspaceId);
      expect(finalA.revision).toBe(finalB.revision);
      expect(finalA.changeSets).toEqual(finalB.changeSets);
      expect(await deviceA.client.snapshotProposals(workspaceId)).toMatchObject({
        revision: 2,
        proposals: [acceptedProposal]
      });
      expect(await deviceB.client.snapshotProposals(workspaceId)).toMatchObject({
        revision: 2,
        proposals: [acceptedProposal]
      });
    } finally {
      await closePersistentRuntime(deviceA);
      await closePersistentRuntime(deviceB);
    }
  }, 30_000);

  it('completes the instruction handshake over TCP and recovers a SQLite scheduler lifecycle', async () => {
    const registry = new InstructionRegistry();
    const pipeline = new ContextPipeline();
    const taskRegistry = new TaskRegistry();
    const seenPrompts: string[] = [];
    const handler = new TaskModelHandler({
      model,
      stream: (_model, messages) => {
        seenPrompts.push(String(messages[0]?.content));
        return finalStream('instruction result');
      },
      defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true }
    });
    taskRegistry.register(handler);
    const router = new TaskRouter({
      registry: taskRegistry,
      contextPipeline: pipeline,
      instructionRegistry: registry
    });
    const daemon = new InkPiDaemon({
      host: '127.0.0.1',
      instructionRegistry: registry,
      context: { taskRouter: router }
    });
    await daemon.start(0, '127.0.0.1');
    const client = await InkRpcClient.connectTcp(daemon.getPort(), '127.0.0.1');
    const secondClient = await InkRpcClient.connectTcp(daemon.getPort(), '127.0.0.1');

    try {
      const definition: InstructionDefinition = {
        id: 'final.freeze.instruction:v1',
        version: '1',
        taskKind: 'final.freeze.instruction',
        systemInstruction: 'Use the stable final-freeze instruction.'
      };
      await expect(client.request('instruction.register', { instruction: definition })).resolves.toMatchObject({
        added: [definition.id]
      });
      const status = await secondClient.request<InstructionRegistryStatus>('instruction.status');
      expect(status).toMatchObject({
        ready: true,
        count: 1,
        instructionIds: [definition.id],
        instructions: [expect.objectContaining({ id: definition.id, version: definition.version })]
      });
      expect(JSON.stringify(status)).not.toContain(definition.systemInstruction);
      await expect(secondClient.request('instruction.list', { taskKind: definition.taskKind })).resolves.toEqual([
        expect.objectContaining({ id: definition.id, content: definition.systemInstruction })
      ]);

      const task: AiTask = {
        id: 'final-freeze-instruction-task',
        kind: definition.taskKind,
        input: { text: 'Current scene' },
        metadata: { instruction: 'This dynamic fallback must not be appended.' },
        outputContract: { format: 'text' }
      };
      await expect(client.submitTask(task)).resolves.toMatchObject({ taskId: task.id, status: 'queued' });
      await expect(client.waitForTask(task.id)).resolves.toMatchObject({
        status: 'completed',
        output: { format: 'text', text: 'instruction result' },
        provenance: {
          instructionIds: [definition.id],
          instructionVersion: expect.stringMatching(/^instructions-/)
        }
      });
      expect(seenPrompts[0]).toContain(`Stable skill instruction:\n${definition.systemInstruction}`);
      expect(seenPrompts[0]).not.toContain('This dynamic fallback must not be appended.');
    } finally {
      await client.close();
      await secondClient.close();
      await daemon.stop();
    }

    const root = mkdtempSync(join(tmpdir(), 'inkpi-final-freeze-scheduler-'));
    const dbPath = join(root, 'state.sqlite');
    const firstPersistence = createDaemonPersistence({ dbPath });
    const firstPersistenceAdapter = firstPersistence.context.schedulerPersistence;
    if (!firstPersistenceAdapter) throw new Error('Expected SQLite scheduler persistence');
    const firstEvents: string[] = [];
    let resolveCheckpoint!: () => void;
    const checkpointed = new Promise<void>((resolve) => {
      resolveCheckpoint = resolve;
    });
    const work: ScheduledWork<string> = {
      id: 'final-freeze-durable-scheduler',
      mode: 'foreground',
      run: async (signal, _reportProgress, reportCheckpoint, resumeFrom) => {
        if (resumeFrom) return `resumed:${resumeFrom.step}`;
        reportCheckpoint?.({ step: 'chapter-7', data: { offset: 12 }, updatedAt: 700 });
        resolveCheckpoint();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'interrupted';
      }
    };
    const firstScheduler = new TaskScheduler({
      persistence: firstPersistenceAdapter
    });
    firstScheduler.subscribe((event) => {
      firstEvents.push(event.type);
    });
    const initial = firstScheduler.schedule(work);
    try {
      await checkpointed;
      await firstScheduler.flush();
      expect(firstPersistenceAdapter.load(work.id)).toMatchObject({
        status: 'running',
        snapshot: { status: 'running', checkpoint: { step: 'chapter-7', data: { offset: 12 } } }
      });
      expect(firstScheduler.interrupt(work.id)).toBe(true);
      await expect(initial.promise).resolves.toBeUndefined();
      await firstScheduler.flush();
      expect(firstPersistenceAdapter.load(work.id)).toMatchObject({
        status: 'interrupted',
        snapshot: { status: 'interrupted', checkpoint: { step: 'chapter-7' } }
      });
      expect(firstEvents).toEqual(['created', 'queued', 'started', 'checkpointed', 'interrupted']);
      await firstScheduler.stop();
    } finally {
      await firstScheduler.stop();
      firstPersistence.close();
    }

    const secondPersistence = createDaemonPersistence({ dbPath });
    const secondPersistenceAdapter = secondPersistence.context.schedulerPersistence;
    if (!secondPersistenceAdapter) throw new Error('Expected SQLite scheduler persistence after restart');
    const secondEvents: string[] = [];
    const secondScheduler = new TaskScheduler({ persistence: secondPersistenceAdapter });
    secondScheduler.subscribe((event) => {
      secondEvents.push(event.type);
    });
    try {
      const restored = await secondScheduler.rehydrate(work);
      expect(restored).toBeDefined();
      expect(secondScheduler.status(work.id)).toMatchObject({
        status: 'interrupted',
        checkpoint: { step: 'chapter-7', data: { offset: 12 } }
      });
      const resumed = secondScheduler.resume<string>(work.id);
      await expect(resumed.promise).resolves.toBe('resumed:chapter-7');
      await secondScheduler.flush();
      expect(secondPersistenceAdapter.load(work.id)).toMatchObject({
        status: 'completed',
        snapshot: { status: 'completed' }
      });
      expect(secondEvents).toEqual(['queued', 'started', 'completed']);
    } finally {
      await secondScheduler.stop();
      secondPersistence.close();
    }
  }, 30_000);
});

interface CacheRuntime extends PersistentRuntime {
  calls: { retrieval: number; stream: number };
}

async function createCacheRuntime(dbPath: string, answer: string): Promise<CacheRuntime> {
  const persistence = createDaemonPersistence({ dbPath });
  if (!persistence.cachePersistence) throw new Error('Expected file-backed cache persistence');
  const coordinator = new RuntimeCacheCoordinator();
  const pipeline = new ContextPipeline({ cacheCoordinator: coordinator });
  const calls = { retrieval: 0, stream: 0 };
  const retriever = {
    retrieve: async () => {
      calls.retrieval += 1;
      return createJitResult();
    }
  } as unknown as JitMemoryRetriever;
  const retrievalProvider = new JitContextProvider(retriever, {
    cacheCoordinator: coordinator,
    cache: { now: () => 1_700_000_000_000, ttlMs: 60_000 }
  });
  pipeline.register(retrievalProvider);
  const providerCache = new ProviderResponseCache({
    cacheCoordinator: coordinator,
    now: () => 1_700_000_000_000,
    ttlMs: 60_000
  });
  const taskRegistry = new TaskRegistry();
  taskRegistry.register(
    new TaskModelHandler({
      model,
      providerResponseCache: providerCache,
      cacheCoordinator: coordinator,
      stream: () => {
        calls.stream += 1;
        return finalStream(answer);
      },
      defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true }
    })
  );
  const router = new TaskRouter({
    registry: taskRegistry,
    contextPipeline: pipeline,
    cacheCoordinator: coordinator
  });
  const daemon = new InkPiDaemon({
    host: '127.0.0.1',
    cacheCoordinator: coordinator,
    cachePersistence: persistence.cachePersistence,
    context: { ...persistence.context, taskRouter: router }
  });
  await daemon.start(0, '127.0.0.1');
  const client = await InkRpcClient.connectTcp(daemon.getPort(), '127.0.0.1');
  return { daemon, client, persistence, calls };
}

async function closeCacheRuntime(runtime: CacheRuntime): Promise<void> {
  await closePersistentRuntime(runtime);
}

function makeCacheTask(id: string, revision: number, maxTokens: number): AiTask {
  return {
    id,
    kind: 'final.freeze.cache',
    input: {
      documentId: 'final-freeze-document',
      selection: { documentId: 'final-freeze-document', from: 0, to: 4, revision },
      text: 'The final boundary remains stable.',
      payload: { workspaceId: 'final-freeze-cache-workspace', activeReferences: ['beacon'] }
    },
    contextPolicy: { providerIds: ['retrieval.jit'], maxTokens },
    outputContract: { format: 'text' }
  };
}

async function runCacheTask(client: InkRpcClient, task: AiTask): Promise<TaskResult> {
  await client.submitTask(task);
  return client.waitForTask(task.id);
}

function createJitResult(): JitContextResult {
  return {
    l1WorkingMemory: {
      activeLedger: { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] },
      activeReferences: ['beacon'],
      activeEntities: [],
      activeAssets: []
    },
    l2RecentSummaries: [
      {
        documentId: 'final-freeze-previous',
        title: 'Previous chapter',
        summary: 'The crew recovered the ancient beacon.'
      }
    ],
    l3GlobalLore: [],
    assembledPromptBlock: 'The crew recovered the ancient beacon.'
  };
}

function finalStream(text: string) {
  const stream = new AssistantEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'text_delta', textDelta: text });
    stream.end();
  });
  return stream;
}
