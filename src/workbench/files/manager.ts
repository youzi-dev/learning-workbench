import type {BlobDescriptor, BlobStore, FilePort, LocalFileRef} from '../contracts/files';
import type {ResourcePort, ResourcePreview, LocalAssetFile} from '../contracts/resources';
import type {CaptureJob} from '../../modules/library/model';
import {parseCaptureJob} from '../../modules/library/model';
import type {Entity} from '../contracts/data';
import {CaptureIntents, type ProtectedInputs} from './capture-intents';
import {FileCache} from './cache';
import {DurableStaging} from './staging';
import {FileTransfer, HttpBlobStore} from './transfer';
import {readJson, writeJson, withFileLock, type DurableFileStorage} from './storage';

export type FilePreviewSource = {accountId: string; keys: string[]; size: number; mime: string; signal: AbortSignal};
export type ResourceManagerOptions = {
  protectedInputs?: ProtectedInputs;
  accountId: string;
  signal: AbortSignal;
  storage: DurableFileStorage;
  source: FilePort;
  fetch?: (path: string, init?: RequestInit) => Promise<Response>;
  blobs?: BlobStore;
  synchronize?: () => Promise<void>;
  preview?: (source: FilePreviewSource) => Promise<ResourcePreview>;
  exportFile?: (source: FilePreviewSource & {name: string}) => Promise<void>;
};
type Binding = {ref: LocalFileRef; file: BlobDescriptor; notified: boolean};
type Bindings = Record<string, Binding>;
const bindingKey = 'asset-original-bindings';

