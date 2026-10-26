import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {IDBFactory, IDBObjectStore} from 'fake-indexeddb';
import {openRepository as openSqlite} from '../../src/platforms/electron/repository';
import {openRepository as openBrowser} from '../../src/platforms/browser/repository';
import type {MutationBatch, Entity} from '../../src/workbench/contracts/data';
import type {MigrationRepository} from '../../src/workbench/storage/repository';

const now = '2026-10-23T10:00:00.000Z';
const batch = (batchId = 'b', payload: any = {title: 'local'}, baseRevision: number | null = null): MutationBatch => ({batchId, mutations: [{operationId: `op-${batchId}`, deviceId: 'device', entityId: 'entry', moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, baseRevision, createdAt: now, updatedAt: now, action: 'put', payload}]});
const remote = (payload: any = {title: 'remote'}, revision = 1): Entity => ({id: 'entry', moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, revision, createdAt: now, updatedAt: now, deletedAt: null, payload});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
async function setup(kind: 'sqlite' | 'idb') {
  if (kind === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-v2-')); cleanup.push(() => rm(directory, {recursive: true, force: true}));
    return {open: async (account = 'a') => {const repo = await openSqlite(account, {directory}); cleanup.push(() => repo.close()); return repo;}, directory};
  }
  const indexedDB = new IDBFactory();
  return {open: async (account = 'a') => {const repo = await openBrowser(account, {indexedDB}); cleanup.push(() => repo.close()); return repo;}, indexedDB};
}

