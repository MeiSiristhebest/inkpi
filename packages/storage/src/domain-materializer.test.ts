import { type DomainChange, type DomainChangeSet, calculateDomainChangeSetChecksum } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { InkDb } from './db.js';
import { DomainProjectionStore } from './domain-projection.js';

function makeChangeSet(
  id: string,
  workspaceId: string,
  baseRevision: number,
  changes: DomainChange[],
  createdAt = baseRevision + 1
): DomainChangeSet {
  const unsigned: Omit<DomainChangeSet, 'checksum'> = {
    id,
    workspaceId,
    sourceDeviceId: 'desktop-test',
    baseRevision,
    revision: baseRevision + 1,
    changes,
    createdAt
  };
  return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
}

function change(
  id: string,
  aggregateType: string,
  aggregateId: string,
  operation: 'upsert' | 'delete',
  payload: unknown,
  revision = 1,
  occurredAt = revision
): DomainChange {
  return { id, aggregateType, aggregateId, operation, payload, revision, occurredAt };
}

function count(db: InkDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

describe('daemon domain change materializer', () => {
  it('materializes Desktop and daemon field names into the derived read models', () => {
    const db = new InkDb();
    db.exec('PRAGMA foreign_keys = ON');
    const projection = new DomainProjectionStore(db, () => 100);

    const applied = projection.apply(
      makeChangeSet('set-1', 'project-1', 0, [
        change('chapter-change', 'chapter', 'chapter-1', 'upsert', {
          id: 'chapter-1',
          projectId: 'project-1',
          volumeId: 'volume-1',
          title: '第一章',
          content: '<p>正文</p>',
          wordCount: 42,
          order: 3,
          status: 'review',
          revision: 7,
          createdAt: 10,
          updatedAt: 11
        }),
        change('volume-change', 'volume', 'volume-1', 'upsert', {
          id: 'volume-1',
          projectId: 'project-1',
          title: '第一卷',
          order: 2,
          description: '卷摘要',
          createdAt: 8,
          updatedAt: 9
        }),
        change('project-change', 'project', 'project-1', 'upsert', {
          id: 'project-1',
          name: 'InkPi',
          genre: '玄幻',
          intro: '项目简介',
          cover: 'cover.png',
          projectType: 'full',
          features: ['timeline'],
          createdAt: 1,
          updatedAt: 2
        })
      ])
    );

    expect(applied).toMatchObject({ accepted: true, duplicate: false, revision: 1 });
    expect(db.prepare('SELECT * FROM workspaces WHERE id = ?').get('project-1')).toMatchObject({
      title: 'InkPi',
      category: '玄幻',
      synopsis: '项目简介',
      cover_image: 'cover.png',
      target_size: 0,
      owner: ''
    });
    expect(
      JSON.parse(
        String(
          (db.prepare('SELECT metadata FROM workspaces WHERE id = ?').get('project-1') as { metadata: string }).metadata
        )
      )
    ).toEqual({
      projectType: 'full',
      features: ['timeline']
    });
    expect(db.prepare('SELECT * FROM folders WHERE id = ?').get('volume-1')).toMatchObject({
      workspace_id: 'project-1',
      title: '第一卷',
      order_index: 2,
      summary: '卷摘要'
    });
    expect(db.prepare('SELECT * FROM documents WHERE id = ?').get('chapter-1')).toMatchObject({
      folder_id: 'volume-1',
      workspace_id: 'project-1',
      title: '第一章',
      order_index: 3,
      content_size: 42,
      status: 'review'
    });
    expect(db.prepare('SELECT * FROM document_snapshots WHERE document_id = ?').get('chapter-1')).toMatchObject({
      version: 7,
      content_markdown: '<p>正文</p>',
      content_size: 42,
      updated_at: 11
    });

    const protocolFields = makeChangeSet(
      'set-2',
      'project-1',
      1,
      [
        change(
          'document-change',
          'document',
          'chapter-1',
          'upsert',
          {
            id: 'chapter-1',
            workspaceId: 'project-1',
            folderId: 'volume-1',
            title: '第一章（修订）',
            orderIndex: 4,
            synopsis: '摘要',
            contentSize: 5,
            status: 'reviewing',
            contentJson: { type: 'doc' },
            contentMarkdown: '正文',
            version: 8,
            updatedAt: 12
          },
          8,
          12
        )
      ],
      12
    );
    projection.apply(protocolFields);
    expect(db.prepare('SELECT * FROM documents WHERE id = ?').get('chapter-1')).toMatchObject({
      title: '第一章（修订）',
      order_index: 4,
      synopsis: '摘要',
      content_size: 5,
      status: 'reviewing'
    });
    expect(db.prepare('SELECT * FROM document_snapshots WHERE document_id = ?').get('chapter-1')).toMatchObject({
      version: 8,
      content_json: JSON.stringify({ type: 'doc' }),
      content_markdown: '正文'
    });
    expect(projection.getGenericProjection('project-1', 'project', 'project-1')).toMatchObject({
      aggregateType: 'project',
      aggregateId: 'project-1',
      payload: { name: 'InkPi' }
    });
    db.close();
  });

  it('deletes dependents in foreign-key order for document, folder, and workspace deletes', () => {
    const db = new InkDb();
    db.exec('PRAGMA foreign_keys = ON');
    const projection = new DomainProjectionStore(db, () => 100);
    projection.apply(
      makeChangeSet('set-1', 'workspace-1', 0, [
        change('workspace-change', 'workspace', 'workspace-1', 'upsert', {
          id: 'workspace-1',
          title: 'W',
          owner: 'owner',
          createdAt: 1,
          updatedAt: 1
        }),
        change('folder-change', 'folder', 'folder-1', 'upsert', {
          id: 'folder-1',
          workspaceId: 'workspace-1',
          title: 'F',
          createdAt: 1,
          updatedAt: 1
        }),
        change('document-change', 'document', 'document-1', 'upsert', {
          id: 'document-1',
          workspaceId: 'workspace-1',
          folderId: 'folder-1',
          title: 'D',
          contentMarkdown: 'text',
          createdAt: 1,
          updatedAt: 1
        })
      ])
    );
    db.prepare(
      'INSERT INTO document_deltas (document_id, step_json, client_timestamp, created_at) VALUES (?, ?, ?, ?)'
    ).run('document-1', '{}', 1, 1);
    db.prepare('INSERT INTO lanes (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'lane-1',
      'workspace-1',
      'default',
      1,
      1
    );
    db.prepare(
      'INSERT INTO branch_tips (lane_id, document_id, head_snapshot_version, updated_at) VALUES (?, ?, ?, ?)'
    ).run('lane-1', 'document-1', 1, 1);

    projection.apply(
      makeChangeSet('set-2', 'workspace-1', 1, [
        change('document-delete', 'document', 'document-1', 'delete', undefined),
        change('folder-delete', 'folder', 'folder-1', 'delete', undefined),
        change('workspace-delete', 'workspace', 'workspace-1', 'delete', undefined)
      ])
    );

    expect(count(db, 'document_snapshots')).toBe(0);
    expect(count(db, 'document_deltas')).toBe(0);
    expect(count(db, 'branch_tips')).toBe(0);
    expect(count(db, 'documents')).toBe(0);
    expect(count(db, 'folders')).toBe(0);
    expect(count(db, 'lanes')).toBe(0);
    expect(count(db, 'workspaces')).toBe(0);
    db.close();
  });

  it('does not rematerialize a duplicate change set', () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db, () => 100);
    const set = makeChangeSet('set-1', 'workspace-1', 0, [
      change('workspace-change', 'workspace', 'workspace-1', 'upsert', {
        id: 'workspace-1',
        title: 'W',
        owner: 'owner',
        createdAt: 1,
        updatedAt: 1
      })
    ]);

    expect(projection.apply(set)).toMatchObject({ accepted: true, duplicate: false });
    expect(projection.apply(set)).toMatchObject({ accepted: true, duplicate: true });
    expect(count(db, 'domain_change_sets')).toBe(1);
    expect(count(db, 'workspaces')).toBe(1);
    db.close();
  });

  it('rebuilds generic and specialized derived rows from a restored authoritative snapshot', () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db, () => 100);
    const first = makeChangeSet('set-1', 'workspace-1', 0, [
      change('workspace-change', 'workspace', 'workspace-1', 'upsert', {
        id: 'workspace-1',
        title: 'Original',
        owner: 'owner',
        createdAt: 1,
        updatedAt: 1
      }),
      change('folder-change', 'folder', 'folder-1', 'upsert', {
        id: 'folder-1',
        workspaceId: 'workspace-1',
        title: 'Folder',
        createdAt: 1,
        updatedAt: 1
      }),
      change('document-change', 'document', 'document-1', 'upsert', {
        id: 'document-1',
        workspaceId: 'workspace-1',
        folderId: 'folder-1',
        title: 'Document',
        contentMarkdown: 'content',
        createdAt: 1,
        updatedAt: 1
      }),
      change('generic-change', 'story-state', 'state-1', 'upsert', {
        revision: 1,
        facts: [{ id: 'fact-1', value: 'stable' }]
      })
    ]);
    projection.apply(first);
    const snapshot = projection.createSnapshot('workspace-1');

    expect(projection.getGenericProjection('workspace-1', 'story-state', 'state-1')).toMatchObject({
      payload: { revision: 1, facts: [{ id: 'fact-1', value: 'stable' }] }
    });

    db.prepare('UPDATE workspaces SET title = ? WHERE id = ?').run('corrupt', 'workspace-1');
    db.prepare('DELETE FROM document_snapshots WHERE document_id = ?').run('document-1');
    db.prepare(
      'INSERT INTO folders (id, workspace_id, title, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('stale-folder', 'workspace-1', 'stale', 99, 1, 1);
    db.prepare('UPDATE domain_aggregate_projections SET payload_json = ? WHERE aggregate_id = ?').run(
      '{"corrupt":true}',
      'state-1'
    );
    expect(() => projection.getGenericProjection('workspace-1', 'story-state', 'state-1')).toThrow(
      'payload hash mismatch'
    );

    projection.restoreSnapshot(snapshot);
    expect(
      (db.prepare('SELECT title FROM workspaces WHERE id = ?').get('workspace-1') as { title: string }).title
    ).toBe('Original');
    expect(count(db, 'document_snapshots')).toBe(1);
    expect(count(db, 'folders')).toBe(1);
    expect(count(db, 'workspaces')).toBe(1);
    expect(projection.getGenericProjection('workspace-1', 'story-state', 'state-1')).toMatchObject({
      payload: { revision: 1, facts: [{ id: 'fact-1', value: 'stable' }] }
    });
    expect(projection.getCursor('workspace-1')).toMatchObject({ revision: 1, updatedAt: 100 });

    db.prepare('UPDATE workspaces SET title = ? WHERE id = ?').run('corrupt-again', 'workspace-1');
    projection.rebuild('workspace-1');
    expect(
      (db.prepare('SELECT title FROM workspaces WHERE id = ?').get('workspace-1') as { title: string }).title
    ).toBe('Original');
    expect(projection.getGenericProjection('workspace-1', 'story-state', 'state-1')).toMatchObject({
      payload: { revision: 1, facts: [{ id: 'fact-1', value: 'stable' }] }
    });
    db.close();
  });

  it('materializes unknown aggregates generically and deletes them idempotently', () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db, () => 100);
    const set = makeChangeSet('set-1', 'workspace-1', 0, [
      change('unknown-change', 'codexEntity', 'entity-1', 'upsert', { id: 'entity-1', name: 'Entity' }),
      change('unknown-delete', 'pluginSetting', 'setting-1', 'delete', undefined)
    ]);

    expect(projection.apply(set)).toMatchObject({ accepted: true, duplicate: false, revision: 1 });
    expect(projection.list('workspace-1')).toEqual([set]);
    expect(projection.getGenericProjection('workspace-1', 'codexEntity', 'entity-1')).toMatchObject({
      payload: { id: 'entity-1', name: 'Entity' },
      revision: 1,
      updatedAt: 1
    });
    expect(projection.listGenericProjections('workspace-1', 'codexEntity')).toHaveLength(1);
    expect(count(db, 'workspaces')).toBe(0);
    expect(count(db, 'folders')).toBe(0);
    expect(count(db, 'documents')).toBe(0);

    expect(projection.apply(set)).toMatchObject({ accepted: true, duplicate: true });
    expect(projection.listGenericProjections('workspace-1')).toHaveLength(1);

    const deleteSet = makeChangeSet('set-2', 'workspace-1', 1, [
      change('unknown-change-delete', 'codexEntity', 'entity-1', 'delete', undefined, 2, 2)
    ]);
    expect(projection.apply(deleteSet)).toMatchObject({ accepted: true, duplicate: false, revision: 2 });
    expect(projection.getGenericProjection('workspace-1', 'codexEntity', 'entity-1')).toBeUndefined();
    expect(projection.listGenericProjections('workspace-1')).toHaveLength(0);
    db.close();
  });

  it('does not materialize generic rows for rejected revisions or checksums', () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db, () => 100);
    const first = makeChangeSet('set-1', 'workspace-1', 0, [
      change('state-change', 'story-state', 'state-1', 'upsert', { value: 'first' })
    ]);
    projection.apply(first);

    const outOfOrder = makeChangeSet('set-3', 'workspace-1', 2, [
      change('state-change-later', 'story-state', 'state-1', 'upsert', { value: 'later' }, 3, 3)
    ]);
    expect(projection.apply(outOfOrder)).toMatchObject({
      accepted: false,
      reason: 'revision-conflict',
      revision: 1
    });
    expect(projection.getGenericProjection('workspace-1', 'story-state', 'state-1')?.payload).toEqual({
      value: 'first'
    });

    expect(() => projection.apply({ ...first, checksum: '00000000' })).toThrow('checksum mismatch');
    expect(projection.getGenericProjection('workspace-1', 'story-state', 'state-1')?.payload).toEqual({
      value: 'first'
    });
    db.close();
  });
});
