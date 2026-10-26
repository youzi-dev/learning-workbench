import {catalogSchemas} from '../../workbench/catalog';
import {catalog} from '../../workbench/catalog-ui';
import {createHost} from '../../workbench/host';
import {migrateV1} from '../../workbench/storage/migration';
import {canonical} from '../../workbench/storage/repository';
import {openRepository} from './repository';
import {browserModuleSettings, createBrowserPorts} from './ports';
import {BrowserFileStorage} from './file-storage';
import {createBrowserFilePicker} from './file-picker';
import {browserProtectedInputs} from './protected-inputs';
import {saveBrowserBackup} from './save';
/** Inspect only: abort creation of a missing v1 database, never upgrade or normalize it. */
export async function legacyBrowserSnapshot(factory: IDBFactory): Promise<Uint8Array | null> {
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = factory.open('growth-workbench'); let absent = false;
    request.onupgradeneeded = () => {absent = true; request.transaction?.abort();};
    request.onerror = () => absent ? resolve(null) : reject(request.error);
    request.onblocked = () => reject(Error('请先关闭其他学习工作台页面，再重新读取记录'));
    request.onsuccess = () => resolve(request.result);
  });
  if (!db) return null;
  try {
    if (db.version > 1) throw Error('原学习库属于未来版本，已保留原库，请使用更新的工作台打开');
    if (!db.objectStoreNames.contains('document')) throw Error('原学习库结构无法识别，已保留原库');
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('document', 'readonly'), request = tx.objectStore('document').get('current');
      tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    });
    if (raw === undefined) throw Error('原学习库缺少正式记录，已保留原库');
    canonical(raw); // Refuse lossy snapshots of unsupported structured-clone values.
    return new TextEncoder().encode(JSON.stringify(raw));
  } finally {db.close();}
}
export async function bootBrowserWorkbench(options: {indexedDB?: IDBFactory; storage?: Pick<Storage, 'getItem' | 'setItem'>} = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw Error('当前浏览器不支持本机存储');
  const source = await legacyBrowserSnapshot(factory);
  const repository = await openRepository('local-device', {indexedDB: factory, schemas: catalogSchemas});
  try {
    if (source) await migrateV1(source, repository);
    const host = createHost(catalog, createBrowserPorts(), {repository, settings: browserModuleSettings(options.storage), deviceId: repository.deviceId});
    await host.start(); return {host, repository};
  } catch (cause) {repository.close(); throw cause;}
}

export async function bootBrowserRuntime(options: {indexedDB?: IDBFactory; storage?: import('./session').ProfileStore; sessionStorage?: import('./session').ProfileStore} = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw Error('当前浏览器不支持本机存储');
  const {createWorkbenchRuntime} = await import('../../workbench/runtime');
  const {createBrowserConnection} = await import('./session');
  const source = await legacyBrowserSnapshot(factory);
  let imported = false;
  const fileStorage = await BrowserFileStorage.open({indexedDB: factory});
  const filePicker = createBrowserFilePicker();
  return createWorkbenchRuntime({
    registrations: catalog,
    ports: createBrowserPorts(filePicker),
    resources: {protectedInputs: await browserProtectedInputs(factory), storage: fileStorage, source: filePicker, preview: source => fileStorage.preview(source), saveBackup: saveBrowserBackup},
    settings: browserModuleSettings(options.storage),
    connection: createBrowserConnection({metadata: options.storage ?? localStorage, sessionStorage: options.sessionStorage ?? sessionStorage}),
    async open(accountId, deviceId) {
      const repository = await openRepository(accountId, {indexedDB: factory, schemas: catalogSchemas, deviceId});
      try {if (accountId === 'local-device' && source && !imported) {await migrateV1(source, repository); imported = true;} return repository;}
      catch (cause) {repository.close(); throw cause;}
    },
  });
}