describe.each(['sqlite', 'idb'] as const)('%s persistent repository', kind => {
  it('reopens entities and outbox, isolates accounts and retries identical batches once', async () => {
    const env = await setup(kind); const r = await env.open();
    await expect(r.commit(batch())).resolves.toEqual({batchId: 'b', state: 'saved-local'});
    await r.commit(batch()); r.close(); const reopened = await env.open();
    expect((await reopened.get({moduleId: 'journal', entityId: 'entry'}))?.payload).toEqual({title: 'local'});
    expect(await reopened.pending()).toEqual([batch()]);
    expect(await (await env.open('b')).list('journal')).toEqual([]);
    await expect(reopened.commit(batch('b', {title: 'different'}))).rejects.toMatchObject({code: 'BATCH_MISMATCH'});
  });
  it('repository_commit_is_atomic', async () => {
    const env = await setup(kind); const r = await env.open();
    if (kind === 'sqlite') {
      const db = new DatabaseSync((r as any).path); cleanup.push(() => db.close());
      db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    } else {
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
        if (this.name === 'outbox') throw new DOMException('full', 'QuotaExceededError');
        return put.apply(this, args);
      });
    }
    await expect(r.commit(batch())).rejects.toBeDefined();
    expect(await r.list('journal')).toEqual([]); expect(await r.pending()).toEqual([]);
  });
  it('keeps pending overlay while applying remote changes and acknowledges without erasing newer work', async () => {
    const env = await setup(kind); const r = await env.open();
    await r.commit(batch());
    await r.apply({changes: [{cursor: 1, batchId: 'other', entities: [remote()]}], nextCursor: 1, hasMore: false});
    expect((await r.get({moduleId: 'journal', entityId: 'entry'}))?.payload).toEqual({title: 'local'});
    expect(await r.cursor()).toBe(1);
    await r.commit(batch('newer', {title: 'newer'}, 1));
    await r.accept({status: 'applied', change: {cursor: 2, batchId: 'b', entities: [remote({title: 'local'}, 2)]}});
    expect((await r.get({moduleId: 'journal', entityId: 'entry'}))?.payload).toEqual({title: 'newer'});
    expect((await r.pending()).map(b => b.batchId)).toEqual(['newer']);
    r.close(); const reopened = await env.open(); expect(await reopened.cursor()).toBe(1); // push must not skip unseen pull pages
  });
  it('preserves conflict copies until its replacement batch is acknowledged after reopening', async () => {
    const env = await setup(kind), r = await env.open(); await r.commit(batch());
    const conflict = {id: 'conflict', batch: batch(), local: [remote({title: 'local'}, 0)], remote: [remote()], reason: 'stale' as const};
    await r.accept({status: 'conflict', conflict});
    expect(await r.conflicts()).toEqual([conflict]); expect(await r.pending()).toEqual([]);
    await r.commitResolution('conflict', batch('resolution', {title: 'merged'}, 1));
    expect(await r.conflicts()).toEqual([conflict]); expect((await r.pending())[0].batchId).toBe('resolution');
    r.close(); const reopened = await env.open();
    expect(await reopened.conflicts()).toEqual([conflict]); expect((await reopened.pending())[0].batchId).toBe('resolution');
    await reopened.accept({status: 'applied', change: {cursor: 2, batchId: 'resolution', entities: [remote({title: 'merged'}, 2)]}});
    expect(await reopened.conflicts()).toEqual([]); expect(await reopened.pending()).toEqual([]);
  });
  it('keeps a pulled tombstone visible and retains the older pending edit through reopening', async () => {
    const env = await setup(kind), r = await env.open();
    await r.apply({changes: [{cursor: 1, batchId: 'initial', entities: [remote()]}], nextCursor: 1, hasMore: false});
    const edit = batch('offline-edit', {title: 'unsynced evidence'}, 1); await r.commit(edit);
    const tombstone = {...remote(null, 2), deletedAt: now};
    await r.apply({changes: [{cursor: 2, batchId: 'deleted-elsewhere', entities: [tombstone]}], nextCursor: 2, hasMore: false});
    expect(await r.get({moduleId: 'journal', entityId: 'entry'})).toEqual(tombstone);
    expect(await r.pending()).toEqual([edit]);
    r.close(); const reopened = await env.open();
    expect(await reopened.get({moduleId: 'journal', entityId: 'entry'})).toEqual(tombstone);
    expect(await reopened.pending()).toEqual([edit]);
    await reopened.accept({status: 'conflict', conflict: {id: 'deleted-conflict', batch: edit, local: [remote({title: 'unsynced evidence'}, 1)], remote: [tombstone], reason: 'deleted'}});
    expect(await reopened.conflicts()).toMatchObject([{reason: 'deleted', local: [{payload: {title: 'unsynced evidence'}}], remote: [tombstone]}]);
    expect(await reopened.get({moduleId: 'journal', entityId: 'entry'})).toEqual(tombstone);
  });
  it('retains the original alternatives when a replacement fails or conflicts again', async () => {
    const env = await setup(kind), r = await env.open(); await r.commit(batch());
    const original = {id: 'original-conflict', batch: batch(), local: [remote({title: 'original local'}, 0)], remote: [remote()], reason: 'stale' as const};
    await r.accept({status: 'conflict', conflict: original});
    const replacement = batch('replacement', {title: 'proposed merge'}, 1);
    await r.commitResolution(original.id, replacement); await r.recordFailure(replacement.batchId, 'auth');
    const unsupported = batch('unsupported-resolution', {title: 'lossy'}, 1); unsupported.mutations[0].schemaVersion = 99;
    await expect(r.commitResolution(original.id, unsupported)).rejects.toMatchObject({code: 'readonly-schema'});
    r.close(); const reopened = await env.open();
    expect(await reopened.conflicts()).toEqual([original]); expect(await reopened.pending()).toEqual([replacement]);
    const rejected = {id: 'replacement-conflict', batch: replacement, local: [remote({title: 'proposed merge'}, 1)], remote: [remote({title: 'new remote'}, 2)], reason: 'stale' as const};
    await reopened.accept({status: 'conflict', conflict: rejected});
    expect(await reopened.conflicts()).toEqual(expect.arrayContaining([original, rejected])); expect(await reopened.pending()).toEqual([]);
    reopened.close(); expect(await (await env.open()).conflicts()).toEqual(expect.arrayContaining([original, rejected]));
  });
  it('rolls back conflict removal, replacement acknowledgment and entities if acknowledgment persistence fails', async () => {
    const env = await setup(kind), r = await env.open(); await r.commit(batch());
    const original = {id: 'original-conflict', batch: batch(), local: [remote({title: 'original local'}, 0)], remote: [remote()], reason: 'stale' as const};
    await r.accept({status: 'conflict', conflict: original}); const replacement = batch('replacement', {title: 'proposed merge'}, 1); await r.commitResolution(original.id, replacement);
    if (kind === 'sqlite') {
      const db = new DatabaseSync((r as any).path); cleanup.push(() => db.close());
      db.exec("CREATE TRIGGER fail_conflict_removal BEFORE DELETE ON conflicts BEGIN SELECT RAISE(ABORT, 'full'); END");
    } else {
      const remove = IDBObjectStore.prototype.delete;
      vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof remove>) {
        if (this.name === 'conflicts') throw new DOMException('full', 'QuotaExceededError'); return remove.apply(this, args);
      });
    }
    await expect(r.accept({status: 'applied', change: {cursor: 2, batchId: replacement.batchId, entities: [remote({title: 'proposed merge'}, 2)]}})).rejects.toBeDefined();
    expect(await r.conflicts()).toEqual([original]); expect(await r.pending()).toEqual([replacement]);
    expect((await r.get({moduleId: 'journal', entityId: 'entry'}))?.revision).toBe(1);
  });
  it('retains visible payload in a local create followed by delete before any server revision', async () => {
    const env = await setup(kind), r = await env.open(); await r.commit(batch('create', {title: 'local trash label', nested: {evidence: 'preserved'}}));
    const deletion = batch('delete'); deletion.mutations[0].action = 'delete'; deletion.mutations[0].payload = null; await r.commit(deletion);
    const expected = {revision: 0, deletedAt: now, payload: {title: 'local trash label', nested: {evidence: 'preserved'}}};
    expect(await r.get({moduleId: 'journal', entityId: 'entry'})).toMatchObject(expected);
    expect((await r.pending())[1]).toEqual(deletion);
    r.close(); const reopened = await env.open(); expect(await reopened.get({moduleId: 'journal', entityId: 'entry'})).toMatchObject(expected); expect((await reopened.pending())[1].mutations[0].payload).toBeNull();
  });
  it.each([{title: 'edited trash label'}, null])('retains the latest visible payload %o through a confirmed edit followed by pending deletion', async payload => {
    const env = await setup(kind), r = await env.open();
    await r.apply({changes: [{cursor: 1, batchId: 'initial', entities: [remote({title: 'confirmed title'}, 1)]}], nextCursor: 1, hasMore: false});
    await r.commit(batch('edit', payload, 1));
    const deletion = batch('delete', null, 1); deletion.mutations[0].action = 'delete'; await r.commit(deletion);
    const expected = {revision: 1, deletedAt: now, payload};
    expect(await r.get({moduleId: 'journal', entityId: 'entry'})).toMatchObject(expected);
    expect((await r.pending())[1]).toEqual(deletion);
    r.close(); const reopened = await env.open(); expect(await reopened.get({moduleId: 'journal', entityId: 'entry'})).toMatchObject(expected); expect((await reopened.pending())[1].mutations[0].payload).toBeNull();
  });
  it('retains unknown fields and rejects a down-version overwrite', async () => {
    const r = await (await setup(kind)).open();
    await r.apply({changes: [{cursor: 1, batchId: 'future', entities: [{...remote({newField: {retained: true}}), schemaVersion: 7}]}], nextCursor: 1, hasMore: false});
    await expect(r.commit(batch('old', {title: 'lossy'}, 1))).rejects.toMatchObject({code: 'readonly-schema'});
    expect((await r.list('journal'))[0].payload).toEqual({newField: {retained: true}});
  });
  it('rejects malformed and partially repeated operations atomically', async () => {
    const r = await (await setup(kind)).open(); await r.commit(batch());
    const reused = batch('other'); reused.mutations[0].operationId = 'op-b';
    await expect(r.commit(reused)).rejects.toMatchObject({code: 'BATCH_MISMATCH'});
    await expect(r.commit({...batch('empty'), mutations: []})).rejects.toMatchObject({code: 'invalid'});
    expect((await r.pending()).length).toBe(1);
  });
});

