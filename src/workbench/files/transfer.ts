import type {BlobDescriptor, BlobStore, LocalFileRef} from '../contracts/files';
import {FileCache} from './cache';
import {DurableStaging} from './staging';
import {createFileHasher, FILE_PART_BYTES, hashHex, readJson, validateFile, writeJson, type DurableFileStorage} from './storage';
export class FileTransfer {
  private readonly chunkBytes: number;
  private readonly downloads = new Map<string, Promise<LocalFileRef>>();
  constructor(private readonly blobs: Pick<BlobStore, 'read'> & Partial<BlobStore>, private readonly cache: FileCache, private readonly storage: DurableFileStorage, options: {chunkBytes?: number} = {}) {
    this.chunkBytes = options.chunkBytes ?? FILE_PART_BYTES;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > FILE_PART_BYTES) throw new Error('INVALID_CHUNK_SIZE');
  }
  async ensureLocal(accountId: string, file: BlobDescriptor, signal: AbortSignal): Promise<LocalFileRef> {
    validateFile(file); signal.throwIfAborted();
    if (await this.cache.has(accountId, file.sha256)) return this.cache.reference(accountId, file);
    const key = JSON.stringify([accountId, file.sha256]); const current = this.downloads.get(key); if (current) return current;
    const result = this.download(accountId, file, signal); this.downloads.set(key, result);
    try {return await result;} finally {this.downloads.delete(key);}
  }
  private async download(account: string, file: BlobDescriptor, signal: AbortSignal): Promise<LocalFileRef> {
    const prefix = `download/${file.sha256}`;
    const progress = await readJson(this.storage, account, `${prefix}/manifest`, {chunkBytes: this.chunkBytes, received: [] as number[], size: file.size});
    if (progress.size !== file.size) throw new Error('DOWNLOAD_MISMATCH');
    if (!Number.isSafeInteger(progress.chunkBytes) || progress.chunkBytes < 1 || progress.chunkBytes > FILE_PART_BYTES || !Array.isArray(progress.received) || progress.received.some(index => !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(file.size / progress.chunkBytes))) throw new Error('DOWNLOAD_MANIFEST_INVALID');
    const hash = createFileHasher(), count = Math.ceil(file.size / progress.chunkBytes);
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted(); const offset = index * progress.chunkBytes, length = Math.min(progress.chunkBytes, file.size - offset);
      let chunk = progress.received.includes(index) ? await this.storage.read(account, `${prefix}/${index}`) : null;
      if (!chunk || chunk.length !== length) {
        chunk = await this.blobs.read(account, file.sha256, offset, length); signal.throwIfAborted();
        if (chunk.length !== length) throw new Error('DOWNLOAD_SIZE_MISMATCH');
        await this.storage.write(account, `${prefix}/${index}`, chunk);
        if (!progress.received.includes(index)) progress.received.push(index);
        await writeJson(this.storage, account, `${prefix}/manifest`, progress);
      }
      hash.update(chunk);
    }
    if (hashHex(hash.digest()) !== file.sha256) {
      for (const index of progress.received) await this.storage.remove(account, `${prefix}/${index}`);
      await this.storage.remove(account, `${prefix}/manifest`); throw new Error('CHECKSUM_MISMATCH');
    }
    signal.throwIfAborted();
    const storage = this.storage;
    async function* chunks() {
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        const bytes = await storage.read(account, `${prefix}/${index}`);
        if (!bytes) throw new Error('FILE_PART_MISSING');
        yield bytes;
      }
    }
    const ref = await this.cache.putStream(account, file, chunks(), signal);
    signal.throwIfAborted();
    for (const index of progress.received) await this.storage.remove(account, `${prefix}/${index}`);
    await this.storage.remove(account, `${prefix}/manifest`); return ref;
  }
  setPinned(account: string, hash: string, pinned: boolean): Promise<void> {return this.cache.setPinned(account, hash, pinned);}
  removeLocal(account: string, hash: string): Promise<void> {return this.cache.removeLocal(account, hash);}
  async uploadStaged(account: string, ref: LocalFileRef, staging: DurableStaging, signal: AbortSignal): Promise<BlobDescriptor> {
    if (staging.accountId !== account) throw new Error('ACCOUNT_MISMATCH');
    if (!this.blobs.begin || !this.blobs.putChunk || !this.blobs.commit) throw new Error('UPLOAD_UNAVAILABLE');
    signal.throwIfAborted(); const file = await staging.descriptor(ref), session = await this.blobs.begin(account, file);
    for (let index = 0; index < Math.ceil(file.size / session.chunkBytes); index++) {
      signal.throwIfAborted(); if (session.received.includes(index)) continue;
      const offset = index * session.chunkBytes, bytes = await staging.read(ref, offset, Math.min(session.chunkBytes, file.size - offset));
      await this.blobs.putChunk(account, session.uploadId, index, bytes);
    }
    signal.throwIfAborted(); const verified = await this.blobs.commit(account, session.uploadId);
    signal.throwIfAborted();
    await staging.confirmCloud(ref, verified, signal);
    signal.throwIfAborted();
    return verified;
  }
}

