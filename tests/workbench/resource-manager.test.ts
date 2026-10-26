import {afterEach, expect, it} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {BrowserFileStorage} from '../../src/platforms/browser/file-storage';
import {createResourceManager} from '../../src/workbench/files/manager';
import {DiskBlobStore} from '../../server/blob';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const bytes = new TextEncoder().encode('A protected offline original');
async function setup() {
  const indexedDB = new IDBFactory();
  const storage = await BrowserFileStorage.open({indexedDB}); cleanups.push(() => storage.close());
  const controller = new AbortController();
  const ref = {token: 'picked', name: 'original.txt', mime: 'text/plain', size: bytes.length};
  const source = {async import() {return [ref];}, async stage(ref: any) {return ref;}, async read(_ref: any, offset: number, length: number) {return bytes.slice(offset, offset + length);}};
  return {storage, controller, source, accountId: 'local-device', signal: controller.signal};
}
it('persists asset binding and protected bytes across manager restart, independent of cache and picker', async () => {
  const options = await setup();
  const first = createResourceManager(options);
  const [ref] = await first.importFiles();
  const file = await first.bindAsset('asset-1', ref);
  const second = createResourceManager({...options, source: {...options.source, async read() {throw Error('PICKER_GONE');}}});
  const local = await second.localForAsset('asset-1');
  expect(local).toMatchObject({state: 'staged', file});
  if (local.state === 'missing') throw Error('missing original');
  expect(await second.read(local.ref, 0, bytes.length)).toEqual(bytes);
  expect(await second.localForAsset('asset-unknown')).toEqual({state: 'missing'});
});
it('uploads only verified originals and notifies the owning module after commit', async () => {
  const options = await setup();
  const directory = await mkdtemp(join(tmpdir(), 'resource-upload-')); cleanups.push(() => rm(directory, {recursive: true, force: true}));
  const blobs = new DiskBlobStore(directory);
  const first = createResourceManager({...options, blobs});
  const [ref] = await first.importFiles(); const file = await first.bindAsset('asset', ref);
  const callbacks: string[] = [];
  first.onUploaded(async (assetId, verified) => {expect(await blobs.read(options.accountId, verified.sha256, 0, verified.size)).toEqual(bytes); callbacks.push(assetId);});
  await first.flushUploads(); expect(callbacks).toEqual(['asset']);
  expect(await first.localForAsset('asset')).toMatchObject({state: 'staged', file});
});
it('rejects a late read after scope revocation even when storage ignores cancellation', async () => {
  const options = await setup(); const manager = createResourceManager(options);
  const [ref] = await manager.importFiles(); await manager.bindAsset('asset', ref);
  const original = options.storage.readRange.bind(options.storage);
  options.storage.readRange = async (...args) => {const result = await original(...args); options.controller.abort(); return result;};
  await expect(manager.read(ref, 0, bytes.length)).rejects.toMatchObject({name: 'AbortError'});
});
it('copies protected originals only during explicit local adoption and preserves the source', async () => {
  const options = await setup(); const first = createResourceManager(options);
  const [ref] = await first.importFiles(); await first.bindAsset('asset', ref);
  const {adoptResourceFiles} = await import('../../src/workbench/files/manager');
  await adoptResourceFiles(options.storage, 'local-device', 'paired-account', options.signal);
  const paired = createResourceManager({...options, accountId: 'paired-account'});
  const local = await paired.localForAsset('asset');
  expect(local).toMatchObject({state: 'staged'});
  if (local.state === 'missing') throw Error('missing adopted original');
  expect(await paired.read(local.ref, 0, bytes.length)).toEqual(bytes);
  expect(await first.read(ref, 0, bytes.length)).toEqual(bytes);
  const isolated = createResourceManager({...options, accountId: 'other-account'});
  expect(await isolated.localForAsset('asset')).toEqual({state: 'missing'});
});
it('stages explicitly dropped files through bounded reads and keeps them after source disposal', async () => {
  const options = await setup(); const manager = createResourceManager(options);
  const source = new File([bytes], 'dropped.pdf', {type: 'application/pdf'});
  const [ref] = await manager.importFiles([source]);
  await manager.bindAsset('drop', ref);
  expect(await manager.read(ref, 0, bytes.length)).toEqual(bytes);
});
it('releases a preview created by a cancellation-ignoring adapter after scope was revoked', async () => {
  const options = await setup(); let releaseCount = 0;
  let finish: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const manager = createResourceManager({...options, async preview() {
    entered!(); await new Promise<void>(resolve => {finish = resolve;});
    return {url: 'blob:late-preview', async release() {releaseCount++;}};
  }});
  const [ref] = await manager.importFiles();
  const pending = manager.preview(ref);
  await started; options.controller.abort(); finish!();
  await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  expect(releaseCount).toBe(1);
});