/** Account owned byte operations; business records remain owned by modules. */
export function createResourceManager(options: ResourceManagerOptions): ResourcePort & {files: FilePort; restoreOriginal(file: BlobDescriptor, bytes: Uint8Array): Promise<void>; bindRestored(entities: Entity[], current?: (id: string) => Promise<Entity | null>): Promise<void>; dispose(): Promise<void>} {
  const {accountId, signal, storage} = options;
  const check = () => signal.throwIfAborted();
  const intents = new CaptureIntents(accountId, storage, options.protectedInputs, check);
  void intents.expire().catch(() => {});
  const droppedFiles = new Map<string, File>();
  const staging = new DurableStaging(accountId, storage, {
    async read(ref, offset, length) {
      check();
      const dropped = droppedFiles.get(ref.token);
      const bytes = dropped ? new Uint8Array(await dropped.slice(offset, offset + length).arrayBuffer()) : await options.source.read(ref, offset, length);
      check(); return bytes;
    },
    async import() {check(); const refs = await options.source.import(); check(); return refs;},
  });
  const cache = new FileCache(storage);
  const unavailable = async (): Promise<never> => {throw Error('请先连接自己的服务，再获取原文件');};
  const scopedFetch = async (path: string, init?: RequestInit) => {
    check();
    if (!options.fetch) return unavailable();
    const response = await options.fetch(path, {...init, signal});
    check(); return response;
  };
  const blobs = options.blobs ?? (options.fetch ? new HttpBlobStore(accountId, scopedFetch) : {read: unavailable});
  const transfer = new FileTransfer(blobs, cache, storage);
  const listeners = new Set<(assetId: string, file: BlobDescriptor) => Promise<void>>();
  const uploads = new Map<string, Promise<BlobDescriptor>>();
  const previews = new Set<() => Promise<void>>();
  let flushing: Promise<void> | undefined, flushAgain = false;
  const bindingIdentity = (binding: Binding) => JSON.stringify([binding.ref.token, binding.file.sha256, binding.file.size]);
  const bindings = async () => {check(); const result = await readJson<Bindings>(storage, accountId, bindingKey, {}); check(); return result;};
  async function updateBinding(assetId: string, action: (binding: Binding) => void) {
    await withFileLock(storage, accountId, async () => {
      const index = await bindings();
      if (!index[assetId]) throw Error('找不到这份资料的本机原件');
      action(index[assetId]); check(); await writeJson(storage, accountId, bindingKey, index); check();
    });
  }
  async function capture(path: string, input: unknown): Promise<Entity<CaptureJob>> {
    await options.synchronize?.(); check();
    const response = await scopedFetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input)});
    const body = await response.json(); check();
    if (!response.ok) throw Error(body.error ?? '收集暂未完成');
    parseCaptureJob(body.payload);
    await options.synchronize?.(); check();
    return body as Entity<CaptureJob>;
  }
  async function localForAsset(assetId: string, file?: BlobDescriptor): Promise<LocalAssetFile> {
    const index = await bindings(); const binding = index[assetId];
    if (binding && (!file || binding.file.sha256 === file.sha256)) {
      const entry = (await staging.list()).find(item => item.ref.token === binding.ref.token); check();
      if (entry) return {state: 'staged', ref: {...binding.ref}, file: {...binding.file}};
    }
    const descriptor = file ?? binding?.file;
    if (descriptor && await cache.has(accountId, descriptor.sha256)) {
      check(); const entry = (await cache.entries(accountId)).find(item => item.file.sha256 === descriptor.sha256);
      return {state: 'cached', ref: cache.reference(accountId, descriptor), file: descriptor, pinned: entry?.pinned ?? false};
    }
    check(); return {state: 'missing'};
  }
  async function read(ref: LocalFileRef, offset: number, length: number): Promise<Uint8Array> {
    check();
    if (!Number.isSafeInteger(length) || length < 0 || length > 1_048_576) throw Error('单次读取最多 1 MiB');
    const bytes = ref.token.startsWith('stage:') ? await staging.read(ref, offset, length) : await cacheRead(ref, offset, length);
    check(); return bytes;
  }
  async function cacheRead(ref: LocalFileRef, offset: number, length: number) {
    if (!ref.token.startsWith(`cache:${encodeURIComponent(accountId)}:`)) throw Error('这份原文件属于其他账户');
    return cache.read(ref, offset, length);
  }
  async function upload(assetId: string) {
    check();
    const binding = (await bindings())[assetId];
    if (!binding) throw Error('找不到这份资料的本机原件');
    const key = `${assetId}:${bindingIdentity(binding)}`, current = uploads.get(key);
    if (current) return current;
    const work = (async () => {
      const file = await transfer.uploadStaged(accountId, binding.ref, staging, signal);
      check(); return {...file, mime: binding.file.mime};
    })();
    uploads.set(key, work);
    try {return await work;} finally {uploads.delete(key);}
  }
  async function exportFile(ref: LocalFileRef, name: string) {
    check();
    let keys: string[], release: (() => Promise<void>) | undefined;
    if (ref.token.startsWith('stage:')) {
      const entry = (await staging.list()).find(item => item.ref.token === ref.token);
      if (!entry) throw Error('本机原件已缺失');
      keys = entry.parts.map((_, index) => `${ref.token}/part/${index}`);
    } else {
      if (!ref.token.startsWith(`cache:${encodeURIComponent(accountId)}:`)) throw Error('这份原文件属于其他账户');
      const entry = (await cache.entries(accountId)).find(item => cache.reference(accountId, item.file).token === ref.token && item.local);
      if (!entry) throw Error('本机文件已缺失');
      release = await cache.acquire(accountId, entry.file.sha256);
      keys = entry.parts.map((_, index) => `${entry.prefix}/part/${index}`);
    }
    try {
      check();
      const source = {accountId, keys, size: ref.size, mime: ref.mime, signal, name: name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 240) || '资料'};
      if (options.exportFile) await options.exportFile(source);
      else {
        if (!options.preview) throw Error('此设备暂不支持导出文件');
        const download = await options.preview(source);
        try {
          check();
          const anchor = document.createElement('a'); anchor.href = download.url; anchor.download = source.name;
          document.body.append(anchor); anchor.click(); anchor.remove();
          // Browser download consumes the URL asynchronously; retain its source until dispatch.
          await new Promise(resolve => setTimeout(resolve, 1000));
        } finally {await download.release();}
      }
      check();
    } finally {await release?.();}
  }
  const port: ResourcePort = {
    capture: {
      enqueue: (assetId, raw) => intents.enqueue(assetId, raw),
      status: id => intents.status(id),
      flush: moduleSignal => intents.flush(port.capture, moduleSignal),
      start: input => capture('/v1/capture/jobs', input),
      cancel: id => capture(`/v1/capture/jobs/${encodeURIComponent(id)}/cancel`, {}),
      retry: (id, operationId) => capture(`/v1/capture/jobs/${encodeURIComponent(id)}/retry`, {operationId}),
      async input(input) {
        const response = await scopedFetch('/v1/capture/inputs', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input)});
        const body = await response.json(); check();
        if (!response.ok) throw Error(body.error ?? '未能提交临时输入');
        if (typeof body.inputToken !== 'string') throw Error('临时输入响应无法读取');
        return {inputToken: body.inputToken, ...(typeof body.expiresAt === 'string' ? {expiresAt: body.expiresAt} : {})};
      },
    },
    async importFiles(files) {
      check();
      if (!files) {const refs = await staging.import(); check(); return refs;}
      const result: LocalFileRef[] = [];
      for (const file of files) {
        check();
        const token = `drop:${crypto.randomUUID()}`;
        const fallback = ({pdf: 'application/pdf', epub: 'application/epub+zip', md: 'text/markdown', txt: 'text/plain'} as Record<string, string>)[file.name.toLowerCase().split('.').pop() ?? ''];
        droppedFiles.set(token, file);
        try {result.push(await staging.stage({token, name: file.name, size: file.size, mime: file.type || fallback || 'application/octet-stream'})); check();}
        finally {droppedFiles.delete(token);}
      }
      return result;
    },
    async bindAsset(assetId, ref) {
      check(); if (!assetId || assetId.length > 100) throw Error('INVALID_ASSET_ID');
      const file = await staging.descriptor(ref); check();
      await withFileLock(storage, accountId, async () => {
        const index = await bindings();
        index[assetId] = {ref: {...ref}, file, notified: false};
        check(); await writeJson(storage, accountId, bindingKey, index); check();
      });
      return file;
    },
    localForAsset, upload, read, exportFile,
    async setPinned(assetId, file, pinned) {
      check();
      const local = await localForAsset(assetId, file);
      if (local.state === 'staged') throw Error('本机原件已受保护，无需离线保留');
      if (pinned && local.state === 'missing') await transfer.ensureLocal(accountId, file, signal);
      check(); await cache.setPinned(accountId, file.sha256, pinned); check();
    },
    async removeLocal(assetId, file) {
      check();
      if ((await localForAsset(assetId, file)).state === 'staged') throw Error('本机原件受保护，不能作为下载缓存移除');
      check(); await cache.removeLocal(accountId, file.sha256); check();
    },
    async ensureLocal(assetId, file) {
      const existing = await localForAsset(assetId, file);
      if (existing.state !== 'missing') return existing.ref;
      const ref = await transfer.ensureLocal(accountId, file, signal); check(); return ref;
    },
    async preview(ref) {
      check(); if (!options.preview) throw Error('此设备暂不支持原文件预览');
      let keys: string[];
      let releaseCache: (() => Promise<void>) | undefined;
      if (ref.token.startsWith('stage:')) {
        const entry = (await staging.list()).find(item => item.ref.token === ref.token); check();
        if (!entry) throw Error('本机原件已缺失');
        keys = entry.parts.map((_, index) => `${ref.token}/part/${index}`);
      } else {
        if (!ref.token.startsWith(`cache:${encodeURIComponent(accountId)}:`)) throw Error('这份原文件属于其他账户');
        const entry = (await cache.entries(accountId)).find(item => cache.reference(accountId, item.file).token === ref.token && item.local); check();
        if (!entry) throw Error('本机缓存已缺失，请重新获取');
        releaseCache = await cache.acquire(accountId, entry.file.sha256); check();
        keys = entry.parts.map((_, index) => `${entry.prefix}/part/${index}`);
      }
      let result: ResourcePreview | undefined;
      try {result = await options.preview({accountId, keys, size: ref.size, mime: ref.mime, signal}); check();}
      catch (cause) {await result?.release(); await releaseCache?.(); throw cause;}
      let releasing: Promise<void> | undefined;
      const release = () => {
        releasing ??= (async () => {
          try {await result!.release();} finally {await releaseCache?.(); previews.delete(release);}
        })();
        return releasing;
      };
      previews.add(release); if (signal.aborted) {await release(); check();}
      return {url: result!.url, release};
    },
    onUploaded(listener) {check(); listeners.add(listener); return () => {listeners.delete(listener);};},
    async flushUploads() {
      check(); if (!options.fetch && !options.blobs) return;
      if (flushing) {flushAgain = true; return flushing;}
      flushing = (async () => {
        const processed = new Set<string>(), publicationRetries = new Map<string, number>();
        do {
          flushAgain = false;
          const index = await bindings();
          for (const [assetId, binding] of Object.entries(index)) {
            const identity = bindingIdentity(binding), key = `${assetId}:${identity}`;
            check(); if (binding.notified || !listeners.size || processed.has(key)) continue;
            processed.add(key);
            const file = await upload(assetId); check();
            const current = (await bindings())[assetId];
            if (!current || bindingIdentity(current) !== identity || file.sha256 !== binding.file.sha256 || file.size !== binding.file.size) {flushAgain = true; continue;}
            try {
              for (const listener of listeners) {check(); await listener(assetId, file); check();}
            } catch (cause) {
              const code = (cause as {code?: string})?.code;
              if (code === 'ASSET_ORIGINAL_CHANGED') continue;
              if (code === 'stale' && (publicationRetries.get(key) ?? 0) < 3) {
                publicationRetries.set(key, (publicationRetries.get(key) ?? 0) + 1);
                processed.delete(key); flushAgain = true; continue;
              }
              throw cause;
            }
            await updateBinding(assetId, latest => {if (bindingIdentity(latest) === identity) latest.notified = true;});
          }
          const latest = await bindings();
          if (Object.entries(latest).some(([id, binding]) => !binding.notified && !processed.has(`${id}:${bindingIdentity(binding)}`) && listeners.size)) flushAgain = true;
        } while (flushAgain);
      })().finally(() => {flushing = undefined;});
      return flushing;
    },
  };
  signal.addEventListener('abort', () => {listeners.clear(); for (const release of previews) void release();}, {once: true});
  return Object.assign(port, {
    async restoreOriginal(file: BlobDescriptor, bytes: Uint8Array) {
      check();
      const previous = (await staging.list()).find(entry => entry.file.sha256 === file.sha256 && entry.file.size === file.size);
      const restored = previous?.ref ?? await new DurableStaging(accountId, storage, {
        async read(_ref, offset, length) {check(); return bytes.slice(offset, offset + length);},
      }).stage({token: `restore:${file.sha256}`, name: file.sha256, size: file.size, mime: file.mime});
      check();
      const verified = await staging.descriptor(restored);
      if (verified.sha256 !== file.sha256 || verified.size !== file.size) throw Error('CHECKSUM_MISMATCH');
      await withFileLock(storage, accountId, async () => {
        const restoredIndex = await readJson<Record<string, LocalFileRef>>(storage, accountId, 'restored-originals', {});
        restoredIndex[file.sha256] = restored;
        check(); await writeJson(storage, accountId, 'restored-originals', restoredIndex);
      });
    },
    async bindRestored(entities: Entity[], current?: (id: string) => Promise<Entity | null>) {
      check();
      const restored = await readJson<Record<string, LocalFileRef>>(storage, accountId, 'restored-originals', {});
      for (const candidate of entities) {
        await withFileLock(storage, accountId, async () => {
          // Read inside the binding lock so an older reconciliation cannot undo a later choice.
          const entity = current ? await current(candidate.id) : candidate;
          if (!entity || entity.moduleId !== 'library' || entity.kind !== 'library.asset' || entity.schemaVersion !== 1 || entity.deletedAt) return;
          const asset = entity.payload as {sha256?: string; size?: number; mime?: string};
          const ref = asset.sha256 ? restored[asset.sha256] : undefined;
          if (!ref || ref.size !== asset.size) return;
          const index = await bindings(), existing = index[entity.id];
          if (existing?.file.sha256 === asset.sha256 && existing.file.size === asset.size) return;
          const file = await staging.descriptor(ref);
          // Previous staging bytes remain intact; only the currently chosen entity's binding changes.
          index[entity.id] = {ref: {...ref, mime: asset.mime || ref.mime}, file: {...file, mime: asset.mime || file.mime}, notified: false};
          check(); await writeJson(storage, accountId, bindingKey, index);
        });
      }
    },
    files: {
    import: () => port.importFiles(),
    async stage(ref: LocalFileRef) {check(); const staged = await staging.stage(ref); check(); return staged;},
    read,
  }, async dispose() {
    listeners.clear();
    await Promise.all([...previews].map(release => release().catch(() => {})));
    await Promise.all([...uploads.values()].map(upload => upload.catch(() => {})));
    await flushing?.catch(() => {});
  }});
}