/** authorizedFetch is provided by the account connection (or Electron main
 * proxy); this module never reads, returns, or persists a device credential. */
export class HttpBlobStore implements BlobStore {
  constructor(private readonly accountId: string, private readonly authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>) {}
  private checkAccount(accountId: string): void {if (accountId !== this.accountId) throw new Error('ACCOUNT_MISMATCH');}
  private async response(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.authorizedFetch(path, init);
    if (!response.ok) {
      const error = await response.json().catch(() => null) as {error?: string} | null;
      throw new Error(error?.error ?? `BLOB_HTTP_${response.status}`);
    }
    return response;
  }
  async begin(accountId: string, file: BlobDescriptor) {
    this.checkAccount(accountId); validateFile(file);
    const response = await this.response('/v1/blobs/begin', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(file)});
    const session = await response.json() as import('../contracts/files').UploadSession;
    if (!session || typeof session.uploadId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(session.uploadId) || !Number.isSafeInteger(session.chunkBytes) || session.chunkBytes < 1 || session.chunkBytes > 8_388_608 || !Array.isArray(session.received) || session.received.some(index => !Number.isSafeInteger(index) || index < 0)) throw new Error('INVALID_UPLOAD_SESSION');
    return session;
  }
  async putChunk(accountId: string, uploadId: string, index: number, bytes: Uint8Array): Promise<void> {
    this.checkAccount(accountId);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uploadId) || !Number.isSafeInteger(index) || index < 0) throw new Error('INVALID_CHUNK');
    await this.response(`/v1/blobs/uploads/${uploadId}/chunks/${index}`, {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: new Uint8Array(bytes)});
  }
  async commit(accountId: string, uploadId: string): Promise<BlobDescriptor> {
    this.checkAccount(accountId); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uploadId)) throw new Error('INVALID_UPLOAD_SESSION');
    const response = await this.response(`/v1/blobs/uploads/${uploadId}/commit`, {method: 'POST'});
    const file = await response.json() as BlobDescriptor; validateFile(file); return file;
  }
  async read(accountId: string, hash: string, offset: number, length: number): Promise<Uint8Array> {
    this.checkAccount(accountId);
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('INVALID_RANGE');
    const response = await this.response(`/v1/blobs/${hash}?offset=${offset}&length=${length}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length !== length) throw new Error('DOWNLOAD_SIZE_MISMATCH'); return bytes;
  }
  async cancel(accountId: string, uploadId: string): Promise<void> {
    this.checkAccount(accountId); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uploadId)) throw new Error('INVALID_UPLOAD_SESSION');
    await this.response(`/v1/blobs/uploads/${uploadId}/cancel`, {method: 'POST'});
  }
}
