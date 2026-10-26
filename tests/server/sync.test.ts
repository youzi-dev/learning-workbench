import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../server/database';
import { AuthService } from '../../server/auth';
import { SyncService } from '../../server/sync';
import type { MutationBatch } from '../../src/workbench/contracts/data';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const schemas = { notes: { note: { version: 2, parse(value: unknown) { if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') throw new Error('invalid note'); return value as { text: string }; }, migrate(value: unknown) { return value; } } } };
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-sync-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cloud.sqlite'); const db = openDatabase(path); cleanups.push(() => { if (db.isOpen) db.close(); });
  const auth = new AuthService(db); const owner = await auth.provisionOwner();
  return { db, path, auth, owner, sync: new SyncService(db, schemas) };
}
function batch(baseRevision: number | null = null, entityId: string = randomUUID(), text = 'first'): MutationBatch {
  return { batchId: randomUUID(), mutations: [{ operationId: randomUUID(), deviceId: randomUUID(), entityId, moduleId: 'notes', kind: 'note', schemaVersion: 2, baseRevision, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', action: 'put', payload: { text } }] };
}
it('retry_returns_same_change across a durable restart', async () => {
  const { db, path, owner, sync } = await setup(); const mutation = batch();
  const first = await sync.applyBatch(owner, mutation);
  db.close();
  const restarted = openDatabase(path); cleanups.push(() => restarted.close()); const resumed = new SyncService(restarted, schemas);
  expect(await resumed.applyBatch(owner, mutation)).toEqual(first);
  expect((await resumed.pullChanges(owner, 0, 100)).changes).toHaveLength(1);
  expect(restarted.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
});
it('stale_revision_returns_conflict and concurrent updates allow only one winner', async () => {
  const { owner, sync, path } = await setup(); const initial = batch(); await sync.applyBatch(owner, initial);
  const secondDb = openDatabase(path); cleanups.push(() => secondDb.close());
  const results = await Promise.all([sync.applyBatch(owner, batch(1, initial.mutations[0].entityId, 'a')), new SyncService(secondDb, schemas).applyBatch(owner, batch(1, initial.mutations[0].entityId, 'b'))]);
  expect(results.map(r => r.status).sort()).toEqual(['applied', 'conflict']);
  const conflict = results.find(r => r.status === 'conflict'); expect(conflict?.status === 'conflict' && conflict.conflict.remote[0].revision).toBe(2);
});
it('partial_duplicate_rolls_back and inconsistent retries never mutate records', async () => {
  const { owner, sync } = await setup(); const first = batch(); await sync.applyBatch(owner, first);
  const fresh = batch(); const mixed = { batchId: randomUUID(), mutations: [...first.mutations, ...fresh.mutations] };
  await expect(sync.applyBatch(owner, mixed)).rejects.toThrow('BATCH_MISMATCH');
  await expect(sync.applyBatch(owner, { ...first, mutations: [{ ...first.mutations[0], payload: { text: 'changed' } }] })).rejects.toThrow('BATCH_MISMATCH');
  expect((await sync.pullChanges(owner, 0, 100)).changes).toHaveLength(1);
});
it('foreign_account_reads_nothing and cannot update another account entity', async () => {
  const { owner, sync } = await setup(); const initial = batch(); await sync.applyBatch(owner, initial);
  expect((await sync.pullChanges(randomUUID(), 0, 100)).changes).toEqual([]);
  const other = randomUUID(); const result = await sync.applyBatch(other, batch(1, initial.mutations[0].entityId)); expect(result.status).toBe('conflict');
});
it('clock_does_not_order_changes and pagination preserves complete batches', async () => {
  const { owner, sync } = await setup(); const first = batch(); first.mutations[0].updatedAt = '2099-01-01T00:00:00.000Z';
  await sync.applyBatch(owner, first); const second = batch(1, first.mutations[0].entityId, 'old-clock'); second.mutations.push(...batch().mutations); await sync.applyBatch(owner, second);
  const page = await sync.pullChanges(owner, 0, 1); expect(page.changes).toHaveLength(1); expect(page.hasMore).toBe(true);
  const next = await sync.pullChanges(owner, page.nextCursor, 1); expect(next.changes[0].entities).toHaveLength(2); expect(next.changes[0].entities[0].payload).toEqual({ text: 'old-clock' }); expect(next.hasMore).toBe(false);
});
it('deletion adds a tombstone and old edits cannot revive it; conflicted batches are atomic', async () => {
  const { owner, sync } = await setup(); const initial = batch(); await sync.applyBatch(owner, initial); const id = initial.mutations[0].entityId;
  const deletion = batch(1, id); deletion.mutations[0] = { ...deletion.mutations[0], action: 'delete', payload: null }; const deleted = await sync.applyBatch(owner, deletion);
  expect(deleted.status === 'applied' && deleted.change.entities[0]).toMatchObject({ revision: 2, deletedAt: expect.any(String) });
  const stale = batch(1, id); stale.mutations.push(...batch().mutations); const result = await sync.applyBatch(owner, stale); expect(result.status === 'conflict' && result.conflict.reason).toBe('deleted');
  expect((await sync.pullChanges(owner, 0, 100)).changes).toHaveLength(2);
});
it('old_client_cannot_overwrite_new_schema but can read full envelopes and edit compatible kinds', async () => {
  const { owner, sync } = await setup(); const initial = batch(); initial.mutations[0].payload = { text: 'future', newField: { retained: true } }; await sync.applyBatch(owner, initial);
  const hello = sync.handshake({ protocolVersion: 1, hostApiVersion: 1, schemas: { notes: { note: 1 } } }); expect(hello.readonlyKinds).toContain('notes/note');
  const old = batch(1, initial.mutations[0].entityId); old.mutations[0].schemaVersion = 1;
  await expect(sync.applyBatch(owner, old)).rejects.toThrow('SCHEMA_VERSION_UNSUPPORTED');
  expect((await sync.pullChanges(owner, 0, 100)).changes[0].entities[0].payload).toEqual(initial.mutations[0].payload);
  expect((await sync.applyBatch(owner, batch())).status).toBe('applied');
});
it('rejects unknown schemas, invalid payloads, duplicate operations, duplicate entities, and empty batches', async () => {
  const { owner, sync } = await setup();
  const unknown = batch(); unknown.mutations[0].kind = 'unknown'; await expect(sync.applyBatch(owner, unknown)).rejects.toThrow('UNKNOWN_SCHEMA');
  const invalid = batch(); invalid.mutations[0].payload = {}; await expect(sync.applyBatch(owner, invalid)).rejects.toThrow('INVALID_PAYLOAD');
  const duplicate = batch(); duplicate.mutations.push(duplicate.mutations[0]); await expect(sync.applyBatch(owner, duplicate)).rejects.toThrow('BATCH_MISMATCH');
  const repeated = batch(); repeated.mutations.push({ ...repeated.mutations[0], operationId: randomUUID() }); await expect(sync.applyBatch(owner, repeated)).rejects.toThrow('INVALID_BATCH');
  await expect(sync.applyBatch(owner, { batchId: randomUUID(), mutations: [] })).rejects.toThrow('INVALID_BATCH');
  expect((await sync.pullChanges(owner, 0, 100)).changes).toEqual([]);
});

it('independent worker connections serialize simultaneous writes to one expected revision', async () => {
  const { owner, sync, path } = await setup(); const first = batch(); await sync.applyBatch(owner, first);
  const dir = mkdtempSync(join(tmpdir(), 'workbench-workers-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = join(dir, 'services.mjs');
  buildSync({ stdin: { contents: "export {openDatabase} from './server/database'; export {SyncService} from './server/sync';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile });
  mkdirSync(join(dir, 'migrations')); copyFileSync(resolve('server/migrations/001-initial.sql'), join(dir, 'migrations/001-initial.sql'));
  const code = `const {parentPort,workerData}=require('node:worker_threads');
  import(workerData.moduleUrl).then(({openDatabase,SyncService})=>{
    const db=openDatabase(workerData.path); const schemas={notes:{note:{version:2,parse(value){return value;}}}};
    parentPort.postMessage('ready'); parentPort.once('message',async()=>{try {
      const result=await new SyncService(db,schemas).applyBatch(workerData.owner,workerData.batch);
      db.close();parentPort.postMessage(result.status);parentPort.close();
    }catch(error){parentPort.postMessage({error:error.message});parentPort.close();}});
  }).catch(error=>{parentPort.postMessage({error:error.message});parentPort.close();});`;
  const workers = ['left', 'right'].map(text => new Worker(code, { eval: true, workerData: { moduleUrl: pathToFileURL(outfile).href, path, owner, batch: batch(1, first.mutations[0].entityId, text) } }));
  await Promise.all(workers.map(worker => new Promise<void>((resolveReady, reject) => { worker.once('error', reject); worker.once('message', value => value === 'ready' ? resolveReady() : reject(new Error(JSON.stringify(value)))); })));
  const completed = workers.map(worker => new Promise<string>((resolveDone, reject) => { worker.once('error', reject); worker.once('message', value => typeof value === 'string' ? resolveDone(value) : reject(new Error(JSON.stringify(value)))); }));
  workers.forEach(worker => worker.postMessage('go'));
  expect((await Promise.all(completed)).sort()).toEqual(['applied', 'conflict']);
  expect((await sync.pullChanges(owner, 0, 100)).changes).toHaveLength(2);
});

it('deleted tombstone retains payload in actual pull and stale offline work cannot resurrect it', async () => {
 const {owner,sync}=await setup(); const initial=batch(); initial.mutations[0].payload={text:'trash label',unknown:{keep:true}}; await sync.applyBatch(owner,initial); const deletion=batch(1,initial.mutations[0].entityId); deletion.mutations[0].action='delete';deletion.mutations[0].payload=null;await sync.applyBatch(owner,deletion); const pulled=await sync.pullChanges(owner,0,100); expect(pulled.changes[1].entities[0]).toMatchObject({deletedAt:expect.any(String),payload:{text:'trash label',unknown:{keep:true}}}); const stale=await sync.applyBatch(owner,batch(1,initial.mutations[0].entityId,'offline'));expect(stale.status==='conflict'&&stale.conflict.reason).toBe('deleted');
});
it('identical conflict replay after reopen and another remote write preserves the original receipt without another cursor',async()=>{
 const {owner,sync,db,path}=await setup();const initial=batch();await sync.applyBatch(owner,initial);await sync.applyBatch(owner,batch(1,initial.mutations[0].entityId,'remote two'));const stale=batch(1,initial.mutations[0].entityId,'offline');const conflict=await sync.applyBatch(owner,stale);await sync.applyBatch(owner,batch(2,initial.mutations[0].entityId,'remote three'));const before=await sync.pullChanges(owner,0,100);db.close();const reopened=openDatabase(path);cleanups.push(()=>reopened.close());const resumed=new SyncService(reopened,schemas);expect(await resumed.applyBatch(owner,stale)).toEqual(conflict);expect(await resumed.pullChanges(owner,0,100)).toEqual(before);
});
