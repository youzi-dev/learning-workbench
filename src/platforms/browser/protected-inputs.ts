import type {ProtectedInputs} from '../../workbench/files/capture-intents';
type Sealed = {key: CryptoKey; iv: Uint8Array; ciphertext: ArrayBuffer; expiresAt: number};
/** Nonextractable per-input keys, never part of entity/backup storage. Expiry is checked on access;
 * cleanup runs when this device next executes, not while its process is off. */
export async function browserProtectedInputs(factory: IDBFactory = indexedDB): Promise<ProtectedInputs> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('workbench-protected-capture-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('inputs');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const read = (key: string) => new Promise<Sealed | undefined>((resolve, reject) => {const request = db.transaction('inputs').objectStore('inputs').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
  const write = (id: string, value?: Sealed) => new Promise<void>((resolve, reject) => {const tx = db.transaction('inputs', 'readwrite', {durability: 'strict'}); const store = tx.objectStore('inputs'); if (value) store.put(value, id); else store.delete(id); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);});
  await new Promise<void>((resolve, reject) => {const tx = db.transaction('inputs', 'readwrite'), request = tx.objectStore('inputs').openCursor(); request.onsuccess = () => {const cursor = request.result; if (!cursor) return; if (cursor.value.expiresAt <= Date.now()) cursor.delete(); cursor.continue();}; tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);});
  const identity = (account: string, id: string) => JSON.stringify([account, id]);
  return {
    async put(account, id, raw, expiresAt) {
      const name = identity(account, id), old = await read(name);
      expiresAt = Math.min(expiresAt, old?.expiresAt ?? Infinity, Date.now() + 86400000);
      if (raw.length > 16384 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Error('INPUT_EXPIRED');
      const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${name}:${expiresAt}`)}, key, new TextEncoder().encode(raw));
      await write(name, {key, iv, ciphertext, expiresAt});
    },
    async get(account, id) {
      const name = identity(account, id), value = await read(name);
      if (!value) return null;
      if (value.expiresAt <= Date.now()) {await write(name); return null;}
      return new TextDecoder().decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(value.iv), additionalData: new TextEncoder().encode(`${name}:${value.expiresAt}`)}, value.key, value.ciphertext));
    },
    remove: (account, id) => write(identity(account, id)),
  };
}
