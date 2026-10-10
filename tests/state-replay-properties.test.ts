import {
  createInitialSessionState,
  messageFromSessionEntry,
  reduceAssistantFrames,
  reduceSession,
  reduceSessionEntry
} from '@inkpi/agent-core';
import {
  type DomainChange,
  type DomainChangeSet,
  type SessionEntry,
  calculateDomainChangeSetChecksum
} from '@inkpi/protocol';
import { DomainMaterializer, DomainProjectionStore, InkDb } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';
import { mergeRuntimeState } from '../packages/agent-core/src/pipeline/ledger-merge.js';

function entry(type: SessionEntry['type'], payload: any, seq = 1): SessionEntry {
  return { id: `e-${seq}`, sessionId: 'owned', type, payload, seq, parentId: null, timestamp: seq };
}
function changeset(workspaceId: string, revision: number, changes: DomainChange[]): DomainChangeSet {
  const unsigned = {
    id: `${workspaceId}-${revision}`,
    workspaceId,
    sourceDeviceId: 'property-test',
    baseRevision: revision - 1,
    revision,
    changes,
    createdAt: revision
  };
  return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
}
function random(seed: number) {
  let value = seed;
  return (limit: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % limit;
  };
}
function freeze(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (value instanceof Map) for (const item of value.values()) freeze(item);
  else for (const item of Object.values(value)) freeze(item);
  Object.freeze(value);
}

describe('state ownership and deterministic replay', () => {
  it('copies direct message and initial adapter input and shares untouched owned state branches', () => {
    const content = [{ type: 'text', text: 'original' }];
    const message = messageFromSessionEntry(entry('user_message', { content }));
    content[0].text = 'mutated';
    expect((message!.content as any)[0].text).toBe('original');
    const initial = { nested: { list: [1, 2] } };
    const state = createInitialSessionState('owned', { createInitialState: () => initial, merge: (base) => base });
    initial.nested.list.reverse();
    expect(state.runtimeState.nested.list).toEqual([1, 2]);
    const next = reduceSessionEntry(state, entry('user_message', 'text'));
    expect(next.runtimeState).toBe(state.runtimeState);
    const addition = { changed: { values: [3, 4] } };
    const merged = mergeRuntimeState(state.runtimeState, addition);
    addition.changed.values.reverse();
    expect(merged.changed).toEqual({ values: [3, 4] });
    expect(merged.nested).toBe(state.runtimeState.nested);
  });

  it('gives custom mutating adapters an isolated copy of prior state and patch', () => {
    const adapter = {
      createInitialState: () => ({ nested: { list: [1] } }),
      merge: (base: any, patch: any) => {
        base.nested.list.push(...patch.values);
        patch.values.reverse();
        return base;
      }
    };
    const prior = createInitialSessionState('owned', adapter);
    const input = entry('ledger_mutation', { statePatch: { values: [2, 3] } });
    freeze(prior);
    freeze(input);
    const next = reduceSessionEntry(prior, input, adapter);
    expect(next.runtimeState.nested.list).toEqual([1, 2, 3]);
    expect(prior.runtimeState.nested.list).toEqual([1]);
    expect(input.payload.statePatch.values).toEqual([2, 3]);
  });
  it.each(['user_message', 'assistant_frame', 'operation_intent', 'operation_settlement', 'ledger_mutation'] as const)(
    'owns the mutable %s payload at admission',
    (type) => {
      const nested = { items: [{ value: 'original' }] };
      const payloads = {
        user_message: { content: [{ type: 'text', text: 'original', nested }] },
        assistant_frame: {
          frame: {
            type: 'tool_call_end',
            index: 0,
            toolCall: { type: 'toolCall', id: 'c', name: 't', arguments: nested }
          }
        },
        operation_intent: { id: 'op', intent: nested },
        operation_settlement: { id: 'op', result: nested },
        ledger_mutation: { statePatch: nested }
      };
      const input = entry(type, payloads[type]);
      const state = reduceSessionEntry(createInitialSessionState('owned'), input);
      const captured = structuredClone(state);
      nested.items[0].value = 'mutated';
      expect(state).toEqual(captured);
    }
  );

  it('owns a settled frame tool call independently of the caller frame', () => {
    const toolCall = { type: 'toolCall' as const, id: 'c', name: 't', arguments: { list: [1, 2] } };
    const output = reduceAssistantFrames([
      { type: 'tool_call_start', index: 0, toolCallId: 'c', toolName: 't' },
      { type: 'tool_call_end', index: 0, toolCall }
    ]);
    toolCall.arguments.list.reverse();
    expect((output!.content[0] as any).arguments.list).toEqual([1, 2]);
  });

  it('preserves prior frozen states and matches full replay at randomly selected restart cuts', () => {
    for (const seed of [1, 29, 843, 9301]) {
      const pick = random(seed);
      const entries: SessionEntry[] = [];
      let state = createInitialSessionState('owned');
      for (let seq = 1; seq <= 100; seq++) {
        const kind = pick(5);
        const input =
          kind === 0
            ? entry('user_message', { content: `user-${seq}` }, seq)
            : kind === 1
              ? entry(
                  'agent_turn',
                  {
                    content: [{ type: 'text', text: `reply-${seq}` }],
                    usage: { inputTokens: seq, outputTokens: 1, totalTokens: seq + 1 }
                  },
                  seq
                )
              : kind === 2
                ? entry('operation_intent', { id: `op-${pick(8)}`, intent: { values: [seq] } }, seq)
                : kind === 3
                  ? entry('operation_settlement', { id: `op-${pick(8)}`, result: { values: [seq] } }, seq)
                  : entry(
                      'ledger_mutation',
                      { statePatch: { records: [{ id: `r-${pick(7)}`, nested: { seq } }] } },
                      seq
                    );
        const previous = structuredClone(state);
        const prior = state;
        freeze(state);
        freeze(input);
        state = reduceSessionEntry(state, input);
        expect(prior).toEqual(previous);
        expect(previous.currentLeafId).toBe(seq === 1 ? null : `e-${seq - 1}`);
        entries.push(input);
      }
      const cut = 1 + pick(entries.length - 1);
      expect(reduceSession(entries.slice(cut), reduceSession(entries.slice(0, cut)))).toEqual(reduceSession(entries));
      expect(state).toEqual(reduceSession(entries));
      expect(state.messages[0]).toBeDefined();
    }
  });
});

