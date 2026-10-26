import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DurableFileStorage} from '../../workbench/files/storage';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class DiskFileStorage implements DurableFileStorage {
  constructor(private readonly root: string) {mkdirSync(root, {recursive: true, mode: 0o700});}
  private directory(accountId: string): string {
    if (!accountId) throw new Error('INVALID_ACCOUNT');
    const directory = join(this.root, hash(accountId)); mkdirSync(directory, {recursive: true, mode: 0o700}); return directory;
  }
  async read(accountId: string, key: string): Promise<Uint8Array | null> {
    const path = join(this.directory(accountId), hash(key)); return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }
  async size(accountId: string, key: string): Promise<number | null> {
    const path = join(this.directory(accountId), hash(key)); return existsSync(path) ? statSync(path).size : null;
  }
  async readRange(accountId: string, key: string, offset: number, length: number): Promise<Uint8Array | null> {
    const path = join(this.directory(accountId), hash(key)); if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) throw new Error('INVALID_RANGE');
    const bytes = new Uint8Array(length), fd = openSync(path, 'r');
    try {
      let total = 0;
      while (total < length) {const read = readSync(fd, bytes, total, length - total, offset + total); if (!read) throw new Error('FILE_CORRUPT'); total += read;}
    } finally {closeSync(fd);}
    return bytes;
  }
  async write(accountId: string, key: string, bytes: Uint8Array): Promise<void> {
    const directory = this.directory(accountId), path = join(directory, hash(key)), temporary = `${path}.${randomUUID()}.tmp`;
    let fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = -1; renameSync(temporary, path);
      const parent = openSync(directory, 'r'); try {fsyncSync(parent);} finally {closeSync(parent);}
    } catch (error) {if (fd !== -1) closeSync(fd); rmSync(temporary, {force: true}); throw error;}
  }
  async remove(accountId: string, key: string): Promise<void> {rmSync(join(this.directory(accountId), hash(key)), {force: true});}
}
