import type {DesktopReminderStatus} from './notifications';
import type {PlatformPorts} from '../../workbench/contracts/platform';
import type {ManagedRepository} from '../../workbench/storage/repository';
import type {ModuleSettingsStore} from '../../workbench/host';
import type {RuntimeConnection} from '../../workbench/runtime';
import type {RepositoryHandle, RpcResult, SerializedResponse} from './session';
export interface ElectronWorkbenchBridge {request(operation: string, args?: unknown[]): Promise<RpcResult>;}
export async function desktopCall<T>(bridge: ElectronWorkbenchBridge, operation: string, args: unknown[] = []): Promise<T> {
  const result = await bridge.request(operation, args);
  if (!result.ok) throw Object.assign(Error(result.error.message), {code: result.error.code});
  return result.value as T;
}
/** Each proxy is permanently bound to its opaque profile handle. Tokens stay in main. */
export function electronRepository(bridge: ElectronWorkbenchBridge, descriptor: RepositoryHandle): ManagedRepository {
  const methods = ['get', 'list', 'commit', 'apply', 'confirmed', 'queue', 'prepare', 'resolveRemote', 'resolutionTarget', 'pending', 'cursor', 'accept', 'conflicts', 'commitResolution', 'recordFailure', 'localBatch', 'importV1', 'migrationStatus', 'recoverySnapshot', 'devicePreferences', 'exportData', 'importData'];
  return Object.assign(Object.fromEntries(methods.map(method => [method, (...args: unknown[]) => desktopCall(bridge, 'repository', [descriptor.handle, method, args])])), {
    readonly: descriptor.readonly, deviceId: descriptor.deviceId,
    // Repository connections belong to the main-process session and close on application exit.
    close() {},
  }) as unknown as ManagedRepository;
}
export function electronModuleSettings(bridge: ElectronWorkbenchBridge): ModuleSettingsStore {
  return {get: id => desktopCall(bridge, 'module-enabled', [id]), set: (id, enabled) => desktopCall(bridge, 'set-module-enabled', [id, enabled])};
}
export function electronConnection(bridge: ElectronWorkbenchBridge): RuntimeConnection {
  return {
    loadProfile: () => desktopCall(bridge, 'load-profile'),
    saveProfile: profile => desktopCall(bridge, 'save-profile', [profile]),
    pair: (input, deviceId) => desktopCall(bridge, 'pair', [input, deviceId]),
    clearCredential: accountId => desktopCall(bridge, 'clear-credential', [accountId]),
    transport(profile) {return {
      handshake: input => desktopCall(bridge, 'sync', [profile, 'handshake', input]),
      push: input => desktopCall(bridge, 'sync', [profile, 'push', input]),
      pull: (cursor, limit) => desktopCall(bridge, 'sync', [profile, 'pull', {cursor, limit}]),
    };},
    async authorizedFetch(profile, path, init = {}) {
      let body: Uint8Array | string | undefined;
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof Uint8Array) body = new Uint8Array(init.body);
      else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
      else if (init.body !== undefined && init.body !== null) throw Error('无法发送此文件内容');
      init.signal?.throwIfAborted();
      const requestId = crypto.randomUUID();
      const cancel = () => {void desktopCall(bridge, 'cancel-fetch', [requestId]).catch(() => {});};
      init.signal?.addEventListener('abort', cancel, {once: true});
      try {
        const result = await desktopCall<SerializedResponse>(bridge, 'fetch', [profile, path, {requestId, method: init.method, headers: [...new Headers(init.headers)], body}]);
        init.signal?.throwIfAborted();
        return new Response([204, 205, 304].includes(result.status) ? null : result.body, {status: result.status, headers: result.headers});
      } catch (cause) {init.signal?.throwIfAborted(); throw cause;}
      finally {init.signal?.removeEventListener('abort', cancel);}
    },
  };
}
export function createElectronPorts(files?: import('../../workbench/contracts/files').FilePort, bridge?: ElectronWorkbenchBridge): PlatformPorts {
  const unavailable = async (): Promise<never> => {throw Error('工作台尚未接入这项设备功能');};
  const capabilities: Set<import('../../workbench/contracts/platform').Capability> = new Set(files ? ['desktop-project', 'files'] : ['desktop-project']);
  if(bridge)capabilities.add('notifications');
  return {capabilities, files: files ?? {read: unavailable, import: unavailable, stage: unavailable}, credentials: {async get() {return null;}, set: unavailable}, notifications: bridge ? {async permission() {const status=await desktopCall<DesktopReminderStatus>(bridge,'calendar-status');return status.permission==='unavailable'?'denied':'prompt';},async reconcile(accountId,reminders) {await desktopCall(bridge,'calendar-reconcile',[accountId,reminders]);}} : {async permission() {return 'denied';}, reconcile: unavailable}, shares: {async pending() {return [];}, acknowledge: unavailable}};
}