/** Explicit local adoption copies protected originals into the target account;
 * the source remains intact. It never mutates library business records. */
export async function adoptResourceFiles(storage: DurableFileStorage, from: string, to: string, signal: AbortSignal, protectedInputs?: ProtectedInputs): Promise<void> {
  signal.throwIfAborted();
  const intents = await readJson<Record<string, import('./capture-intents').CaptureIntent>>(storage, from, 'capture-intents-v1', {});
  const targetIntents = await readJson<Record<string, import('./capture-intents').CaptureIntent>>(storage, to, 'capture-intents-v1', {});
  for (const [id, item] of Object.entries(intents)) if (!targetIntents[id]) {
    signal.throwIfAborted();
    if (item.protected && item.state !== 'submitted') {
      if (protectedInputs?.adopt) {
        if (!await protectedInputs.adopt(from, to, item.operationId)) item.state = 'needs-input';
      } else {
        const raw = item.expiresAt > Date.now() ? await protectedInputs?.get(from, item.operationId) : null;
        if (raw) await protectedInputs!.put(to, item.operationId, raw, item.expiresAt);
        else item.state = 'needs-input';
      }
    }
    targetIntents[id] = item;
  }
  signal.throwIfAborted(); await writeJson(storage, to, 'capture-intents-v1', targetIntents);
  const index = await readJson<Bindings>(storage, from, bindingKey, {}); signal.throwIfAborted();
  const source = new DurableStaging(from, storage, {async read() {throw Error('SOURCE_UNAVAILABLE');}});
  const target = new DurableStaging(to, storage, {async read(ref, offset, length) {signal.throwIfAborted(); const result = await source.read({...ref, token: ref.token.replace(/^adopt:/, '')}, offset, length); signal.throwIfAborted(); return result;}});
  const existing = await readJson<Bindings>(storage, to, bindingKey, {}); signal.throwIfAborted();
  const copied: Bindings = {};
  for (const [id, binding] of Object.entries(index)) {
    if (existing[id]?.file.sha256 === binding.file.sha256) continue;
    // New opaque token forces an account-local copy of the staged original.
    const ref = await target.stage({...binding.ref, token: `adopt:${binding.ref.token}`}); signal.throwIfAborted();
    copied[id] = {...binding, ref, notified: false};
  }
  await withFileLock(storage, to, async () => {
    const existing = await readJson<Bindings>(storage, to, bindingKey, {}); signal.throwIfAborted();
    await writeJson(storage, to, bindingKey, {...copied, ...existing}); signal.throwIfAborted();
  });
}
