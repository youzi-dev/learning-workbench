import {sha256 as sha256Hash} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
/** Keys are opaque logical names. Platform implementations hash both account and
 * key; no user-supplied name or URI is used as a filesystem path. */
export interface DurableFileStorage {
  read(accountId: string, key: string): Promise<Uint8Array | null>;
  size?(accountId: string, key: string): Promise<number | null>;
  readRange?(accountId: string, key: string, offset: number, length: number): Promise<Uint8Array | null>;
  write(accountId: string, key: string, bytes: Uint8Array): Promise<void>;
  remove(accountId: string, key: string): Promise<void>;
}
export async function readJson<T>(storage: DurableFileStorage, accountId: string, key: string, fallback: T): Promise<T> {
  const bytes = await storage.read(accountId, key);
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) as T : fallback;
}
export function writeJson(storage: DurableFileStorage, accountId: string, key: string, value: unknown): Promise<void> {
  return storage.write(accountId, key, new TextEncoder().encode(JSON.stringify(value)));
}
export function validateFile(file: {sha256: string; size: number; mime: string}): void {
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1_073_741_824 || typeof file.mime !== 'string' || !file.mime) throw new Error('INVALID_FILE');
}
export const FILE_PART_BYTES = 1_048_576;
export const createFileHasher = () => sha256Hash.create();
export const hashHex = (bytes: Uint8Array): string => bytesToHex(bytes);
export async function sha256(bytes: Uint8Array): Promise<string> {return hashHex(sha256Hash(bytes));}
export async function readParts(storage: DurableFileStorage, account: string, prefix: string, parts: number[], offset: number, length: number): Promise<Uint8Array> {
  const size = parts.reduce((sum, part) => sum + part, 0);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) throw new Error('INVALID_RANGE');
  const bytes = new Uint8Array(length); let start = 0, written = 0;
  for (let index = 0; index < parts.length && written < length; index++) {
    const end = start + parts[index];
    if (end > offset && start < offset + length) {
      const from = Math.max(0, offset - start), count = Math.min(end, offset + length) - Math.max(start, offset);
      const chunk = await readStoredRange(storage, account, `${prefix}/part/${index}`, from, count);
      if (!chunk || chunk.length !== count) throw new Error('FILE_PART_MISSING');
      bytes.set(chunk, written); written += count;
    }
    start = end;
  }
  return bytes;
}
export async function removeParts(storage: DurableFileStorage, account: string, prefix: string, parts: number[]): Promise<void> {
  for (let index = 0; index < parts.length; index++) await storage.remove(account, `${prefix}/part/${index}`);
}
/** Serialize manifest read/modify/write across cache/staging instances sharing a
 * storage adapter. The production owner keeps one adapter per installation. */
const locks = new WeakMap<DurableFileStorage, Map<string, Promise<unknown>>>();
export async function withFileLock<T>(storage: DurableFileStorage, accountId: string, action: () => Promise<T>): Promise<T> {
  let map = locks.get(storage); if (!map) {map = new Map(); locks.set(storage, map);}
  const previous = map.get(accountId) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action); map.set(accountId, result);
  try {return await result;} finally {if (map.get(accountId) === result) map.delete(accountId);}
}

export async function storedSize(storage: DurableFileStorage, account: string, key: string): Promise<number | null> {
  if (storage.size) return storage.size(account, key);
  return (await storage.read(account, key))?.length ?? null;
}
export async function readStoredRange(storage: DurableFileStorage, account: string, key: string, offset: number, length: number): Promise<Uint8Array | null> {
  if (storage.readRange) return storage.readRange(account, key, offset, length);
  const bytes = await storage.read(account, key);
  return bytes?.slice(offset, offset + length) ?? null;
}