it('captures immutable input before an IndexedDB transaction waits for its turn', async () => {
  const env = await setup('idb'), r = await env.open(); const input = batch();
  const saving = r.commit(input); (input.mutations[0].payload as any).title = 'changed after call';
  await saving;
  expect((await r.get({moduleId: 'journal', entityId: 'entry'}))?.payload).toEqual({title: 'local'});
});
it('IndexedDB abort after successful puts never produces a saved receipt or surviving entities', async () => {
  const r = await (await setup('idb')).open(), put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
    const request = put.apply(this, args);
    if (this.name === 'outbox') request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  await expect(r.commit(batch())).rejects.toBeDefined(); expect(await r.list('journal')).toEqual([]); expect(await r.pending()).toEqual([]);
});
it('browser future container is readable, rejects writes and preserves the database version', async () => {
  const indexedDB = new IDBFactory(); const r = await openBrowser('a', {indexedDB}); const name = r.name; r.close();
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {const q = indexedDB.open(name, 9); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);});
  upgraded.close(); const future = await openBrowser('a', {indexedDB}); cleanup.push(() => future.close());
  expect(future.readonly).toBe(true); expect(await future.list('journal')).toEqual([]);
  await expect(future.commit(batch())).rejects.toMatchObject({code: 'readonly-schema'});
});
it('a failing pull page atomically preserves earlier entities and cursor', async () => {
  const r = await (await setup('sqlite')).open();
  await expect(r.apply({changes: [{cursor: 1, batchId: 'first', entities: [remote()]}, {cursor: 2, batchId: 'bad', entities: [{...remote(), revision: 0}]}], nextCursor: 2, hasMore: false})).rejects.toMatchObject({code: 'invalid'});
  expect(await r.list('journal')).toEqual([]); expect(await r.cursor()).toBe(0);
});
it('rejects outbox replacement of a future schema even if it repeats that unknown version', async () => {
  const r = await (await setup('sqlite')).open();
  await r.apply({changes: [{cursor: 1, batchId: 'future', entities: [{...remote(), schemaVersion: 7}]}], nextCursor: 1, hasMore: false});
  const edit = batch('future-edit', {lossy: true}, 1); edit.mutations[0].schemaVersion = 7;
  await expect(r.commit(edit)).rejects.toMatchObject({code: 'readonly-schema'});
});
it('a pulled future schema remains visible intact while older local work waits for conflict handling', async () => {
  const r = await (await setup('idb')).open(); await r.commit(batch());
  await r.apply({changes: [{cursor: 1, batchId: 'future', entities: [{...remote({futureOnly: 'retained'}), schemaVersion: 7}]}], nextCursor: 1, hasMore: false});
  expect(await r.get({moduleId: 'journal', entityId: 'entry'})).toMatchObject({schemaVersion: 7, payload: {futureOnly: 'retained'}});
  expect(await r.pending()).toEqual([batch()]);
});
it('allows a module to opt in to its own declared newer schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'declared-schema-')); cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const r = await openSqlite('a', {directory, schemas: {journal: {'journal.entry': 3}}}); cleanup.push(() => r.close());
  const input = batch(); input.mutations[0].schemaVersion = 3; await r.commit(input);
  expect((await r.list('journal'))[0].schemaVersion).toBe(3);
});
describe.each(['sqlite', 'idb'] as const)('%s installation identity', kind => {
  it('persists a generated UUID across reopening and isolates a different account', async () => {
    const env = await setup(kind), first = await env.open(), deviceId = first.deviceId;
    expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    first.close(); expect((await env.open()).deviceId).toBe(deviceId); expect((await env.open('b')).deviceId).not.toBe(deviceId);
  });
});
it('rejects malformed or changed supplied identity instead of rebinding saved operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-')); cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const deviceId = '11111111-1111-4111-8111-111111111111';
  await expect(openSqlite('a', {directory, deviceId: 'not-a-uuid'})).rejects.toMatchObject({code: 'invalid'});
  const r = await openSqlite('a', {directory, deviceId}); cleanup.push(() => r.close()); expect(r.deviceId).toBe(deviceId);
  await expect(openSqlite('a', {directory, deviceId: '22222222-2222-4222-8222-222222222222'})).rejects.toMatchObject({code: 'device-mismatch'});
});
it('rejects sparse arrays instead of changing missing values into null during persistence', async () => {
  const r = await (await setup('sqlite')).open();
  await expect(r.commit(batch('sparse', new Array(2)))).rejects.toMatchObject({code: 'invalid'});
  expect(await r.pending()).toEqual([]);
});

