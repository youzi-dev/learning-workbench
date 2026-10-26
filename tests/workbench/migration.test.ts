import {afterEach, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFile, mkdtemp, rm, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {IDBFactory} from 'fake-indexeddb';
import fixture from '../fixtures/workbench/v1-complete.json';
import {openRepository} from '../../src/platforms/electron/repository';
import {openRepository as openBrowser} from '../../src/platforms/browser/repository';
import {migrateV1} from '../../src/workbench/storage/migration';
import {splitV1} from '../../src/modules/learning/migrate-v1';
import type {BrowserDocument} from '../../src/core/browser-state';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
async function setup() {const directory = await mkdtemp(join(tmpdir(), 'migration-')); cleanup.push(() => rm(directory, {force: true, recursive: true})); const repo = await openRepository('account', {directory}); cleanup.push(() => repo.close()); return {directory, repo};}
const bytes = () => new TextEncoder().encode(JSON.stringify(fixture));
const hash = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
it('migration_relaunch_is_idempotent', async () => {
  const {directory, repo} = await setup(); const source = bytes(); const fingerprint = hash(source);
  const path = join(directory, 'document-v1.json'); await writeFile(path, source); await chmod(path, 0o444);
  const first = await migrateV1(source, repo); expect(first.imported).toBeGreaterThan(5); expect(first.fingerprint).toBe(fingerprint);
  expect(await repo.recoverySnapshot(fingerprint)).toEqual(source); expect(await repo.migrationStatus(fingerprint)).toMatchObject({active: true});
  repo.close(); const reopened = await openRepository('account', {directory}); cleanup.push(() => reopened.close());
  expect(await migrateV1(await readFile(path), reopened)).toEqual({fingerprint, imported: 0});
  expect(hash(await readFile(path))).toBe(fingerprint); expect((await reopened.list('learning')).length).toBe(first.imported);
});
it('migration_write_failure_preserves_source', async () => {
  const {repo} = await setup(); const source = bytes(), fingerprint = hash(source);
  const db = new DatabaseSync(repo.path); cleanup.push(() => db.close()); db.exec("CREATE TRIGGER fail_marker BEFORE INSERT ON migrations BEGIN SELECT RAISE(ABORT, 'full'); END");
  await expect(migrateV1(source, repo)).rejects.toBeDefined();
  expect(hash(source)).toBe(fingerprint); expect(await repo.migrationStatus(fingerprint)).toBeNull();
  expect(await repo.list('learning')).toEqual([]); expect(await repo.pending()).toEqual([]); expect(await repo.devicePreferences()).toBeNull();
});
it('migration_future_schema_is_readonly', async () => {
  const {repo} = await setup(); const source = new TextEncoder().encode(JSON.stringify({...fixture, schemaVersion: 9}));
  const before = hash(source); await expect(migrateV1(source, repo)).rejects.toMatchObject({code: 'future-schema', readonly: true});
  expect(hash(source)).toBe(before); expect(await repo.pending()).toEqual([]);
  const db = new DatabaseSync(repo.path); db.exec('PRAGMA user_version=9'); db.close(); repo.close();
  const future = await openRepository('account', {directory: repo.directory}); cleanup.push(() => future.close());
  expect(future.readonly).toBe(true); expect(await future.list('learning')).toEqual([]);
  await expect(future.importV1({fingerprint: 'x', entities: [], devicePreferences: {}, sourceSnapshot: bytes()})).rejects.toMatchObject({code: 'readonly-schema'});
});
it('maps every declared v1 field without current-course validation or secret leakage', () => {
  const document = {state: fixture.state, drafts: fixture.browser.drafts} as BrowserDocument;
  const {entities, devicePreferences} = splitV1(document, 'source-fingerprint');
  const column: any = entities.find(e => e.id === 'column-old')?.payload;
  expect(column.column).toEqual(fixture.state.columns[0]); expect(column.sideChats).toEqual([fixture.state.sideChats[0]]);
  expect(column.contexts).toEqual({'column-old': fixture.state.contexts['column-old'], 'side-old': fixture.state.contexts['side-old']});
  expect(column.drafts.messages).toEqual({'column-old': 'unfinished main', 'side-old': 'unfinished side'});
  expect(column.drafts.references).toEqual({'column-old': fixture.browser.drafts.references['column-old']});
  expect(column.checkins[0]).toMatchObject(fixture.state.checkins[0]); expect(column.checkins[0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(entities.find(e => e.id === 'practice-old')?.payload).toEqual(fixture.state.practice[0]);
  expect(entities.find(e => e.id === 'attempt-old')?.payload).toEqual(fixture.state.lab.attempts[0]);
  expect(entities.find(e => e.id === 'usage-old')?.payload).toEqual(fixture.state.usageRecords[0]);
  expect(entities.find(e => e.kind === 'learning.lab-session')?.payload).toEqual({key: 'removed-unit:practice', session: fixture.state.lab.sessions['removed-unit:practice'], draft: fixture.browser.drafts.lab['removed-unit:practice']});
  expect(entities.find(e => e.kind === 'learning.reading')?.payload).toEqual(fixture.state.reading);
  const orphan: any = entities.find(e => e.kind === 'learning.orphans')?.payload;
  expect(orphan.sideChats).toEqual([fixture.state.sideChats[1]]); expect(orphan.contexts.orphan).toEqual(fixture.state.contexts.orphan);
  expect(orphan.drafts.messages.orphan).toBe('orphan draft'); expect(orphan.drafts.references).toEqual({orphan: fixture.browser.drafts.references.orphan}); expect(orphan.checkins[0].note).toBe('orphan note');
  const settings = structuredClone(fixture.state.settings) as any; delete settings.apiKey; delete settings.modelLibrary.profiles[0].apiKey;
  expect(devicePreferences).toMatchObject({activeColumnId: 'column-old', onboarding: fixture.state.onboarding, settings});
  expect(JSON.stringify(entities)).not.toContain('DO-NOT-SYNC'); expect(JSON.stringify(entities)).not.toContain('modelLibrary');
});
it('reports unknown fields and keeps the exact original recovery bytes', async () => {
  const {repo} = await setup(); const modified = structuredClone(fixture) as any; modified.state.newFutureField = {detail: 'keep original'}; modified.state.columns[0].newEvidenceFormat = {a: 1};
  const source = new TextEncoder().encode(JSON.stringify(modified)); const result = await migrateV1(source, repo);
  expect(await repo.recoverySnapshot(result.fingerprint)).toEqual(source);
  expect(await repo.devicePreferences()).toMatchObject({migrationWarnings: expect.arrayContaining(['state.newFutureField', 'state.columns[0].newEvidenceFormat'])});
});
it('same ID with different content preserves both versions as import conflict', async () => {
  const {repo} = await setup(); await migrateV1(bytes(), repo);
  const changed = structuredClone(fixture); changed.state.columns[0].goal = 'different device';
  await migrateV1(new TextEncoder().encode(JSON.stringify(changed)), repo);
  const conflicts = await repo.conflicts(); expect(conflicts.some(c => c.reason === 'import-collision' && c.local.some(e => e.id === 'column-old'))).toBe(true);
  expect((await repo.get({moduleId: 'learning', entityId: 'column-old'}))?.payload).toMatchObject({column: {goal: 'original goal'}});
});
it('browser migration is persistent, atomic and leaves old database unchanged', async () => {
  const indexedDB = new IDBFactory(); const old = await new Promise<IDBDatabase>((resolve, reject) => {const r = indexedDB.open('growth-workbench', 1); r.onupgradeneeded = () => r.result.createObjectStore('document'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);});
  const source = bytes(); await new Promise<void>((resolve, reject) => {const tx = old.transaction('document', 'readwrite'); tx.objectStore('document').put(source, 'original'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);});
  const r = await openBrowser('a', {indexedDB}); const result = await migrateV1(source, r); r.close();
  const reopened = await openBrowser('a', {indexedDB}); cleanup.push(() => reopened.close());
  expect((await reopened.list('learning')).length).toBe(result.imported); expect(await reopened.recoverySnapshot(result.fingerprint)).toEqual(source);
  const saved = await new Promise<Uint8Array>(resolve => {const q = old.transaction('document').objectStore('document').get('original'); q.onsuccess = () => resolve(q.result);});
  expect(hash(saved)).toBe(hash(source)); old.close();
});
it('preserves future envelope fields with a recovery warning instead of ignoring them', async () => {
  const {repo} = await setup(); const modified = {...fixture, extraEnvelope: {unknown: true}};
  await migrateV1(new TextEncoder().encode(JSON.stringify(modified)), repo);
  expect(await repo.devicePreferences()).toMatchObject({migrationWarnings: expect.arrayContaining(['source.extraEnvelope'])});
});
it('validates required records instead of defaulting explicit null data', async () => {
  const {repo} = await setup(); const modified = structuredClone(fixture) as any; modified.state.lab = null;
  await expect(migrateV1(new TextEncoder().encode(JSON.stringify(modified)), repo)).rejects.toMatchObject({code: 'invalid'});
  expect(await repo.pending()).toEqual([]);
});
it('browser migration abort after the activation put leaves no activation, preferences or data', async () => {
  const {IDBObjectStore} = await import('fake-indexeddb'); const indexedDB = new IDBFactory(); const r = await openBrowser('a', {indexedDB}); cleanup.push(() => r.close());
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
    const request = put.apply(this, args); if (this.name === 'migrations') request.addEventListener('success', () => this.transaction.abort()); return request;
  });
  const source = bytes(); await expect(migrateV1(source, r)).rejects.toBeDefined();
  expect(await r.migrationStatus(hash(source))).toBeNull(); expect(await r.list('learning')).toEqual([]); expect(await r.pending()).toEqual([]); expect(await r.devicePreferences()).toBeNull();
});
it.each([{appVersion: ''}, {exportedAt: 'bad date'}, {browser: {drafts: null}}])('rejects invalid backup metadata or explicit null drafts: %o', async patch => {
  const {repo} = await setup(); const modified = {...fixture, ...patch};
  await expect(migrateV1(new TextEncoder().encode(JSON.stringify(modified)), repo)).rejects.toMatchObject({code: 'invalid'});
  expect(await repo.pending()).toEqual([]);
});
it('imports with authenticated installation UUID and distinct operation identities on separate devices', async () => {
  const a = await setup(), b = await setup(); await migrateV1(bytes(), a.repo); await migrateV1(bytes(), b.repo);
  const first = (await a.repo.pending())[0], second = (await b.repo.pending())[0];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  expect(first.batchId).toMatch(uuid); expect(first.mutations.every(m => uuid.test(m.operationId) && m.deviceId === a.repo.deviceId)).toBe(true);
  expect(second.batchId).not.toBe(first.batchId); expect(second.mutations[0].operationId).not.toBe(first.mutations[0].operationId);
  expect(first.mutations.find(m => m.entityId === 'column-old')).toBeDefined();
});
it('binds a migration activation to the exact SHA-256 source snapshot', async () => {
  const {repo} = await setup();
  await expect(repo.importV1({fingerprint: hash(bytes()), entities: [], devicePreferences: {}, sourceSnapshot: new Uint8Array([1, 2, 3])})).rejects.toMatchObject({code: 'invalid'});
  expect(await repo.migrationStatus(hash(bytes()))).toBeNull();
});
it('returned recovery bytes cannot mutate the persisted immutable original', async () => {
  const {repo} = await setup(); const source = bytes(), result = await migrateV1(source, repo);
  const recovery = await repo.recoverySnapshot(result.fingerprint); recovery!.fill(0);
  expect(await repo.recoverySnapshot(result.fingerprint)).toEqual(source);
});
