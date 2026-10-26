import type {CredentialPort} from '../../workbench/contracts/platform';
/** A window/session-only store. Never localStorage, IndexedDB, records or backups. */
export function createBrowserCredentials(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): CredentialPort {
  const memory = new Map<string, string>();
  const keyFor = (key: string) => `workbench-credential:${key}`;
  return {async get(key) {return storage ? storage.getItem(keyFor(key)) : memory.get(key) ?? null;}, async set(key, value) {if (storage) {if (value === null) storage.removeItem(keyFor(key)); else storage.setItem(keyFor(key), value);} else if (value === null) memory.delete(key); else memory.set(key, value);}};
}
