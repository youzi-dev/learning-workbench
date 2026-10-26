import type {PlatformPorts} from '../../workbench/contracts/platform';
import type {ModuleSettingsStore} from '../../workbench/host';
export function createBrowserPorts(files?: import('../../workbench/contracts/files').FilePort): PlatformPorts {
  const unavailable = async (): Promise<never> => {throw Error('此设备尚未接入这项功能');};
  return {capabilities: new Set(files ? ['files'] : []), files: files ?? {read: unavailable, import: unavailable, stage: unavailable}, credentials: {async get() {return null;}, set: unavailable}, notifications: {async permission() {return 'denied';}, reconcile: unavailable}, shares: {async pending() {return [];}, acknowledge: unavailable}};
}
/** Device-only preferences, outside synced business records. Storage failures are surfaced. */
export function browserModuleSettings(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): ModuleSettingsStore {
  return {async get(id) {const value = storage.getItem(`workbench-v2:module:${id}`); if (value === null) return null; if (value !== 'true' && value !== 'false') throw Error('模块偏好无法读取，请检查浏览器存储'); return value === 'true';}, async set(id, enabled) {storage.setItem(`workbench-v2:module:${id}`, String(enabled));}};
}
