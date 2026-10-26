import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {DiskFileStorage} from '../../src/platforms/electron/file-storage';
import {BrowserFileStorage} from '../../src/platforms/browser/file-storage';
import {FileCache} from '../../src/workbench/files/cache';
import {DurableStaging} from '../../src/workbench/files/staging';
import {FileTransfer} from '../../src/workbench/files/transfer';
import {DiskBlobStore} from '../../server/blob';
const cleanups: (() => void)[] = [];
afterEach(() => {for (const action of cleanups.splice(0).reverse()) action();});
function setup() {const root = mkdtempSync(join(tmpdir(), 'filecache-')); cleanups.push(() => rmSync(root, {recursive: true, force: true})); return {root, disk: new DiskFileStorage(root)};}
const encode = (value: string) => new TextEncoder().encode(value);
const describe = (bytes: Uint8Array) => ({sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime: 'text/plain'});
const signal = () => new AbortController().signal;
it('remove_local_keeps_cloud_blob and new device downloads only on demand', async () => {
  const {root, disk} = setup(); const store = new DiskBlobStore(join(root, 'cloud'), {chunkBytes: 4}); const bytes = encode('on demand'); const file = describe(bytes);
  const upload = await store.begin('account', file); for (let i = 0; i < bytes.length; i += 4) await store.putChunk('account', upload.uploadId, i / 4, bytes.slice(i, i + 4)); await store.commit('account', upload.uploadId);
  const cache = new FileCache(disk, {budgetBytes: 16}); const transfer = new FileTransfer(store, cache, disk, {chunkBytes: 4});
  expect(await cache.entries('account')).toEqual([]);
  const local = await transfer.ensureLocal('account', file, signal()); expect(await cache.read(local, 0, bytes.length)).toEqual(bytes);
  await cache.removeLocal('account', file.sha256); expect(await cache.has('account', file.sha256)).toBe(false);
  expect(await store.read('account', file.sha256, 0, bytes.length)).toEqual(bytes);
  expect(await new FileTransfer(store, new FileCache(new DiskFileStorage(root)), new DiskFileStorage(root)).ensureLocal('account', file, signal())).toMatchObject({size: bytes.length});
});
it('pinned_over_budget_is_not_evicted and in-use files survive eviction', async () => {
  const {disk} = setup(); const cache = new FileCache(disk, {budgetBytes: 5}); const a = encode('aaaa'), b = encode('bbbb'); const fa = describe(a), fb = describe(b);
  await cache.put('a', fa, a); await cache.setPinned('a', fa.sha256, true);
  await expect(cache.put('a', fb, b)).rejects.toThrow('CACHE_SPACE_REQUIRED'); expect(await cache.has('a', fa.sha256)).toBe(true);
  await cache.setPinned('a', fa.sha256, false); const release = await cache.acquire('a', fa.sha256);
  await expect(cache.put('a', fb, b)).rejects.toThrow('CACHE_SPACE_REQUIRED'); await release();
  await cache.put('a', fb, b); expect(await cache.has('a', fa.sha256)).toBe(false);
});
it('offline_import_restart_cache_gc_then_upload_keeps_original', async () => {
  const {root, disk} = setup(); const bytes = encode('only original file'); const original = join(root, 'original'); writeFileSync(original, bytes);
  const source = {async read(_ref: unknown, offset: number, length: number) {return new Uint8Array(readFileSync(original).subarray(offset, offset + length));}};
  const staging = new DurableStaging('a', disk, source); const ref = await staging.stage({token: 'source', name: '../name.txt', mime: 'text/plain', size: bytes.length}); unlinkSync(original);
  const reopened = new DurableStaging('a', new DiskFileStorage(root), {async read() {throw new Error('URI_EXPIRED');}});
  const cache = new FileCache(disk, {budgetBytes: 1}); await cache.collect('a'); expect(await reopened.read(ref, 0, ref.size)).toEqual(bytes);
  const store = new DiskBlobStore(join(root, 'cloud'), {chunkBytes: 4}); const transfer = new FileTransfer(store, cache, disk);
  await transfer.uploadStaged('a', ref, reopened, signal()); expect(await store.read('a', describe(bytes).sha256, 0, bytes.length)).toEqual(bytes);
  expect((await reopened.list()).find(item => item.ref.token === ref.token)?.cloudVerified).toBe(true);
  await reopened.reclaim(ref); await expect(reopened.read(ref, 0, 1)).rejects.toThrow('STAGED_FILE_NOT_FOUND');
});
it('staging_disk_full_never_reports_saved and unverified originals cannot be reclaimed', async () => {
  const {disk} = setup(); const originalWrite = disk.write.bind(disk); let writes = 0;
  disk.write = async (...args) => {if (++writes === 2) throw new Error('ENOSPC'); return originalWrite(...args);};
  const staging = new DurableStaging('a', disk, {async read() {return encode('data');}});
  await expect(staging.stage({token: 'source', name: 'file', mime: 'text/plain', size: 4})).rejects.toThrow('ENOSPC'); expect(await staging.list()).toEqual([]);
  disk.write = originalWrite; const ref = await staging.stage({token: 'source', name: 'file', mime: 'text/plain', size: 4});
  await expect(staging.reclaim(ref)).rejects.toThrow('CLOUD_NOT_VERIFIED');
});
it('browser staged bytes survive a new IndexedDB adapter and stay account isolated', async () => {
  const indexedDB = new IDBFactory(); const first = await BrowserFileStorage.open({indexedDB, name: 'test-files'}); const bytes = encode('browser original');
  const stage = new DurableStaging('a', first, {async read(_ref, offset, length) {return bytes.slice(offset, offset + length);}});
  const ref = await stage.stage({token: 'source', name: 'f', mime: 'text/plain', size: bytes.length}); first.close();
  const second = await BrowserFileStorage.open({indexedDB, name: 'test-files'}); cleanups.push(() => second.close());
  expect(await new DurableStaging('a', second, {async read() {throw new Error('expired');}}).read(ref, 0, ref.size)).toEqual(bytes);
  await expect(new DurableStaging('b', second, {async read() {throw new Error('expired');}}).read(ref, 0, ref.size)).rejects.toThrow('STAGED_FILE_NOT_FOUND');
});
it('interrupted download resumes durable chunks and rejects corrupt cloud bytes', async () => {
  const {disk} = setup(); const bytes = encode('resume me'); const file = describe(bytes); let reads = 0;
  const store = {async read(_account: string, _sha: string, offset: number, length: number) {reads++; if (reads === 2) throw new Error('NETWORK'); return bytes.slice(offset, offset + length);}};
  const cache = new FileCache(disk); const transfer = new FileTransfer(store, cache, disk, {chunkBytes: 4});
  await expect(transfer.ensureLocal('a', file, signal())).rejects.toThrow('NETWORK'); const firstReads = reads;
  const ref = await new FileTransfer(store, cache, disk, {chunkBytes: 4}).ensureLocal('a', file, signal()); expect(await cache.read(ref, 0, ref.size)).toEqual(bytes); expect(reads - firstReads).toBe(2);
  const wrong = {...file, sha256: 'a'.repeat(64)};
  await expect(transfer.ensureLocal('a', wrong, signal())).rejects.toThrow('CHECKSUM_MISMATCH'); expect(await cache.has('a', wrong.sha256)).toBe(false);
});
it('disk and browser durable range reads return exact slices after reopen', async () => {
  const {disk} = setup(); const bytes = encode('0123456789'); await disk.write('a', 'binary', bytes);
  expect(await disk.readRange('a', 'binary', 3, 4)).toEqual(encode('3456'));
  await expect(disk.readRange('a', 'binary', 8, 4)).rejects.toThrow('INVALID_RANGE');
  const indexedDB = new IDBFactory(); const first = await BrowserFileStorage.open({indexedDB, name: 'ranges'}); await first.write('a', 'binary', bytes); first.close();
  const second = await BrowserFileStorage.open({indexedDB, name: 'ranges'}); cleanups.push(() => second.close()); expect(await second.readRange('a', 'binary', 3, 4)).toEqual(encode('3456'));
});
it('a staged original cannot be uploaded under a different account', async () => {
  const {root, disk} = setup(); const staging = new DurableStaging('owner-a', disk, {async read() {return encode('data');}}); const ref = await staging.stage({token: 'picked', name: 'file', mime: 'text/plain', size: 4});
  const transfer = new FileTransfer(new DiskBlobStore(join(root, 'cloud')), new FileCache(disk), disk);
  await expect(transfer.uploadStaged('owner-b', ref, staging, signal())).rejects.toThrow('ACCOUNT_MISMATCH'); expect((await staging.list())[0].cloudVerified).toBe(false);
});
it('staging and download verification keep all reads and durable writes bounded', async () => {
  const {disk} = setup(); const part = new Uint8Array(1_048_576).fill(7); const parts = 8;
  const digest = createHash('sha256'); for (let i = 0; i < parts; i++) digest.update(part);
  const file = {sha256: digest.digest('hex'), size: part.length * parts, mime: 'application/octet-stream'};
  const write = disk.write.bind(disk); let maximumWrite = 0, maximumRead = 0;
  disk.write = async (account, key, bytes) => {maximumWrite = Math.max(maximumWrite, bytes.length); if (bytes.length > part.length) throw new Error('UNBOUNDED_FILE_WRITE'); await write(account, key, bytes);};
  const staging = new DurableStaging('a', disk, {async read(_ref, _offset, length) {maximumRead = Math.max(maximumRead, length); return part.slice(0, length);}});
  const ref = await staging.stage({token: 'picked', name: 'large.bin', mime: file.mime, size: file.size}); expect(await staging.descriptor(ref)).toEqual(file);
  const store = {async read(_account: string, _sha: string, _offset: number, length: number) {maximumRead = Math.max(maximumRead, length); return part.slice(0, length);}};
  const cache = new FileCache(disk); const downloaded = await new FileTransfer(store, cache, disk).ensureLocal('a', file, signal());
  expect(await cache.read(downloaded, part.length - 2, 4)).toEqual(new Uint8Array(4).fill(7));
  expect(maximumRead).toBeLessThanOrEqual(part.length); expect(maximumWrite).toBeLessThanOrEqual(part.length);
});
it('scope abort after cloud commit keeps staged original unconfirmed and unreclaimed', async () => {
  const {root, disk} = setup(); const original = encode('keep after abort'); const controller = new AbortController(); const staging = new DurableStaging('a', disk, {async read(_ref, offset, length) {return original.slice(offset, offset + length);}});
  const ref = await staging.stage({token: 'picked', name: 'file', mime: 'text/plain', size: original.length}); const cloud = new DiskBlobStore(join(root, 'cloud'));
  const commit = cloud.commit.bind(cloud); cloud.commit = async (...args) => {const result = await commit(...args); controller.abort(); return result;};
  await expect(new FileTransfer(cloud, new FileCache(disk), disk).uploadStaged('a', ref, staging, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
  expect((await staging.list())[0].cloudVerified).toBe(false); expect(await staging.read(ref, 0, ref.size)).toEqual(original); await expect(staging.reclaim(ref)).rejects.toThrow('CLOUD_NOT_VERIFIED');
});
it('scope abort during a cache write never publishes a late local download', async () => {
  const {disk} = setup(); const bytes = encode('cancel cache publication'), file = describe(bytes), controller = new AbortController(); const write = disk.write.bind(disk);
  disk.write = async (account, key, value) => {await write(account, key, value); if (key.startsWith('cache/') && key.includes('/part/')) controller.abort();};
  const cache = new FileCache(disk); const transfer = new FileTransfer({async read(_account, _hash, offset, length) {return bytes.slice(offset, offset + length);}}, cache, disk);
  await expect(transfer.ensureLocal('a', file, controller.signal)).rejects.toMatchObject({name: 'AbortError'}); expect(await cache.has('a', file.sha256)).toBe(false);
});
