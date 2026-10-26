import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeFiles} from '../../src/platforms/electron/files';
import {DiskFileStorage} from '../../src/platforms/electron/file-storage';
import {createResourceManager} from '../../src/workbench/files/manager';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
it('native opaque picker stages real disk bytes and preview streams exact cross-part ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-files-')); cleanups.push(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'selected.mp4'), bytes = new Uint8Array(1_048_576 + 17).map((_, index) => index % 251);
  await writeFile(path, bytes);
  const root = join(directory, 'durable');
  const native = createNativeFiles({directory: root, authorize(id) {if (id !== 'account') throw Error('NO_ACCOUNT');}, async pick() {return [path];}});
  cleanups.push(() => native.close());
  const source = {import: () => native.pick(), async stage(ref: any) {return ref;}, read: (ref: any, offset: number, length: number) => native.readSource(ref, offset, length)};
  const controller = new AbortController();
  const manager = createResourceManager({accountId: 'account', storage: new DiskFileStorage(root), source, signal: controller.signal,
    async preview(source) {const result = await native.preview({accountId: source.accountId, size: source.size, mime: source.mime, keys: source.keys}); return {url: result.url, async release() {native.release(result.token);}};},
  });
  const [ref] = await manager.importFiles(); await manager.bindAsset('asset', ref);
  expect(JSON.stringify(ref)).not.toContain(directory);
  await rm(path);
  const preview = await manager.preview(ref);
  const response = await native.response(new Request(preview.url, {headers: {range: 'bytes=1048573-1048580'}}));
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(`bytes 1048573-1048580/${bytes.length}`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(1048573, 1048581));
  const head = await native.response(new Request(preview.url, {method: 'HEAD'}));
  expect(head.headers.get('content-length')).toBe(String(bytes.length));
  expect((await native.response(new Request(preview.url, {headers: {range: `bytes=${bytes.length}-`}}))).status).toBe(416);
  await preview.release();
  expect((await native.response(new Request(preview.url))).status).toBe(404);
});
