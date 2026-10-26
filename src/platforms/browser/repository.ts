import type {Id} from '../../workbench/contracts/data';
import {createRepository, emptyRepositoryState, RepositoryError, TABLES, type RepositoryOptions, type ManagedRepository, type RepositoryDriver, type RepositoryState} from '../../workbench/storage/repository';
export type BrowserRepositoryOptions = RepositoryOptions & {indexedDB?: IDBFactory; name?: string};
export type BrowserRepository = ManagedRepository & {readonly name: string};
function open(factory: IDBFactory, name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    request.onupgradeneeded = () => {for (const table of TABLES) if (!request.result.objectStoreNames.contains(table)) request.result.createObjectStore(table);};
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new RepositoryError('unavailable', 'Close the other workbench window to upgrade storage'));
  });
}
/** Never opens or upgrades the legacy growth-workbench database. */
export async function openRepository(accountId: Id, options: BrowserRepositoryOptions = {}): Promise<BrowserRepository> {
  if (!accountId) throw new RepositoryError('invalid', 'Missing account');
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new RepositoryError('unavailable', 'IndexedDB is unavailable');
  const name = `${options.name ?? 'workbench-v2'}:${encodeURIComponent(accountId)}`;
  let db: IDBDatabase, readonly = false;
  try {db = await open(factory, name, 2);} catch (error) {
    if ((error as DOMException)?.name !== 'VersionError') throw error;
    db = await open(factory, name); readonly = true;
  }
  let closed = false;
  db.onversionchange = () => {closed = true; db.close();};
  function transaction<T>(write: boolean, action: (state: RepositoryState) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed) {reject(new RepositoryError('unavailable', 'Repository is closed')); return;}
      if (write && readonly) {reject(new RepositoryError('readonly-schema', 'Future container is read-only', true)); return;}
      const stores = TABLES.filter(name => db.objectStoreNames.contains(name));
      if (!stores.length) {if (write) reject(new RepositoryError('readonly-schema')); else {try {resolve(action(emptyRepositoryState()));} catch (error) {reject(error);}} return;}
      let tx: IDBTransaction;
      try {tx = db.transaction(stores, write ? 'readwrite' : 'readonly');} catch (error) {reject(error); return;}
      const state = emptyRepositoryState(); let remaining = stores.length, result: T, failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? new RepositoryError(tx.error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable', tx.error?.message));
      tx.onerror = () => {failure ??= tx.error;};
      const abort = (error: unknown) => {failure = error; try {tx.abort();} catch {reject(error);}};
      for (const table of stores) {
        const cursor = tx.objectStore(table).openCursor();
        cursor.onerror = () => abort(cursor.error);
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {state[table][String(item.key)] = item.value; item.continue(); return;}
          if (--remaining) return;
          try {
            const before = structuredClone(state); result = action(state);
            if (write) for (const name of TABLES) {
              const store = tx.objectStore(name);
              for (const key of Object.keys(before[name])) if (!(key in state[name])) store.delete(key);
              for (const [key, value] of Object.entries(state[name])) if (JSON.stringify(before[name][key]) !== JSON.stringify(value)) store.put(value, key);
            }
          } catch (error) {abort(error);}
        };
      }
    });
  }
  const driver: RepositoryDriver = {readonly, read: action => transaction(false, action), write: action => transaction(true, action), close() {if (!closed) {closed = true; db.close();}}};
  try {return Object.assign(await createRepository(driver, options), {name});} catch (error) {driver.close(); throw error;}
}
