import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import type {BlobDescriptor, BlobStore, UploadSession} from '../src/workbench/contracts/files';

export const DEFAULT_CHUNK_BYTES = 1_048_576;
export {MAX_BLOB_BYTES, validateBlob} from './blob-descriptor';
import {validateBlob} from './blob-descriptor';
type Manifest = {file: BlobDescriptor; chunkBytes: number; received: number[]; state: 'pending' | 'committed' | 'cancelled'};
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validUpload = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function uploadIdentity(value: string): string {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {fsyncSync(fd);} finally {closeSync(fd);}
}
function atomicJson(path: string, directory: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd);} finally {closeSync(fd);}
  renameSync(temp, path); syncDirectory(directory);
}
/** A single process owns this directory. All filesystem transitions are synchronous,
 * making commit/cancel linearizable; manifests survive process and machine restart. */
export class DiskBlobStore implements BlobStore {
  readonly chunkBytes: number;
  constructor(private readonly root: string, options: {chunkBytes?: number} = {}) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > 8_388_608) throw new Error('INVALID_CHUNK_SIZE');
    mkdirSync(root, {recursive: true, mode: 0o700});
  }
  private accountDirectory(accountId: string): string {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 256) throw new Error('INVALID_ACCOUNT');
    const directory = join(this.root, digest(accountId));
    mkdirSync(directory, {recursive: true, mode: 0o700});
    return directory;
  }
  private session(accountId: string, uploadId: string): {directory: string; manifest: Manifest} {
    if (!validUpload(uploadId)) throw new Error('UPLOAD_NOT_FOUND');
    const directory = join(this.accountDirectory(accountId), `upload-${uploadId}`);
    if (!existsSync(join(directory, 'manifest.json'))) throw new Error('UPLOAD_NOT_FOUND');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest;
    return {directory, manifest};
  }
  private save(directory: string, manifest: Manifest): void {atomicJson(join(directory, 'manifest.json'), directory, manifest);}
  async begin(accountId: string, file: BlobDescriptor): Promise<UploadSession> {
    validateBlob(file);
    const account = this.accountDirectory(accountId);
    const uploadId = uploadIdentity(JSON.stringify([file.sha256, file.size, file.mime]));
    const directory = join(account, `upload-${uploadId}`);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    let manifest: Manifest;
    if (existsSync(join(directory, 'manifest.json'))) {
      manifest = this.session(accountId, uploadId).manifest;
      if (manifest.state === 'cancelled') manifest = {file, chunkBytes: this.chunkBytes, received: [], state: 'pending'};
    } else manifest = {file, chunkBytes: this.chunkBytes, received: [], state: 'pending'};
    this.save(directory, manifest);
    syncDirectory(account);
    return {uploadId, chunkBytes: manifest.chunkBytes, received: [...manifest.received]};
  }
  async putChunk(accountId: string, uploadId: string, index: number, bytes: Uint8Array): Promise<void> {
    const {directory, manifest} = this.session(accountId, uploadId);
    if (manifest.state === 'cancelled') throw new Error('UPLOAD_CANCELLED');
    const count = Math.ceil(manifest.file.size / manifest.chunkBytes);
    const expected = Math.min(manifest.chunkBytes, manifest.file.size - index * manifest.chunkBytes);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || !(bytes instanceof Uint8Array) || bytes.length !== expected) throw new Error('INVALID_CHUNK');
    const path = join(directory, `chunk-${index}`);
    if (manifest.state === 'committed') {
      const saved = await this.read(accountId, manifest.file.sha256, index * manifest.chunkBytes, expected);
      if (digest(saved) !== digest(bytes)) throw new Error('CHUNK_MISMATCH');
      return;
    }
    if (existsSync(path)) {
      if (digest(readFileSync(path)) !== digest(bytes)) throw new Error('CHUNK_MISMATCH');
    } else {
      const temp = `${path}.${randomUUID()}.tmp`; const fd = openSync(temp, 'wx', 0o600);
      try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
      renameSync(temp, path); syncDirectory(directory);
    }
    if (!manifest.received.includes(index)) {manifest.received.push(index); manifest.received.sort((a, b) => a - b); this.save(directory, manifest);}
  }
  private verifyPublished(accountId: string, file: BlobDescriptor): void {
    const path = join(this.accountDirectory(accountId), file.sha256);
    if (!existsSync(path) || !existsSync(`${path}.json`) || statSync(path).size !== file.size) throw new Error('BLOB_CORRUPT');
    const fd = openSync(path, 'r'), hash = createHash('sha256'), chunk = new Uint8Array(DEFAULT_CHUNK_BYTES);
    try {
      let offset = 0;
      while (offset < file.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, file.size - offset), offset);
        if (!count) throw new Error('BLOB_CORRUPT');
        hash.update(chunk.subarray(0, count)); offset += count;
      }
      if (hash.digest('hex') !== file.sha256) throw new Error('BLOB_CORRUPT');
    } finally {closeSync(fd);}
  }
  async commit(accountId: string, uploadId: string): Promise<BlobDescriptor> {
    const {directory, manifest} = this.session(accountId, uploadId);
    if (manifest.state === 'committed') {this.verifyPublished(accountId, manifest.file); return {...manifest.file};}
    if (manifest.state === 'cancelled') throw new Error('UPLOAD_CANCELLED');
    const count = Math.ceil(manifest.file.size / manifest.chunkBytes);
    if (manifest.received.length !== count) throw new Error('UPLOAD_INCOMPLETE');
    const account = this.accountDirectory(accountId), path = join(account, manifest.file.sha256);
    const temp = join(directory, 'assembling.tmp'); const fd = openSync(temp, 'w', 0o600);
    const hash = createHash('sha256'); let size = 0;
    try {
      for (let index = 0; index < count; index++) {
        const chunk = readFileSync(join(directory, `chunk-${index}`));
        if (chunk.length !== Math.min(manifest.chunkBytes, manifest.file.size - size)) throw new Error('SIZE_MISMATCH');
        hash.update(chunk); let written = 0;
        while (written < chunk.length) {
          const count = writeSync(fd, chunk, written, chunk.length - written);
          if (!count) throw new Error('DISK_WRITE_FAILED');
          written += count;
        }
        size += chunk.length;
      }
      if (size !== manifest.file.size) throw new Error('SIZE_MISMATCH');
      if (hash.digest('hex') !== manifest.file.sha256) throw new Error('CHECKSUM_MISMATCH');
      fsyncSync(fd);
    } catch (error) {closeSync(fd); rmSync(temp, {force: true}); throw error;}
    closeSync(fd);
    // Bytes are immutable by hash + size. MIME belongs to each asset/upload receipt.
    if (existsSync(`${path}.json`)) {
      this.verifyPublished(accountId, manifest.file);
      rmSync(temp, {force: true});
    } else {
      renameSync(temp, path); syncDirectory(account);
      atomicJson(`${path}.json`, account, manifest.file);
    }
    manifest.state = 'committed'; this.save(directory, manifest);
    for (let index = 0; index < count; index++) rmSync(join(directory, `chunk-${index}`), {force: true});
    return {...manifest.file};
  }
  async describe(accountId: string, sha256: string): Promise<BlobDescriptor> {
    if (!validHash(sha256)) throw new Error('INVALID_BLOB');
    const path = join(this.accountDirectory(accountId), sha256);
    if (!existsSync(`${path}.json`) || !existsSync(path)) throw new Error('BLOB_NOT_FOUND');
    const file = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as BlobDescriptor;
    if (statSync(path).size !== file.size) throw new Error('BLOB_CORRUPT');
    return file;
  }
  async read(accountId: string, sha256: string, offset: number, length: number): Promise<Uint8Array> {
    const file = await this.describe(accountId, sha256);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > file.size || length > file.size - offset || length > 8_388_608) throw new Error('INVALID_RANGE');
    const fd = openSync(join(this.accountDirectory(accountId), sha256), 'r'); const bytes = new Uint8Array(length);
    try {let total = 0; while (total < length) {const count = readSync(fd, bytes, total, length - total, offset + total); if (!count) throw new Error('BLOB_CORRUPT'); total += count;}} finally {closeSync(fd);}
    return bytes;
  }
  async cancel(accountId: string, uploadId: string): Promise<void> {
    const {directory, manifest} = this.session(accountId, uploadId);
    if (manifest.state === 'committed') return;
    // A crash between publishing the blob and updating the session must not
    // cause cancellation to remove the durable saved object.
    const marker = join(this.accountDirectory(accountId), `${manifest.file.sha256}.json`);
    if (existsSync(marker)) {manifest.state = 'committed'; this.save(directory, manifest); return;}
    manifest.state = 'cancelled'; this.save(directory, manifest);
    for (const index of manifest.received) rmSync(join(directory, `chunk-${index}`), {force: true});
    manifest.received = []; this.save(directory, manifest);
  }
}
