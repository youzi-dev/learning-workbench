import type {Id, MutationBatch, PullPage, PushResult} from '../contracts/data';
import type {SyncHello, SyncTransport, SyncWelcome} from '../contracts/sync';
export class TransportError extends Error {constructor(public readonly code: string) {super(code); this.name = 'TransportError';}}
export type DeviceCredential = {accountId: Id; deviceId: Id; token: string};
export type HttpTransportOptions = {baseUrl: string; token: string | (() => Promise<string | null>); fetch?: typeof globalThis.fetch};
function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new TransportError('INVALID_SERVER_URL');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new TransportError('HTTPS_REQUIRED');
  return `${url.href.replace(/\/$/, '')}${path}`;
}
async function request<T>(fetcher: typeof globalThis.fetch, url: string, token: string | null, body?: unknown): Promise<T> {
  const response = await fetcher(url, {method: body === undefined ? 'GET' : 'POST', headers: {...(token ? {authorization: `Bearer ${token}`} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000)});
  const data = await response.json() as T & {error?: string};
  if (!response.ok) throw new TransportError(typeof data.error === 'string' ? data.error : `HTTP_${response.status}`);
  return data;
}
export function createHttpTransport(options: HttpTransportOptions): SyncTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const call = async <T>(path: string, body?: unknown) => request<T>(fetcher, endpoint(options.baseUrl, path), typeof options.token === 'function' ? await options.token() : options.token, body);
  return {handshake: (hello: SyncHello) => call<SyncWelcome>('/v1/sync/handshake', hello), push: (batch: MutationBatch) => call<PushResult>('/v1/sync/push', batch), pull: (cursor, limit) => call<PullPage>(`/v1/sync/pull?cursor=${cursor}&limit=${limit}`)};
}
export async function pairDevice(baseUrl: string, code: string, name: string, deviceId: Id, fetcher = globalThis.fetch, replaceExistingDevice = false): Promise<DeviceCredential> {
  const credential = await request<DeviceCredential>(fetcher, endpoint(baseUrl, '/v1/devices/pair'), null, {code, name, deviceId, ...(replaceExistingDevice ? {replaceExistingDevice: true} : {})});
  if (credential.deviceId !== deviceId || typeof credential.accountId !== 'string' || typeof credential.token !== 'string') throw new TransportError('DEVICE_MISMATCH');
  return credential;
}
