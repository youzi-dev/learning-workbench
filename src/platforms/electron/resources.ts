import type {FilePort} from '../../workbench/contracts/files';
import type {DurableFileStorage} from '../../workbench/files/storage';
import type {ResourceManagerOptions} from '../../workbench/files/manager';
import {desktopCall, type ElectronWorkbenchBridge} from './ports';
import {saveBrowserBackup} from '../browser/save';

export function electronResources(bridge: ElectronWorkbenchBridge): Pick<ResourceManagerOptions, 'source' | 'storage' | 'preview' | 'protectedInputs' | 'exportFile'> & {saveBackup: typeof saveBrowserBackup} {
  const source: FilePort = {
    import: () => desktopCall(bridge, 'pick-files'),
    async stage(ref) {return ref;},
    read: (ref, offset, length) => desktopCall(bridge, 'read-file-source', [ref, offset, length]),
  };
  const storage: DurableFileStorage = {
    read: (accountId, key) => desktopCall(bridge, 'file-storage', ['read', accountId, key]),
    size: (accountId, key) => desktopCall(bridge, 'file-storage', ['size', accountId, key]),
    readRange: (accountId, key, offset, length) => desktopCall(bridge, 'file-storage', ['range', accountId, key, offset, length]),
    write: (accountId, key, bytes) => desktopCall(bridge, 'file-storage', ['write', accountId, key, bytes]),
    remove: (accountId, key) => desktopCall(bridge, 'file-storage', ['remove', accountId, key]),
  };
  return {
    protectedInputs: {
      adopt: (from, to, id) => desktopCall(bridge, 'adopt-capture-input', [from, to, id]),
      put: (account, id, raw, expiresAt) => desktopCall(bridge, 'capture-input', ['put', account, id, raw, expiresAt]),
      get: (account, id) => desktopCall(bridge, 'capture-input', ['get', account, id]),
      remove: (account, id) => desktopCall(bridge, 'capture-input', ['remove', account, id]),
    },
    source, storage, saveBackup: saveBrowserBackup,
    async exportFile(source) {
      source.signal.throwIfAborted();
      const {token} = await desktopCall<{token: string}>(bridge, 'file-preview', [{accountId: source.accountId, keys: source.keys, size: source.size, mime: source.mime}]);
      const revoke = () => {void desktopCall<void>(bridge, 'release-file-preview', [token]);};
      source.signal.addEventListener('abort', revoke, {once: true});
      try {source.signal.throwIfAborted(); await desktopCall<void>(bridge, 'export-file', [token, source.name]); source.signal.throwIfAborted();}
      finally {source.signal.removeEventListener('abort', revoke); await desktopCall<void>(bridge, 'release-file-preview', [token]);}
    },
    async preview(source) {
      source.signal.throwIfAborted();
      const result = await desktopCall<{url: string; token: string}>(bridge, 'file-preview', [{accountId: source.accountId, keys: source.keys, size: source.size, mime: source.mime}]);
      const release = () => desktopCall<void>(bridge, 'release-file-preview', [result.token]);
      if (source.signal.aborted) {await release(); source.signal.throwIfAborted();}
      return {url: result.url, release};
    },
  };
}
