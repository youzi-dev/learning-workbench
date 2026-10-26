import type {BlobDescriptor, FilePort, LocalFileRef} from '../contracts/files';
import {createFileHasher, FILE_PART_BYTES, hashHex, readJson, readParts, removeParts, withFileLock, writeJson, type DurableFileStorage} from './storage';
export type StagedFile = {ref: LocalFileRef; file: BlobDescriptor; cloudVerified: boolean; parts: number[]};
type StagingIndex = Record<string, StagedFile>;
/** A saved staged original is independent of every disposable cache key. */
export class DurableStaging implements FilePort {
  constructor(readonly accountId: string, private readonly storage: DurableFileStorage, private readonly source: Pick<FilePort, 'read'> & Partial<Pick<FilePort, 'import'>>) {}
  async import(): Promise<LocalFileRef[]> {
    if (!this.source.import) throw new Error('FILE_PICKER_UNAVAILABLE');
    const selected = await this.source.import(); const refs: LocalFileRef[] = [];
    for (const ref of selected) refs.push(await this.stage(ref));
    return refs;
  }
  private index(): Promise<StagingIndex> {return readJson(this.storage, this.accountId, 'staging-index', {});}
  async stage(ref: LocalFileRef): Promise<LocalFileRef> {
    if (!ref || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > 1_073_741_824 || !ref.name || !ref.mime) throw new Error('INVALID_FILE');
    if (ref.token.startsWith('stage:')) {await this.descriptor(ref); return ref;}
    const token = `stage:${crypto.randomUUID()}`, parts: number[] = [];
    const sourceHash = createFileHasher(), storedHash = createFileHasher(); let copied = 0;
    // Each source read, durable write and readback stays bounded. No future
    // upload depends on a transient URI or a whole-file ArrayBuffer.
    while (copied < ref.size) {
      const requested = Math.min(FILE_PART_BYTES, ref.size - copied);
      const bytes = await this.source.read(ref, copied, requested);
      if (!bytes.length || bytes.length > requested) throw new Error('SOURCE_SIZE_MISMATCH');
      sourceHash.update(bytes);
      const key = `${token}/part/${parts.length}`;
      await this.storage.write(this.accountId, key, bytes);
      const stored = await this.storage.read(this.accountId, key);
      if (!stored || stored.length !== bytes.length) throw new Error('STAGING_VERIFY_FAILED');
      storedHash.update(stored); parts.push(bytes.length); copied += bytes.length;
    }
    const checksum = hashHex(sourceHash.digest());
    if (hashHex(storedHash.digest()) !== checksum) throw new Error('STAGING_VERIFY_FAILED');
    const file = {sha256: checksum, size: copied, mime: ref.mime}, staged = {...ref, token};
    await withFileLock(this.storage, this.accountId, async () => {
      const index = await this.index(); index[token] = {ref: staged, file, cloudVerified: false, parts};
      await writeJson(this.storage, this.accountId, 'staging-index', index);
    });
    return staged;
  }
  async read(ref: LocalFileRef, offset: number, length: number): Promise<Uint8Array> {
    const entry = (await this.index())[ref.token];
    if (!entry) throw new Error('STAGED_FILE_NOT_FOUND');
    return readParts(this.storage, this.accountId, ref.token, entry.parts, offset, length);
  }
  async descriptor(ref: LocalFileRef): Promise<BlobDescriptor> {
    const entry = (await this.index())[ref.token];
    if (!entry) throw new Error('STAGED_FILE_NOT_FOUND');
    return entry.file;
  }
  async list(): Promise<StagedFile[]> {return Object.values(await this.index());}
  async confirmCloud(ref: LocalFileRef, verified: BlobDescriptor, signal?: AbortSignal): Promise<void> {
    return withFileLock(this.storage, this.accountId, async () => {
      signal?.throwIfAborted();
      const index = await this.index(), entry = index[ref.token];
      signal?.throwIfAborted();
      if (!entry) throw new Error('STAGED_FILE_NOT_FOUND');
      if (entry.file.sha256 !== verified.sha256 || entry.file.size !== verified.size) throw new Error('CLOUD_VERIFY_FAILED');
      entry.cloudVerified = true; await writeJson(this.storage, this.accountId, 'staging-index', index);
    });
  }
  async reclaim(ref: LocalFileRef, signal?: AbortSignal): Promise<void> {
    return withFileLock(this.storage, this.accountId, async () => {
      signal?.throwIfAborted();
      const index = await this.index(), entry = index[ref.token];
      signal?.throwIfAborted();
      if (!entry) return;
      if (!entry.cloudVerified) throw new Error('CLOUD_NOT_VERIFIED');
      for (let index = 0; index < entry.parts.length; index++) {
        signal?.throwIfAborted();
        await this.storage.remove(this.accountId, `${ref.token}/part/${index}`);
      }
      signal?.throwIfAborted();
      delete index[ref.token]; await writeJson(this.storage, this.accountId, 'staging-index', index);
    });
  }
}
