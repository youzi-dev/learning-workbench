import {createBrowserCredentials} from './credentials';
import {createHttpTransport, pairDevice, TransportError} from '../../workbench/sync/transport';
import type {ConnectionProfile, RuntimeConnection} from '../../workbench/runtime';
export type ProfileStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function parseProfile(value: unknown): ConnectionProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('连接设置无法读取');
  const profile = value as ConnectionProfile;
  if (!/^[a-f0-9-]{36}$/i.test(profile.accountId) || !/^[a-f0-9-]{36}$/i.test(profile.deviceId) || typeof profile.baseUrl !== 'string') throw Error('连接设置无法读取');
  const url = new URL(profile.baseUrl);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('请使用安全的服务地址');
  return {accountId: profile.accountId, deviceId: profile.deviceId, baseUrl: url.href.replace(/\/$/, '')};
}
export function blobUrl(profile: ConnectionProfile, path: string): string {
  if ((!path.startsWith('/v1/blobs/') && !/^\/v1\/capture\/(?:inputs|jobs(?:\/[a-fA-F0-9-]{36}\/(?:cancel|retry))?)(?:\?|$)/.test(path)) || path.includes('..') || path.includes('\\') || path.includes('#')) throw new TransportError('INVALID_BLOB_PATH');
  return `${profile.baseUrl.replace(/\/$/, '')}${path}`;
}
export function createBrowserConnection(options: {metadata: ProfileStore; sessionStorage?: ProfileStore; fetch?: typeof fetch}): RuntimeConnection {
  const credentials = createBrowserCredentials(options.sessionStorage), fetcher = options.fetch ?? globalThis.fetch;
  let current: ConnectionProfile | null = null;
  const key = (profile: ConnectionProfile) => JSON.stringify([profile.baseUrl, profile.accountId]);
  return {
    async loadProfile() {const value = options.metadata.getItem('workbench-v2:connection'); current = value === null ? null : parseProfile(JSON.parse(value)); return current;},
    async saveProfile(profile) {current = profile ? parseProfile(profile) : null; if (current) options.metadata.setItem('workbench-v2:connection', JSON.stringify(current)); else options.metadata.removeItem('workbench-v2:connection');},
    async pair(input, deviceId) {
      const result = await pairDevice(input.baseUrl, input.code, input.name, deviceId, fetcher, input.recover);
      const profile = parseProfile({...result, baseUrl: input.baseUrl});
      await credentials.set(key(profile), result.token); return profile;
    },
    transport(profile) {return createHttpTransport({baseUrl: profile.baseUrl, token: () => credentials.get(key(profile)), fetch: fetcher});},
    async clearCredential(accountId) {if (current?.accountId === accountId) await credentials.set(key(current), null);},
    async authorizedFetch(profile, path, init = {}) {
      const token = await credentials.get(key(profile)); if (!token) throw new TransportError('UNAUTHORIZED');
      const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`);
      return fetcher(blobUrl(profile, path), {...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: init.signal ?? AbortSignal.timeout(30_000)});
    },
  };
}
