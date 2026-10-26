import {afterEach, expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskBlobStore} from '../../server/blob';
import {createApp} from '../../server/app';
import {openDatabase} from '../../server/database';
import {AuthService} from '../../server/auth';
import {SyncService} from '../../server/sync';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const action of cleanup.splice(0).reverse()) await action();});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-blobs-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  return {root, store: new DiskBlobStore(root, {chunkBytes: 4}), account: randomUUID()};
}
const bytes = new TextEncoder().encode('hello world');
const descriptor = {sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime: 'text/plain'};
async function fill(store: DiskBlobStore, account: string, uploadId: string) {
  for (let offset = 0; offset < bytes.length; offset += 4) await store.putChunk(account, uploadId, offset / 4, bytes.slice(offset, offset + 4));
}
it('chunk_retry_and_resume_are_idempotent across actual disk reopen', async () => {
  const {root, store, account} = setup(); const session = await store.begin(account, descriptor);
  expect(session.uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await store.putChunk(account, session.uploadId, 0, bytes.slice(0, 4));
  const reopened = new DiskBlobStore(root, {chunkBytes: 4});
  const resumed = await reopened.begin(account, descriptor);
  expect(resumed).toEqual({...session, received: [0]});
  await reopened.putChunk(account, session.uploadId, 0, bytes.slice(0, 4));
  await expect(reopened.putChunk(account, session.uploadId, 0, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('CHUNK_MISMATCH');
  await fill(reopened, account, session.uploadId);
  expect(await reopened.commit(account, session.uploadId)).toEqual(descriptor);
  expect(await reopened.read(account, descriptor.sha256, 2, 7)).toEqual(bytes.slice(2, 9));
  expect(await reopened.commit(account, session.uploadId)).toEqual(descriptor);
});
it('wrong_hash_never_publishes_downloadable', async () => {
  const {store, account} = setup(); const bad = {...descriptor, sha256: 'a'.repeat(64)};
  const session = await store.begin(account, bad); await fill(store, account, session.uploadId);
  await expect(store.commit(account, session.uploadId)).rejects.toThrow('CHECKSUM_MISMATCH');
  await expect(store.read(account, bad.sha256, 0, bad.size)).rejects.toThrow('BLOB_NOT_FOUND');
});
it('cancel_commit_race_keeps_saved_file and account isolation', async () => {
  const {store, account} = setup(); const session = await store.begin(account, descriptor); await fill(store, account, session.uploadId);
  await expect(store.commit(randomUUID(), session.uploadId)).rejects.toThrow('UPLOAD_NOT_FOUND');
  await Promise.all([store.commit(account, session.uploadId), store.cancel(account, session.uploadId)]);
  expect(await store.read(account, descriptor.sha256, 0, bytes.length)).toEqual(bytes);
  await expect(store.read(randomUUID(), descriptor.sha256, 0, bytes.length)).rejects.toThrow('BLOB_NOT_FOUND');
  await expect(store.begin('../outside', {...descriptor, sha256: '../escape'})).rejects.toThrow('INVALID_BLOB');
});
it('cancel before commit stays cancelled, zero-byte files verify and invalid chunk sizes fail', async () => {
  const {store, account} = setup(); const session = await store.begin(account, descriptor);
  await expect(store.putChunk(account, session.uploadId, 0, bytes)).rejects.toThrow('INVALID_CHUNK');
  await store.cancel(account, session.uploadId);
  await expect(store.commit(account, session.uploadId)).rejects.toThrow('UPLOAD_CANCELLED');
  const empty = {sha256: createHash('sha256').digest('hex'), size: 0, mime: 'application/octet-stream'};
  const zero = await store.begin(account, empty); await store.commit(account, zero.uploadId);
  expect(await store.read(account, empty.sha256, 0, 0)).toEqual(new Uint8Array());
});
it('authenticated HTTP upload, range read, revocation and client account rejection', async () => {
  const {root, store} = setup(); const db = openDatabase(join(root, 'db.sqlite')); cleanup.push(() => db.close());
  const auth = new AuthService(db); const owner = await auth.provisionOwner(); const credential = auth.pair(await auth.createPairingCode(owner), 'test', 'test');
  const app = createApp({auth, sync: new SyncService(db, {}), blobs: store} as Parameters<typeof createApp>[0]);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => app.close(() => resolve())));
  const address = app.address(); if (!address || typeof address === 'string') throw new Error('listen');
  const base = `http://127.0.0.1:${address.port}`; const headers = {authorization: `Bearer ${credential.token}`};
  expect((await fetch(`${base}/v1/blobs/begin`, {method: 'POST', body: JSON.stringify(descriptor)})).status).toBe(401);
  const started = await fetch(`${base}/v1/blobs/begin`, {method: 'POST', headers, body: JSON.stringify(descriptor)});
  expect(started.status).toBe(201); const session = await started.json();
  for (let offset = 0; offset < bytes.length; offset += 4) expect((await fetch(`${base}/v1/blobs/uploads/${session.uploadId}/chunks/${offset / 4}`, {method: 'POST', headers, body: bytes.slice(offset, offset + 4)})).status).toBe(204);
  expect((await fetch(`${base}/v1/blobs/uploads/${session.uploadId}/commit`, {method: 'POST', headers})).status).toBe(200);
  const read = await fetch(`${base}/v1/blobs/${descriptor.sha256}`, {headers: {...headers, range: 'bytes=1-5'}});
  expect(read.status).toBe(206); expect(read.headers.get('content-range')).toBe('bytes 1-5/11'); expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes.slice(1, 6));
  expect((await fetch(`${base}/v1/blobs/${descriptor.sha256}?accountId=evil`, {headers})).status).toBe(400);
  auth.revoke(owner, credential.deviceId);
  expect((await fetch(`${base}/v1/blobs/${descriptor.sha256}`, {headers})).status).toBe(401);
});

it('repeated commit rechecks durable content before confirming a staged original is safe to reclaim', async () => {
  const {root, store, account} = setup(); const session = await store.begin(account, descriptor); await fill(store, account, session.uploadId); await store.commit(account, session.uploadId);
  const directory = createHash('sha256').update(account).digest('hex'); writeFileSync(join(root, directory, descriptor.sha256), new Uint8Array(bytes.length));
  await expect(store.commit(account, session.uploadId)).rejects.toThrow('BLOB_CORRUPT');
});
