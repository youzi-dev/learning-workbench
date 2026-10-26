import type {CredentialPort} from '../../workbench/contracts/platform';
export type SafeStoragePort = {isEncryptionAvailable(): boolean; encryptString(value: string): Uint8Array; decryptString(value: Uint8Array): string; getSelectedStorageBackend?(): string};
export type EncryptedCredentialStore = {read(key: string): Promise<Uint8Array | null>; write(key: string, value: Uint8Array | null): Promise<void>};
/** Main-process only: inject Electron safeStorage plus an account-scoped disk store. */
export function createElectronCredentials(safeStorage: SafeStoragePort, store: EncryptedCredentialStore): CredentialPort {
  const ready = () => {if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw Object.assign(Error('系统安全存储不可用'), {code: 'SECURE_STORAGE_UNAVAILABLE'});};
  return {async get(key) {ready(); const value = await store.read(key); return value === null ? null : safeStorage.decryptString(value);}, async set(key, value) {ready(); await store.write(key, value === null ? null : safeStorage.encryptString(value));}};
}
