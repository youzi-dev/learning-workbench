import type {BlobDescriptor, LocalFileRef} from '../contracts/files';
import {createFileHasher, FILE_PART_BYTES, hashHex, readJson, readParts, removeParts, storedSize, validateFile, withFileLock, writeJson, type DurableFileStorage} from './storage';
export const DEFAULT_CACHE_BYTES = 2 * 1024 ** 3;
export type CacheEntry = {file: BlobDescriptor; local: boolean; pinned: boolean; touchedAt: number; prefix: string; parts: number[]};
type Index = Record<string, CacheEntry>;
export class FileCache {
  private readonly inUse = new Map<string, number>();
  private readonly budget: number;
  private readonly now: () => number;
  constructor(private readonly storage: DurableFileStorage, options: {budgetBytes?: number; now?: () => number} = {}) {
    this.budget = options.budgetBytes ?? DEFAULT_CACHE_BYTES; this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.budget) || this.budget < 0) throw new Error('INVALID_CACHE_BUDGET');
  }
  private index(account: string): Promise<Index> {return readJson(this.storage, account, 'cache-index', {});}
  private useKey(account: string, hash: string): string {return JSON.stringify([account, hash]);}
  private async collectIndex(account: string, index: Index, incoming = 0, keep?: string): Promise<void> {
    let used = Object.values(index).filter(e => e.local).reduce((total, e) => total + e.file.size, 0);
    const candidates = Object.values(index).filter(e => e.local && !e.pinned && e.file.sha256 !== keep && !this.inUse.has(this.useKey(account, e.file.sha256)));
    candidates.sort((a, b) => a.touchedAt - b.touchedAt);
    for (const entry of candidates) {
      if (used + incoming <= this.budget) break;
      await removeParts(this.storage, account, entry.prefix, entry.parts); entry.local = false; used -= entry.file.size;
    }
    await writeJson(this.storage, account, 'cache-index', index);
    if (used + incoming > this.budget) throw new Error('CACHE_SPACE_REQUIRED');
  }
  async collect(accountId: string): Promise<void> {
    return withFileLock(this.storage, accountId, async () => {await this.collectIndex(accountId, await this.index(accountId));});
  }
  async entries(accountId: string): Promise<CacheEntry[]> {return Object.values(await this.index(accountId));}
  async has(accountId: string, hash: string): Promise<boolean> {
    const entry = (await this.index(accountId))[hash]; if (!entry?.local) return false;
    for (let index = 0; index < entry.parts.length; index++) if (await storedSize(this.storage, accountId, `${entry.prefix}/part/${index}`) !== entry.parts[index]) return false;
    return true;
  }
  async put(accountId: string, file: BlobDescriptor, bytes: Uint8Array): Promise<LocalFileRef> {
    async function* chunks() {for (let offset = 0; offset < bytes.length; offset += FILE_PART_BYTES) yield bytes.subarray(offset, offset + FILE_PART_BYTES);}
    return this.putStream(accountId, file, chunks());
  }
  async putStream(accountId: string, file: BlobDescriptor, chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<LocalFileRef> {
    validateFile(file); signal?.throwIfAborted();
    return withFileLock(this.storage, accountId, async () => {
      const index = await this.index(accountId), old = index[file.sha256]; signal?.throwIfAborted();
      await this.collectIndex(accountId, index, old?.local ? 0 : file.size, file.sha256);
      const prefix = `cache/${file.sha256}/${crypto.randomUUID()}`, parts: number[] = [], hash = createFileHasher(); let size = 0;
      try {
        for await (const input of chunks) for (let offset = 0; offset < input.length; offset += FILE_PART_BYTES) {
          const bytes = input.subarray(offset, offset + FILE_PART_BYTES);
          size += bytes.length; if (size > file.size) throw new Error('SIZE_MISMATCH');
          signal?.throwIfAborted();
          hash.update(bytes); await this.storage.write(accountId, `${prefix}/part/${parts.length}`, bytes); parts.push(bytes.length);
          signal?.throwIfAborted();
        }
        if (size !== file.size || hashHex(hash.digest()) !== file.sha256) throw new Error('CHECKSUM_MISMATCH');
        signal?.throwIfAborted();
        index[file.sha256] = {file, local: true, pinned: old?.pinned ?? false, touchedAt: this.now(), prefix, parts};
        await writeJson(this.storage, accountId, 'cache-index', index);
        if (signal?.aborted) {
          if (old) index[file.sha256] = old; else delete index[file.sha256];
          await writeJson(this.storage, accountId, 'cache-index', index);
          signal.throwIfAborted();
        }
      } catch (error) {await removeParts(this.storage, accountId, prefix, parts).catch(() => {}); throw error;}
      if (old?.local) await removeParts(this.storage, accountId, old.prefix, old.parts);
      return this.reference(accountId, file);
    });
  }
  reference(accountId: string, file: BlobDescriptor): LocalFileRef {
    return {token: `cache:${encodeURIComponent(accountId)}:${file.sha256}`, name: file.sha256, mime: file.mime, size: file.size};
  }
  async read(ref: LocalFileRef, offset: number, length: number): Promise<Uint8Array> {
    const match = /^cache:([^:]+):([a-f0-9]{64})$/.exec(ref.token); if (!match) throw new Error('LOCAL_FILE_NOT_FOUND');
    const account = decodeURIComponent(match[1]), hash = match[2];
    return withFileLock(this.storage, account, async () => {
      const index = await this.index(account), entry = index[hash];
      if (!entry?.local) throw new Error('LOCAL_FILE_NOT_FOUND');
      const bytes = await readParts(this.storage, account, entry.prefix, entry.parts, offset, length);
      entry.touchedAt = this.now(); await writeJson(this.storage, account, 'cache-index', index); return bytes;
    });
  }
  async setPinned(accountId: string, hash: string, pinned: boolean): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_FILE');
    return withFileLock(this.storage, accountId, async () => {
      const index = await this.index(accountId);
      index[hash] ??= {file: {sha256: hash, size: 0, mime: 'application/octet-stream'}, local: false, pinned, touchedAt: this.now(), prefix: '', parts: []};
      index[hash].pinned = pinned; await writeJson(this.storage, accountId, 'cache-index', index);
    });
  }
  async removeLocal(accountId: string, hash: string): Promise<void> {
    return withFileLock(this.storage, accountId, async () => {
      if (this.inUse.has(this.useKey(accountId, hash))) throw new Error('FILE_IN_USE');
      const index = await this.index(accountId), entry = index[hash];
      if (entry) {
        await removeParts(this.storage, accountId, entry.prefix, entry.parts);
        entry.local = false; entry.pinned = false; await writeJson(this.storage, accountId, 'cache-index', index);
      }
    });
  }
  async acquire(accountId: string, hash: string): Promise<() => Promise<void>> {
    return withFileLock(this.storage, accountId, async () => {
      if (!await this.has(accountId, hash)) throw new Error('LOCAL_FILE_NOT_FOUND');
      const key = this.useKey(accountId, hash); this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1); let released = false;
      return async () => {
        if (released) return; released = true;
        const count = this.inUse.get(key)! - 1; if (count) this.inUse.set(key, count); else this.inUse.delete(key);
      };
    });
  }
}
