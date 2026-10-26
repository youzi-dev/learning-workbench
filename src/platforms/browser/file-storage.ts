import type {DurableFileStorage} from '../../workbench/files/storage';
/** Binary bytes and manifests live in a separate persistent account-scoped IDB,
 * never in browser object URLs or temporary source file handles. */
export class BrowserFileStorage implements DurableFileStorage {
  private constructor(private readonly db: IDBDatabase) {}
  static async open(options: {indexedDB?: IDBFactory; name?: string} = {}): Promise<BrowserFileStorage> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const request = factory.open(options.name ?? 'growth-workbench-files-v2', 1);
    return new Promise((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(new BrowserFileStorage(request.result));
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('FILE_STORAGE_BLOCKED'));
    });
  }
  private key(accountId: string, key: string): string {if (!accountId) throw new Error('INVALID_ACCOUNT'); return JSON.stringify([accountId, key]);}
  private async blob(accountId: string, key: string): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readonly'), request = tx.objectStore('files').get(this.key(accountId, key));
      request.onsuccess = () => resolve(request.result === undefined ? null : request.result instanceof Blob ? request.result : new Blob([request.result]));
      request.onerror = () => reject(request.error);
    });
  }
  async read(accountId: string, key: string): Promise<Uint8Array | null> {
    const blob = await this.blob(accountId, key); return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
  async size(accountId: string, key: string): Promise<number | null> {return (await this.blob(accountId, key))?.size ?? null;}
  async readRange(accountId: string, key: string, offset: number, length: number): Promise<Uint8Array | null> {
    const blob = await this.blob(accountId, key); if (!blob) return null;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > blob.size) throw new Error('INVALID_RANGE');
    return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  }
  async write(accountId: string, key: string, bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readwrite', {durability: 'strict'});
      tx.objectStore('files').put(new Blob([new Uint8Array(bytes)]), this.key(accountId, key));
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('FILE_WRITE_ABORTED')); tx.onerror = () => {};
    });
  }
  async remove(accountId: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('files', 'readwrite', {durability: 'strict'}); tx.objectStore('files').delete(this.key(accountId, key));
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('FILE_WRITE_ABORTED')); tx.onerror = () => {};
    });
  }
  /** Blob composition retains browser-managed binary backing; no whole-file
   * ArrayBuffer is constructed for a large video or PDF. */
  async preview(source: import('../../workbench/files/manager').FilePreviewSource): Promise<import('../../workbench/contracts/resources').ResourcePreview> {
    const blobs: Blob[] = [];
    let size = 0;
    for (const key of source.keys) {
      source.signal.throwIfAborted();
      const blob = await this.blob(source.accountId, key);
      source.signal.throwIfAborted();
      if (!blob) throw Error('本机原文件分片缺失');
      size += blob.size; blobs.push(blob);
    }
    if (size !== source.size) throw Error('本机原文件大小不匹配');
    const url = URL.createObjectURL(new Blob(blobs, {type: source.mime}));
    return {url, async release() {URL.revokeObjectURL(url);}};
  }
  close(): void {this.db.close();}
}