describe.each(['sqlite','idb'] as const)('%s causal synchronization protocol',kind=>{
 it('persists direct predecessor rebasing and freezes attempts while preserving original receipt',async()=>{
  const env=await setup(kind),r=await env.open(),first=batch('first'),second=batch('second',{title:'successor'});await r.commit(first);await r.commit(second);expect((await r.queue()).map(x=>x.blocked)).toEqual([false,true]);await r.prepare(first.batchId);await r.accept({status:'applied',change:{cursor:1,batchId:first.batchId,entities:[remote({title:'local'},1)]}});const wire=await r.prepare(second.batchId);expect(wire.mutations[0].baseRevision).toBe(1);await r.commit(second);r.close();const reopened=await env.open();expect((await reopened.queue())[0]).toMatchObject({attempted:true,blocked:false,batch:wire});await reopened.apply({changes:[{cursor:1,batchId:'remote',entities:[remote({title:'intervening'},2)]}],nextCursor:1,hasMore:false});expect(await reopened.prepare(second.batchId)).toEqual(wire);
 });
 it('explicit remote acceptance unblocks independent entities and does not enqueue overwrite',async()=>{
  const env=await setup(kind),r=await env.open();await r.commit(batch('original'));await r.commit(batch('later',{title:'later'}));const independent=batch('independent');independent.mutations[0].entityId='other';await r.commit(independent);const conflict={id:'conflict',batch:batch('original'),local:[remote({title:'local'},0)],remote:[remote()],reason:'stale' as const};await r.accept({status:'conflict',conflict});expect((await r.queue()).map(x=>x.blocked)).toEqual([true,false]);await r.resolveRemote(conflict.id);expect(await r.conflicts()).toEqual([]);expect(await r.pending()).toEqual([independent]);expect((await r.get({moduleId:'journal',entityId:'entry'}))?.payload).toEqual({title:'remote'});r.close();expect(await (await env.open()).conflicts()).toEqual([]);
 });
 it('remote acceptance refuses to discard unrelated records in one atomic dependent action',async()=>{
  const env=await setup(kind),r=await env.open();await r.commit(batch('original'));const mixed=batch('mixed');mixed.mutations.push({...mixed.mutations[0],entityId:'unrelated',operationId:'unrelated-op'});await r.commit(mixed);const conflict={id:'conflict',batch:batch('original'),local:[remote({title:'local'},0)],remote:[remote()],reason:'stale' as const};await r.accept({status:'conflict',conflict});await expect(r.resolveRemote(conflict.id)).rejects.toMatchObject({code:'mixed-dependent-batch'});expect(await r.conflicts()).toEqual([conflict]);expect(await r.pending()).toEqual([mixed]);
 });
});
it('explicit remote choice cancels an unsent copy resolution rather than uploading it afterward',async()=>{
 const r=await(await setup('sqlite')).open();await r.commit(batch());const conflict={id:'copy-conflict',batch:batch(),local:[remote({title:'local'},0)],remote:[remote()],reason:'stale' as const};await r.accept({status:'conflict',conflict});const replacement=batch('copy-resolution');replacement.mutations[0].entityId='copy-id';await r.commitResolution(conflict.id,replacement);await r.resolveRemote(conflict.id);expect(await r.pending()).toEqual([]);expect(await r.get({moduleId:'journal',entityId:'copy-id'})).toBeNull();
});
it('does not accept a second independent replacement while a conflict resolution is pending',async()=>{
 const r=await(await setup('idb')).open();await r.commit(batch());const conflict={id:'copy-conflict',batch:batch(),local:[remote({title:'local'},0)],remote:[remote()],reason:'stale' as const};await r.accept({status:'conflict',conflict});const first=batch('first-copy');first.mutations[0].entityId='copy-one';await r.commitResolution(conflict.id,first);const second=batch('second-copy');second.mutations[0].entityId='copy-two';await expect(r.commitResolution(conflict.id,second)).rejects.toMatchObject({code:'resolution-in-flight'});expect(await r.pending()).toEqual([first]);
});
describe.each(['sqlite','idb'] as const)('%s superseded conflict guards',kind=>{
 it('rejects direct ancestor resolution and remote acceptance before writes while keeping the child sendable',async()=>{
 const r=await(await setup(kind)).open();await r.commit(batch('parent-work'));const parent={id:'parent',batch:batch('parent-work'),local:[remote({title:'local'},0)],remote:[remote({title:'remote two'},2)],reason:'stale' as const};await r.accept({status:'conflict',conflict:parent});const first=batch('first-resolution',{title:'local'},2);await r.commitResolution(parent.id,first);const child={id:'child',batch:first,local:[remote({title:'local'},2)],remote:[remote({title:'remote three'},3)],reason:'stale' as const};await r.accept({status:'conflict',conflict:child});const attempted=batch('stuck-parent-resolution',{title:'local'},3);await expect(r.commitResolution(parent.id,attempted)).rejects.toMatchObject({code:'superseded-conflict'});await expect(r.resolveRemote(parent.id)).rejects.toMatchObject({code:'superseded-conflict'});expect(await r.pending()).toEqual([]);await expect(r.localBatch(attempted.batchId)).resolves.toBeNull();const final=batch('child-resolution',{title:'local'},3);await r.commitResolution(child.id,final);expect((await r.queue())[0]).toMatchObject({blocked:false,resolves:expect.arrayContaining(['parent','child'])});expect(await r.conflicts()).toHaveLength(2);await r.accept({status:'applied',change:{cursor:4,batchId:final.batchId,entities:[remote({title:'local'},4)]}});expect(await r.conflicts()).toEqual([]);
 });
});
it('rejects cyclic or malformed persisted conflict lineage instead of hanging or enqueueing a resolution',async()=>{
 const {createRepository,emptyRepositoryState}=await import('../../src/workbench/storage/repository');
 for(const corrupt of ['cycle','malformed'] as const){let state=emptyRepositoryState();const original={id:'parent',batch:batch('parent-work'),local:[remote({title:'local'},0)],remote:[remote()],reason:'stale' as const};state.conflicts.parent=original;state.conflicts.child={...original,id:'child'};state.cursors['conflict-parents:parent']=['child'];state.cursors['conflict-parents:child']=corrupt==='cycle'?['parent']:42;const r=await createRepository({readonly:false,async read(action){return action(structuredClone(state));},async write(action){const draft=structuredClone(state);const result=action(draft);state=draft;return result;},close(){}});await expect(r.resolutionTarget('parent')).rejects.toMatchObject({code:'invalid-conflict-lineage'});await expect(r.commitResolution('parent',batch('unsafe',{title:'local'},1))).rejects.toMatchObject({code:'invalid-conflict-lineage'});expect(await r.pending()).toEqual([]);}
});
