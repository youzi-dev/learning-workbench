import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {IDBFactory} from 'fake-indexeddb';
import {openRepository} from '../../src/platforms/electron/repository';
import {openRepository as openBrowser} from '../../src/platforms/browser/repository';
import type {Entity, MutationBatch} from '../../src/workbench/contracts/data';
import {BackupService, type BackupDocument} from '../../src/workbench/storage/backup';
const close: (() => void)[] = [];
afterEach(() => {for (const action of close.splice(0).reverse()) action();});
async function setup() {const directory = mkdtempSync(join(tmpdir(), 'backup-v2-')); close.push(() => rmSync(directory, {recursive: true, force: true})); const repo = await openRepository('a', {directory}); close.push(() => repo.close()); return {directory, repo};}
function entity(id = randomUUID(), revision = 84): Entity {return {id, moduleId: 'journal', kind: 'note', schemaVersion: 1, revision, createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z', deletedAt: null, payload: {text: 'original', ref: {moduleId: 'tasks', entityId: 'task-id'}}};}
const encode = (document: unknown) => new TextEncoder().encode(JSON.stringify(document));
function document(entities = [entity()]): BackupDocument {return {format: 'growth-workbench', schemaVersion: 2, exportedAt: '2026-10-24T01:00:00.000Z', entities, conflicts: [], migrationMarkers: [], files: [], devicePreferences: {theme: 'dark'}};}
it('future_backup_is_readonly and source bytes remain identical', async () => {
  const {repo} = await setup(); const backup = new BackupService(repo, {schemas: {journal: {note: 1}}});
  const source = encode({...document(), schemaVersion: 9}); const original = [...source]; const preview = await backup.previewRestore(source);
  expect(preview.readonly).toBe(true); await expect(backup.restore(preview)).rejects.toThrow('readonly'); expect([...source]).toEqual(original); expect(await repo.pending()).toEqual([]);
  const newerEntity = {...entity(), schemaVersion: 8}; const future = await backup.previewRestore(encode(document([newerEntity]))); expect(future.readonly).toBe(true);
});
it('restore_does_not_reuse_remote_revision and duplicate confirmation survives reopen', async () => {
  const {directory, repo} = await setup(); const source = document(); const backup = new BackupService(repo, {schemas: {journal: {note: 1}}});
  const preview = await backup.previewRestore(encode(source)); const receipt = await backup.restore(preview);
  expect((await repo.get({moduleId: 'journal', entityId: source.entities[0].id}))?.revision).toBe(0);
  const queued = await repo.pending(); expect(queued).toHaveLength(1); expect(queued[0].mutations[0]).toMatchObject({baseRevision: null, deviceId: repo.deviceId}); expect(queued[0].mutations[0].operationId).not.toBe(source.entities[0].id);
  repo.close(); const reopened = await openRepository('a', {directory}); close.push(() => reopened.close()); const second = new BackupService(reopened, {schemas: {journal: {note: 1}}});
  expect(await second.restore(await second.previewRestore(encode(source)))).toEqual(receipt); expect(await reopened.pending()).toHaveLength(1);
});
it('same ID different content preserves conflict copies and absent records stay', async () => {
  const {repo} = await setup(); const source = entity(), unrelated = entity();
  await repo.apply({changes: [{cursor: 1, batchId: randomUUID(), entities: [{...source, payload: {text: 'current'}}, unrelated]}], nextCursor: 1, hasMore: false});
  const backup = new BackupService(repo, {schemas: {journal: {note: 1}}}); const preview = await backup.previewRestore(encode(document([source])));
  expect(preview.conflicts).toHaveLength(1); await backup.restore(preview);
  expect((await repo.get({moduleId: source.moduleId, entityId: source.id}))?.payload).toEqual({text: 'current'}); expect(await repo.get({moduleId: unrelated.moduleId, entityId: unrelated.id})).not.toBeNull();
  expect(await repo.conflicts()).toMatchObject([{reason: 'import-collision', local: [{payload: source.payload}], remote: [{payload: {text: 'current'}}]}]);
});
it('export excludes credentials and recovery bytes but preserves all note payloads, tombstones and references', async () => {
  const {repo} = await setup(); const note = entity(); note.payload = {text: 'apiKey is a word in my notes', apiKey: 'literal user note'};
  const tombstone = {...entity(), deletedAt: '2026-10-24T01:00:00.000Z'};
  await repo.apply({changes: [{cursor: 1, batchId: randomUUID(), entities: [note, tombstone]}], nextCursor: 1, hasMore: false});
  const snapshot = encode({oldApiKey: 'SECRET_RECOVERY_ONLY'}); const fingerprint = await crypto.subtle.digest('SHA-256', snapshot).then(b => Array.from(new Uint8Array(b), n => n.toString(16).padStart(2, '0')).join(''));
  await repo.importV1({fingerprint, entities: [], devicePreferences: {theme: 'dark', settings: {apiKey: 'SECRET_PREFERENCE'}, credential: 'SECRET_CREDENTIAL'}, sourceSnapshot: snapshot});
  const bytes = await new BackupService(repo).exportBackup(); const text = new TextDecoder().decode(bytes), exported = JSON.parse(text);
  expect(text).not.toContain('SECRET_'); expect(exported.entities).toContainEqual(note); expect(exported.entities).toContainEqual(tombstone); expect(exported.migrationMarkers[0]).toMatchObject({fingerprint}); expect(exported.migrationMarkers[0]).not.toHaveProperty('snapshot'); expect(exported.devicePreferences).toEqual({theme: 'dark'});
});
it('restore bounded batches resume after disk failure, oversized records fail before import', async () => {
  const {directory, repo} = await setup(); const entities = Array.from({length: 205}, () => entity()); const backup = new BackupService(repo, {schemas: {journal: {note: 1}}}); const bytes = encode(document(entities)); const preview = await backup.previewRestore(bytes);
  const db = new DatabaseSync(repo.path); close.push(() => db.close());
  db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON outbox WHEN (SELECT COUNT(*) FROM outbox)>=1 BEGIN SELECT RAISE(ABORT, 'disk-full'); END");
  await expect(backup.restore(preview)).rejects.toThrow('disk-full'); expect(await repo.pending()).toHaveLength(1); repo.close(); db.exec('DROP TRIGGER fail_second');
  const reopened = await openRepository('a', {directory}); close.push(() => reopened.close()); const second = new BackupService(reopened, {schemas: {journal: {note: 1}}}); await second.restore(await second.previewRestore(bytes));
  expect(await reopened.list('journal')).toHaveLength(205); const batches = await reopened.pending(); expect(batches).toHaveLength(3); for (const batch of batches) {expect(batch.mutations.length).toBeLessThanOrEqual(100); expect(encode(batch).length).toBeLessThanOrEqual(1_048_576);}
  const huge = entity(); huge.payload = {text: 'x'.repeat(1_048_576)}; await expect(second.previewRestore(encode(document([huge])))).rejects.toThrow('ENTITY_TOO_LARGE');
});
it('browser restore is persistent and optional file bytes must verify before restore', async () => {
  const indexedDB = new IDBFactory(); const repo = await openBrowser('browser', {indexedDB}); close.push(() => repo.close());
  const backup = new BackupService(repo, {schemas: {journal: {note: 1}}}); const source = document(); await backup.restore(await backup.previewRestore(encode(source))); repo.close();
  const reopened = await openBrowser('browser', {indexedDB}); close.push(() => reopened.close()); expect(await reopened.list('journal')).toHaveLength(1);
  const invalid = {...document(), files: [{sha256: 'a'.repeat(64), size: 4, mime: 'text/plain'}], fileContents: {['a'.repeat(64)]: [1, 2, 3, 4]}};
  await expect(new BackupService(reopened).previewRestore(encode(invalid))).rejects.toThrow('CHECKSUM_MISMATCH');
});
it('validated preview cannot be edited to bypass readonly or change imported content', async () => {
  const {repo} = await setup(); const service = new BackupService(repo, {schemas: {journal: {note: 1}}});
  const future = await service.previewRestore(encode(document([{...entity(), schemaVersion: 3}]))); future.readonly = false;
  await expect(service.restore(future)).rejects.toThrow('readonly');
  const incoming = entity(); const preview = await service.previewRestore(encode(document([incoming]))); preview.entities[0].payload = {text: 'tampered'};
  await service.restore(preview); expect((await repo.get({moduleId: incoming.moduleId, entityId: incoming.id}))?.payload).toEqual(incoming.payload);
});
it('embedded file export and isolated restore verify bytes before importing metadata', async () => {
  const {repo} = await setup(); const bytes = new TextEncoder().encode('backup original');
  const hash = await crypto.subtle.digest('SHA-256', bytes).then(value => Array.from(new Uint8Array(value), n => n.toString(16).padStart(2, '0')).join(''));
  const file = {sha256: hash, size: bytes.length, mime: 'text/plain'}, note = entity(); note.payload = {file};
  await repo.apply({changes: [{cursor: 1, batchId: randomUUID(), entities: [note]}], nextCursor: 1, hasMore: false});
  const backup = await new BackupService(repo, {files: {async read() {return bytes;}, async write() {throw new Error('source readonly');}}}).exportBackup({includeFiles: true});
  const target = await setup(); const saved = new Map<string, Uint8Array>();
  const restore = new BackupService(target.repo, {schemas: {journal: {note: 1}}, files: {async read(file) {return saved.get(file.sha256) ?? null;}, async write(file, content) {saved.set(file.sha256, content);}}});
  const preview = await restore.previewRestore(backup); expect(preview.missingFiles).toEqual([]); await restore.restore(preview); expect(saved.get(hash)).toEqual(bytes); expect(await target.repo.list('journal')).toHaveLength(1);
});
it('wire byte limits split large records and restored historical conflicts remain exportable', async () => {
  const {repo} = await setup(); const notes = Array.from({length: 3}, () => ({...entity(), payload: {text: 'x'.repeat(400_000)}}));
  const original = entity(), remote = {...original, payload: {text: 'remote'}};
  const conflictBatch: MutationBatch = {batchId: randomUUID(), mutations: [{operationId: randomUUID(), deviceId: randomUUID(), entityId: original.id, moduleId: original.moduleId, kind: original.kind, schemaVersion: 1, baseRevision: 80, action: 'put', payload: original.payload, createdAt: original.createdAt, updatedAt: original.updatedAt}]};
  const incoming = document(notes); incoming.conflicts = [{id: randomUUID(), batch: conflictBatch, local: [original], remote: [remote], reason: 'stale'}];
  const service = new BackupService(repo, {schemas: {journal: {note: 1}}}); await service.restore(await service.previewRestore(encode(incoming)));
  const batches = await repo.pending(); expect(batches).toHaveLength(2); expect(batches.map(batch => batch.mutations.length)).toEqual([2, 1]);
  for (const batch of batches) expect(encode(batch).length).toBeLessThanOrEqual(1_048_576);
  const restored = await repo.conflicts(); expect(restored).toHaveLength(1); expect(restored[0].id).not.toBe(incoming.conflicts[0].id); expect(restored[0].batch.mutations[0].baseRevision).toBeNull(); expect(restored[0].local).toEqual([original]); expect(restored[0].remote).toEqual([remote]);
  expect(JSON.parse(new TextDecoder().decode(await service.exportBackup())).conflicts).toHaveLength(1);
});
it('historical conflict evidence never becomes a live remote revision during restore resolution', async () => {
  const {repo} = await setup(); const original = entity(), remote = {...original, payload: {text: 'historical remote'}};
  const batch: MutationBatch = {batchId: randomUUID(), mutations: [{operationId: randomUUID(), deviceId: randomUUID(), entityId: original.id, moduleId: original.moduleId, kind: original.kind, schemaVersion: 1, baseRevision: 83, action: 'put', payload: original.payload, createdAt: original.createdAt, updatedAt: original.updatedAt}]};
  const incoming = document([]); incoming.conflicts = [{id: randomUUID(), batch, local: [original], remote: [remote], reason: 'stale'}];
  const service = new BackupService(repo, {schemas: {journal: {note: 1}}}); await service.restore(await service.previewRestore(encode(incoming)));
  const conflict = (await repo.conflicts())[0]; const {resolveConflict, conflictRemoteVersion} = await import('../../src/workbench/sync/conflicts');
  expect(await conflictRemoteVersion(repo, conflict)).toEqual([]);
  const receipt = await resolveConflict(repo, conflict.id, 'local', repo.deviceId!); const pending = await repo.pending(); expect(pending[0].mutations[0].baseRevision).toBeNull(); expect(await repo.conflicts()).toHaveLength(1);
  expect((await repo.conflicts())[0].remote).toEqual([remote]);
  await repo.accept({status: 'applied', change: {cursor: 1, batchId: receipt.batchId, entities: [{...original, revision: 1}]}}); expect(await repo.conflicts()).toEqual([]);
});
it('embedded backup budget rejects before reading files and oversized JSON rejects before parsing', async () => {
  const {repo} = await setup(); const file = {sha256: 'a'.repeat(64), size: 32 * 1024 ** 2 + 1, mime: 'application/octet-stream'}; const note = entity(); note.payload = {file};
  await repo.apply({changes: [{cursor: 1, batchId: randomUUID(), entities: [note]}], nextCursor: 1, hasMore: false});
  let reads = 0; const service = new BackupService(repo, {files: {async read() {reads++; throw new Error('MUST_NOT_READ');}, async write() {throw new Error('MUST_NOT_WRITE');}}});
  await expect(service.exportBackup({includeFiles: true})).rejects.toThrow('EMBEDDED_FILES_TOO_LARGE'); expect(reads).toBe(0);
  const metadata = JSON.parse(new TextDecoder().decode(await service.exportBackup())); expect(metadata.files).toEqual([file]);
  await expect(service.previewRestore(new Uint8Array(64 * 1024 ** 2 + 1))).rejects.toThrow('BACKUP_TOO_LARGE');
});
for (const choice of ['local', 'remote', 'copy'] as const) it(`persistent import collision ${choice} keeps incoming and target alternatives separate`, async () => {
  const {directory, repo} = await setup(); const incoming = entity(); incoming.payload = {text: 'incoming backup'};
  function edit(text: string): MutationBatch {return {batchId: randomUUID(), mutations: [{operationId: randomUUID(), deviceId: repo.deviceId!, entityId: incoming.id, moduleId: incoming.moduleId, kind: incoming.kind, schemaVersion: 1, baseRevision: null, createdAt: incoming.createdAt, updatedAt: incoming.updatedAt, action: 'put', payload: {text}}]};}
  const first = edit('target first'); await repo.commit(first);
  const service = new BackupService(repo, {schemas: {journal: {note: 1}}}); await service.restore(await service.previewRestore(encode(document([incoming]))));
  const later = edit('target later'); await repo.commit(later); repo.close();
  const reopened = await openRepository('a', {directory}); close.push(() => reopened.close());
  const {resolveConflict, conflictLocalVersion, conflictRemoteVersion} = await import('../../src/workbench/sync/conflicts'); const conflict = (await reopened.conflicts())[0];
  expect(await conflictLocalVersion(reopened, conflict)).toEqual([incoming]);
  expect((await conflictRemoteVersion(reopened, conflict))[0].payload).toEqual({text: 'target later'});
  const receipt = await resolveConflict(reopened, conflict.id, choice, reopened.deviceId!);
  const pending = await reopened.pending();
  if (choice === 'remote' || choice === 'copy') expect(pending.slice(0, 2).map(batch => batch.batchId)).toEqual([first.batchId, later.batchId]);
  if (choice === 'local' || choice === 'copy') expect(pending.at(-1)?.mutations[0].payload).toEqual(incoming.payload);
  if (choice === 'copy') expect(pending.at(-1)?.mutations[0].entityId).not.toBe(incoming.id);
  expect(await reopened.conflicts()).toHaveLength(1);
  const {openDatabase} = await import('../../server/database'), {AuthService} = await import('../../server/auth'), {SyncService} = await import('../../server/sync');
  const db = openDatabase(join(directory, 'real-sync.sqlite')); close.push(() => db.close()); const account = await new AuthService(db).provisionOwner();
  const sync = new SyncService(db, {journal: {note: {version: 1, parse(value) {return value as any;}}}});
  for (const queued of await reopened.pending()) {const wire = await reopened.prepare(queued.batchId); const ack = await sync.applyBatch(account, wire); expect(ack.status).toBe('applied'); await reopened.accept(ack);}
  expect(await reopened.conflicts()).toEqual([]); expect(await reopened.pending()).toEqual([]);
  const visible = await reopened.list('journal'); expect(visible.find(note => note.id === incoming.id)?.payload).toEqual({text: choice === 'local' ? 'incoming backup' : 'target later'});
  if (choice === 'copy') expect(visible.find(note => note.id !== incoming.id)?.payload).toEqual(incoming.payload);
  if (choice === 'remote') expect(receipt.batchId).toBe(later.batchId);
});
it('backup restores nested conflict ancestry through reopen and actual descendant acknowledgment', async () => {
  const source = await setup(); const local = entity(), remote = {...local, revision: 1, payload: {text: 'remote one'}};
  function mutation(text: string, base: number): MutationBatch {return {batchId: randomUUID(), mutations: [{operationId: randomUUID(), deviceId: source.repo.deviceId!, entityId: local.id, moduleId: local.moduleId, kind: local.kind, schemaVersion: 1, baseRevision: base, createdAt: local.createdAt, updatedAt: local.updatedAt, action: 'put', payload: {text}}]};}
  const first = {id: randomUUID(), batch: mutation('incoming alternative', 1), local: [{...local, payload: {text: 'incoming alternative'}}], remote: [remote], reason: 'stale' as const};
  await source.repo.accept({status: 'conflict', conflict: first}); const one = mutation('incoming alternative', 1); await source.repo.commitResolution(first.id, one);
  const second = {...first, id: randomUUID(), batch: one, remote: [{...remote, revision: 2, payload: {text: 'remote two'}}]}; await source.repo.accept({status: 'conflict', conflict: second}); const two = mutation('incoming alternative', 2); await source.repo.commitResolution(second.id, two);
  const third = {...first, id: randomUUID(), batch: two, remote: [{...remote, revision: 3, payload: {text: 'remote three'}}]}; await source.repo.accept({status: 'conflict', conflict: third});
  const bytes = await new BackupService(source.repo).exportBackup(); const originalBytes = [...bytes]; const exported = JSON.parse(new TextDecoder().decode(bytes));
  expect(exported.conflictParents[second.id]).toContain(first.id); expect(exported.conflictParents[third.id]).toEqual(expect.arrayContaining([first.id, second.id]));
  const target = await setup(); const restore = new BackupService(target.repo, {schemas: {journal: {note: 1}}}); await restore.restore(await restore.previewRestore(bytes)); target.repo.close();
  const reopened = await openRepository('a', {directory: target.directory}); close.push(() => reopened.close()); const conflicts = await reopened.conflicts(); const ancestor = conflicts.find(conflict => conflict.remote[0].revision === 1)!; const descendant = conflicts.find(conflict => conflict.remote[0].revision === 3)!;
  expect(await reopened.resolutionTarget(ancestor.id)).toBe(descendant.id);
  const {resolveConflict} = await import('../../src/workbench/sync/conflicts'); await expect(resolveConflict(reopened, ancestor.id, 'copy', reopened.deviceId!)).rejects.toThrow('已有后续版本'); await resolveConflict(reopened, descendant.id, 'local', reopened.deviceId!);
  expect((await reopened.queue()).at(-1)?.resolves).toEqual(expect.arrayContaining(conflicts.map(conflict => conflict.id)));
  const {openDatabase} = await import('../../server/database'), {AuthService} = await import('../../server/auth'), {SyncService} = await import('../../server/sync'); const db = openDatabase(join(target.directory, 'ack.sqlite')); close.push(() => db.close()); const account = await new AuthService(db).provisionOwner(); const sync = new SyncService(db, {journal: {note: {version: 1, parse(value) {return value as any;}}}});
  for (const queued of await reopened.pending()) {const ack = await sync.applyBatch(account, await reopened.prepare(queued.batchId)); expect(ack.status).toBe('applied'); await reopened.accept(ack);}
  expect(await reopened.conflicts()).toEqual([]); expect((await reopened.get({moduleId: local.moduleId, entityId: local.id}))?.payload).toEqual({text: 'incoming alternative'}); expect([...bytes]).toEqual(originalBytes);
});
it('cyclic and malformed backup ancestry fail before any restore writes', async () => {
  const {repo} = await setup(); const note = entity(); const batch: MutationBatch = {batchId: randomUUID(), mutations: [{operationId: randomUUID(), deviceId: repo.deviceId!, entityId: note.id, moduleId: note.moduleId, kind: note.kind, schemaVersion: 1, baseRevision: null, createdAt: note.createdAt, updatedAt: note.updatedAt, action: 'put', payload: note.payload}]};
  const source = document([]); source.conflicts = [{id: 'one', batch, local: [note], remote: [], reason: 'stale'}, {id: 'two', batch: {...batch, batchId: randomUUID()}, local: [note], remote: [], reason: 'stale'}];
  const service = new BackupService(repo); for (const conflictParents of [{one: ['two'], two: ['one']}, {two: ['missing']}, {two: 4}]) await expect(service.previewRestore(encode({...source, conflictParents}))).rejects.toThrow('INVALID_CONFLICT_LINEAGE');
  expect(await repo.conflicts()).toEqual([]); expect(await repo.pending()).toEqual([]);
});