describe('domain JSON log replay', () => {
  it('reads legacy array logs and explicit undefined delete payloads without changing their checksum', () => {
    const db = new InkDb();
    try {
      const store = new DomainProjectionStore(db);
      const change: DomainChange = {
        id: 'legacy-change',
        aggregateType: 'custom',
        aggregateId: 'x',
        operation: 'delete',
        revision: 1,
        occurredAt: 1,
        payload: undefined
      };
      const input = changeset('legacy', 1, [change]);
      db.prepare(`INSERT INTO domain_change_sets
        (id,workspace_id,source_device_id,base_revision,revision,changes_json,checksum,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        input.id,
        input.workspaceId,
        input.sourceDeviceId,
        0,
        1,
        JSON.stringify([{ ...change, payload: { __inkpi_domain_projection_undefined__: true } }]),
        input.checksum,
        1
      );
      expect(store.list('legacy')).toStrictEqual([input]);
      store.restoreSnapshot({ workspaceId: 'legacy', revision: 1, changeSets: [input], createdAt: 1 });
      expect(store.list('legacy')).toStrictEqual([input]);
    } finally {
      db.close();
    }
  });

  it('round trips legitimate values that resemble the old undefined marker', () => {
    const db = new InkDb();
    try {
      const store = new DomainProjectionStore(db);
      const change: DomainChange = {
        id: 'change',
        aggregateType: 'custom',
        aggregateId: 'x',
        operation: 'upsert',
        revision: 1,
        occurredAt: 1,
        payload: { marker: { __inkpi_domain_projection_undefined__: true } }
      };
      const input = changeset('marker', 1, [change]);
      store.apply(input);
      expect(store.list('marker')).toEqual([input]);
      new DomainMaterializer(db).rebuild('marker');
      expect(store.getGenericProjection('marker', 'custom', 'x')?.payload).toEqual(change.payload);
      db.prepare('UPDATE domain_change_sets SET checksum = ? WHERE id = ?').run('', input.id);
      db.initSchema();
      expect(store.list('marker')).toEqual([input]);
      store.restoreSnapshot(store.createSnapshot('marker'));
      expect(store.getGenericProjection('marker', 'custom', 'x')?.payload).toEqual(change.payload);
    } finally {
      db.close();
    }
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(0),
    { value: undefined },
    [1, undefined],
    new Map([['x', 1]]),
    Object.assign([1, 2], { [Symbol('not-json')]: true })
  ])('rejects a non-JSON payload without committing projection or cursor (%s)', (payload) => {
    const db = new InkDb();
    try {
      const store = new DomainProjectionStore(db);
      const change: DomainChange = {
        id: 'change',
        aggregateType: 'custom',
        aggregateId: 'x',
        operation: 'upsert',
        revision: 1,
        occurredAt: 1,
        payload
      };
      expect(() => store.apply(changeset('invalid', 1, [change]))).toThrow(/JSON/);
      expect(store.getCursor('invalid').revision).toBe(0);
      expect(store.listGenericProjections('invalid')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('matches an independent array move/delete model across workspaces, snapshots and external mutation', () => {
    const db = new InkDb();
    try {
      const store = new DomainProjectionStore(db);
      const pick = random(725);
      const expected = new Map<string, Map<string, any>>([
        ['a', new Map()],
        ['b', new Map()]
      ]);
      const revisions = { a: 0, b: 0 };
      for (let step = 1; step <= 180; step++) {
        const workspace = pick(2) ? 'a' : 'b';
        const id = `record-${pick(8)}`;
        const records = expected.get(workspace)!;
        const revision = ++revisions[workspace];
        const deletion = pick(5) === 0;
        const payload = structuredClone(records.get(id) ?? { list: [1, 2, 3, 4], nested: { text: `seed-${step}` } });
        if (payload.list.length && pick(2)) payload.list.splice(pick(payload.list.length), 1);
        else {
          payload.list.push(step);
          payload.list.unshift(payload.list.pop());
        }
        const change: DomainChange = {
          id: `change-${step}`,
          aggregateType: 'custom',
          aggregateId: id,
          operation: deletion ? 'delete' : 'upsert',
          revision,
          occurredAt: step,
          ...(deletion ? {} : { payload })
        };
        const input = changeset(workspace, revision, [change]);
        expect(store.apply(input)).toMatchObject({ accepted: true });
        if (deletion) records.delete(id);
        else records.set(id, structuredClone(payload));
        const receipt = store.list(workspace).at(-1)!;
        payload.nested.text = 'outside mutation';
        expect(store.list(workspace).at(-1)).toEqual(receipt);
        if (step % 13 === 0) {
          const snapshot = store.createSnapshot(workspace);
          store.restoreSnapshot(snapshot);
          snapshot.changeSets.length = 0;
        }
        for (const [name, model] of expected) {
          const projections = store.listGenericProjections(name, 'custom');
          expect(new Map(projections.map((projection) => [projection.aggregateId, projection.payload]))).toEqual(model);
          if (projections.length) (projections[0].payload as any).nested.text = 'reader mutation';
        }
      }
    } finally {
      db.close();
    }
  });
});
