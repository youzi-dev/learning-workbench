import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createElectronCredentials, type SafeStoragePort} from './credentials';
import {bootElectronWorkbench} from './boot';
import {openRepository} from './repository';
import {catalogSchemas} from '../../workbench/catalog';
import {createHttpTransport, pairDevice, TransportError} from '../../workbench/sync/transport';
import {blobUrl, parseProfile} from '../browser/session';
import {RepositoryError, type ManagedRepository} from '../../workbench/storage/repository';
import type {ConnectionProfile} from '../../workbench/runtime';
import type {PairInput} from '../../workbench/ui/account';
import type {Id} from '../../workbench/contracts/data';
import type {SyncHello} from '../../workbench/contracts/sync';
import {createNativeFiles} from './files';
import {createDesktopCalendarReminders} from './notifications';
import type {DesktopNotificationNative} from './notifications';
import type {LocalFileRef} from '../../workbench/contracts/files';
import type {FilePreviewSource} from '../../workbench/files/manager';
export type RepositoryHandle = {handle: string; deviceId: Id | null; readonly: boolean};
export const repositoryMethods = ['get', 'list', 'commit', 'apply', 'confirmed', 'queue', 'prepare', 'resolveRemote', 'resolutionTarget', 'pending', 'cursor', 'accept', 'conflicts', 'commitResolution', 'recordFailure', 'localBatch', 'importV1', 'migrationStatus', 'recoverySnapshot', 'devicePreferences', 'exportData', 'importData'] as const;
export type RepositoryMethod = typeof repositoryMethods[number];
export type SerializedFetch = {requestId?: string; method?: string; headers?: [string, string][]; body?: string | Uint8Array};
export type SerializedResponse = {status: number; headers: [string, string][]; body: ArrayBuffer};
export type DesktopSession = Awaited<ReturnType<typeof createDesktopSession>>;
export type RpcResult = {ok: true; value: unknown} | {ok: false; error: {code: string; message: string}};
export async function createDesktopSession(options: {directory: string; safeStorage: SafeStoragePort; fetch?: typeof fetch; pickFiles?: () => Promise<string[]>; saveFile?: (name: string) => Promise<string | null>; calendar?: {native: DesktopNotificationNative; enabled(): Promise<boolean>; focus?(): void}}) {
  const requests = new Map<string, AbortController>();
  const calendar = options.calendar ? createDesktopCalendarReminders(options.calendar) : undefined;
  const revoked = new Set<string>();
  const root = join(options.directory, 'workbench-v2'), profileFile = join(root, 'connection.json');
  const key = (profile: ConnectionProfile) => JSON.stringify([profile.baseUrl, profile.accountId]);
  async function atomic(file: string, value: Uint8Array | string) {
    await mkdir(join(root, 'credentials'), {recursive: true, mode: 0o700});
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {await writeFile(temporary, value, {mode: 0o600}); await rename(temporary, file);} finally {await rm(temporary, {force: true});}
  }
  const credentials = createElectronCredentials(options.safeStorage, {
    async read(id) {try {return new Uint8Array(await readFile(join(root, 'credentials', createHash('sha256').update(id).digest('hex'))));} catch (cause) {if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause;}},
    async write(id, value) {const file = join(root, 'credentials', createHash('sha256').update(id).digest('hex')); if (value === null) await rm(file, {force: true}); else await atomic(file, value);},
  });
  let profile: ConnectionProfile | null = null;
  try {profile = parseProfile(JSON.parse(await readFile(profileFile, 'utf8')));} catch (cause) {if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;}
  const allowed = new Map<string, ConnectionProfile>(); if (profile) allowed.set(profile.accountId, profile);
  const files = createNativeFiles({directory: join(root, 'files'), pick: options.pickFiles, save: options.saveFile, authorize(accountId) {if (accountId !== 'local-device' && !allowed.has(accountId)) throw new RepositoryError('profile-unavailable');}});
  const local = await bootElectronWorkbench(options.directory);
  const repositories = new Map<string, {repository: ManagedRepository; accountId: string}>();
  const profiles = new Map<string, RepositoryHandle>();
  function register(accountId: string, repository: ManagedRepository): RepositoryHandle {const descriptor = {handle: randomUUID(), deviceId: repository.deviceId, readonly: repository.readonly}; repositories.set(descriptor.handle, {repository, accountId}); profiles.set(accountId, descriptor); return descriptor;}
  const localHandle = register('local-device', local);
  const check = (candidate: ConnectionProfile) => {const valid = parseProfile(candidate), trusted = allowed.get(valid.accountId); if (!trusted || key(trusted) !== key(valid) || trusted.deviceId !== valid.deviceId) throw new RepositoryError('profile-unavailable'); return trusted;};
  const transport = (candidate: ConnectionProfile) => {const valid = check(candidate); return createHttpTransport({baseUrl: valid.baseUrl, token: () => credentials.get(key(valid)), fetch: options.fetch});};
  const calendarEntry = (handle: string) => {const entry=repositories.get(handle);if(!entry || revoked.has(entry.accountId) || entry.accountId!==(profile?.accountId??'local-device'))throw new RepositoryError('profile-unavailable');return entry;};
  const requireCalendar = () => {if(!calendar)throw new RepositoryError('notifications-unavailable');return calendar;};
  const knownAccount = (accountId: string) => {if(accountId!=='local-device'&&!allowed.has(accountId))throw new RepositoryError('profile-unavailable');};
  return {
    async calendarBind(handle: string) {const entry=calendarEntry(handle);return requireCalendar().bind({...entry,current:()=>repositories.get(handle)===entry&&!revoked.has(entry.accountId)&&entry.accountId===(profile?.accountId??'local-device')});},
    calendarStop(accountId: string) {knownAccount(accountId);requireCalendar().stop(accountId);},
    calendarStatus: () => requireCalendar().status(),
    async calendarRetry() {await requireCalendar().retry();return requireCalendar().status();},
    resumeCalendarReminders: () => calendar?.resume(),
    async calendarSettingsChange<T>(action: () => Promise<T>): Promise<T> {const repository=profile ? repositories.get(profiles.get(profile.accountId)?.handle??'')?.repository : local;return calendar&&repository?calendar.mutation(repository,action):action();},
    learningRepository(handle: string): ManagedRepository {const entry = repositories.get(handle); if (!entry || entry.accountId !== (profile?.accountId ?? 'local-device')) throw new RepositoryError('profile-unavailable'); return entry.repository;},
    async adoptCaptureInput(from: string, to: string, id: string) {
      if (from !== 'local-device' || profile !== null || !allowed.has(to) || revoked.has(to) || !/^[a-f0-9-]{36}$/.test(id)) throw new RepositoryError('profile-unavailable');
      const saved = await credentials.get(`paste-input:${from}:${id}`);
      if (!saved) return false;
      const item = JSON.parse(saved) as {raw: string; expiresAt: number};
      if (item.expiresAt <= Date.now()) {await credentials.set(`paste-input:${from}:${id}`, null); return false;}
      const target = `paste-input:${to}:${id}`;
      if (!await credentials.get(target)) await credentials.set(target, saved);
      return true;
    },
    async captureInput(operation: string, account: string, id: string, raw?: string, deadline?: number) {
      if (account !== (profile?.accountId ?? 'local-device') || revoked.has(account) || !/^[a-f0-9-]{36}$/.test(id)) throw new RepositoryError('profile-unavailable');
      const name = `paste-input:${account}:${id}`;
      const saved = await credentials.get(name);
      const item = saved ? JSON.parse(saved) as {raw: string; expiresAt: number} : null;
      if (operation === 'remove') {await credentials.set(name, null); return null;}
      if (operation === 'get') {
        if (!item || item.expiresAt <= Date.now()) {await credentials.set(name, null); return null;}
        return item.raw;
      }
      if (operation !== 'put' || typeof raw !== 'string' || raw.length > 16384 || !Number.isFinite(deadline)) throw new RepositoryError('invalid-operation');
      const expiresAt = Math.min(deadline!, item?.expiresAt ?? Infinity, Date.now() + 86400000);
      if (expiresAt <= Date.now()) throw new RepositoryError('INPUT_EXPIRED');
      await credentials.set(name, JSON.stringify({raw, expiresAt})); return null;
    },
    pickFiles: () => files.pick(),
    readFileSource: (ref: LocalFileRef, offset: number, length: number) => files.readSource(ref, offset, length),
    fileStorage: (operation: string, accountId: string, key: string, value?: Uint8Array | number, length?: number) => files.storage(operation, accountId, key, value, length),
    filePreview: (source: Omit<FilePreviewSource, 'signal'>) => files.preview(source),
    exportFile: (token: string, name: string) => files.export(token, name),
    releaseFilePreview: (token: string) => files.release(token),
    fileResponse: (request: Request) => files.response(request),
    async initialize() {return {profile, local: localHandle};},
    async loadProfile() {return profile;},
    async saveProfile(next: ConnectionProfile | null) {if (next) {const valid = check(next); calendar?.stop(); await atomic(profileFile, JSON.stringify(valid)); profile = valid;} else {calendar?.stop();await rm(profileFile, {force: true}); profile = null;}},
    async pair(input: PairInput, deviceId: Id): Promise<ConnectionProfile> {
      if (deviceId !== local.deviceId) throw new RepositoryError('device-mismatch');
      await credentials.get('__availability__'); // Check OS security before consuming a one-time pairing code.
      const result = await pairDevice(input.baseUrl, input.code, input.name, deviceId, options.fetch ?? fetch, input.recover);
      const next = parseProfile({...result, baseUrl: input.baseUrl});
      await credentials.set(key(next), result.token); allowed.set(next.accountId, next); revoked.delete(next.accountId); return next;
    },
    async openProfile(accountId: Id, deviceId?: Id): Promise<RepositoryHandle> {
      const existing = profiles.get(accountId);
      if (existing) {if (deviceId && existing.deviceId !== deviceId) throw new RepositoryError('device-mismatch'); return existing;}
      const valid = allowed.get(accountId); if (!valid || (deviceId && deviceId !== valid.deviceId)) throw new RepositoryError('profile-unavailable');
      return register(accountId, await openRepository(accountId, {directory: root, schemas: catalogSchemas, deviceId: valid.deviceId}));
    },
    async repositoryCall(handle: string, method: string, args: unknown[]): Promise<unknown> {
      const entry = repositories.get(handle);
      if (!entry) throw new RepositoryError('profile-unavailable');
      if (!repositoryMethods.includes(method as RepositoryMethod) || !Array.isArray(args) || typeof (entry.repository as unknown as Record<string, unknown>)[method] !== 'function') throw new RepositoryError('invalid-operation');
      const action = (entry.repository as unknown as Record<string, (...input: unknown[]) => Promise<unknown>>)[method];
      const invoke=()=>action.apply(entry.repository,args);
      return calendar && ['commit','apply','resolveRemote','accept','commitResolution','importV1','importData'].includes(method) ? calendar.mutation(entry.repository,invoke) : invoke();
    },
    async sync(candidate: ConnectionProfile, operation: string, input: unknown) {
      const adapter = transport(candidate);
      if (operation === 'handshake') return adapter.handshake(input as SyncHello);
      if (operation === 'push') return adapter.push(input as Parameters<typeof adapter.push>[0]);
      if (operation === 'pull') {const {cursor, limit} = input as {cursor: number; limit: number}; return adapter.pull(cursor, limit);}
      throw new RepositoryError('invalid-operation');
    },
    async clearCredential(accountId: Id) {calendar?.stop(accountId);if(accountId!=='local-device')revoked.add(accountId);files.revoke(accountId); const valid = allowed.get(accountId); if (valid) await credentials.set(key(valid), null);},
    async authorizedFetch(candidate: ConnectionProfile, path: string, init: SerializedFetch = {}): Promise<SerializedResponse> {
      const valid = check(candidate), controller = new AbortController();
      if (init.requestId) {
        if (!/^[a-f0-9-]{36}$/i.test(init.requestId) || requests.has(init.requestId)) throw new RepositoryError('invalid-request');
        requests.set(init.requestId, controller);
      }
      try {
        const token = await credentials.get(key(valid));
        if (!token) throw new TransportError('UNAUTHORIZED');
        const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`);
        const body = init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        signal.throwIfAborted();
        const response = await (options.fetch ?? fetch)(blobUrl(valid, path), {method: init.method, headers, body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal});
        const bytes = await response.arrayBuffer();
        signal.throwIfAborted();
        return {status: response.status, headers: [...response.headers], body: bytes};
      } finally {if (init.requestId) requests.delete(init.requestId);}
    },
    async cancelFetch(requestId: string) {requests.get(requestId)?.abort();},
    close() {
      calendar?.quit();
      files.close();
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      for (const {repository} of repositories.values()) repository.close();
      repositories.clear(); profiles.clear();
    },
  };
}
/** The only generic IPC entry: explicit operation list and safe serialized errors. */
export async function desktopRequest(session: DesktopSession, operation: string, args: unknown[]): Promise<RpcResult> {
  try {
    if (!Array.isArray(args)) throw new RepositoryError('invalid-operation');
    let value: unknown;
    if (operation.startsWith('calendar-')) {
      if(operation==='calendar-bind'&&args.length===1&&typeof args[0]==='string'&&/^[a-f0-9-]{36}$/i.test(args[0]))value=await session.calendarBind(args[0]);
      else if(operation==='calendar-stop'&&args.length===1&&typeof args[0]==='string')value=session.calendarStop(args[0]);
      else if(operation==='calendar-reconcile'&&args.length===2&&typeof args[0]==='string'&&Array.isArray(args[1])&&args[1].length===0)value=session.calendarStop(args[0]);
      else if(operation==='calendar-status'&&args.length===0)value=session.calendarStatus();
      else if(operation==='calendar-retry'&&args.length===0)value=await session.calendarRetry();
      else throw new RepositoryError('invalid-operation');
    }
    else if (operation === 'adopt-capture-input') value = await session.adoptCaptureInput(args[0] as string, args[1] as string, args[2] as string);
    else if (operation === 'capture-input') value = await session.captureInput(args[0] as string, args[1] as string, args[2] as string, args[3] as string | undefined, args[4] as number | undefined);
    else if (operation === 'pick-files') value = await session.pickFiles();
    else if (operation === 'read-file-source') value = await session.readFileSource(args[0] as LocalFileRef, args[1] as number, args[2] as number);
    else if (operation === 'file-storage') value = await session.fileStorage(args[0] as string, args[1] as string, args[2] as string, args[3] as Uint8Array | number | undefined, args[4] as number | undefined);
    else if (operation === 'file-preview') value = await session.filePreview(args[0] as Omit<FilePreviewSource, 'signal'>);
    else if (operation === 'export-file') value = await session.exportFile(args[0] as string, args[1] as string);
    else if (operation === 'release-file-preview') value = session.releaseFilePreview(args[0] as string);
    else if (operation === 'initialize') value = await session.initialize();
    else if (operation === 'load-profile') value = await session.loadProfile();
    else if (operation === 'save-profile') value = await session.saveProfile(args[0] as ConnectionProfile | null);
    else if (operation === 'pair') value = await session.pair(args[0] as PairInput, args[1] as Id);
    else if (operation === 'open-profile') value = await session.openProfile(args[0] as Id, args[1] as Id | undefined);
    else if (operation === 'repository') value = await session.repositoryCall(args[0] as string, args[1] as string, args[2] as unknown[]);
    else if (operation === 'sync') value = await session.sync(args[0] as ConnectionProfile, args[1] as string, args[2]);
    else if (operation === 'clear-credential') value = await session.clearCredential(args[0] as Id);
    else if (operation === 'fetch') value = await session.authorizedFetch(args[0] as ConnectionProfile, args[1] as string, args[2] as SerializedFetch);
    else if (operation === 'cancel-fetch') value = await session.cancelFetch(args[0] as string);
    else throw new RepositoryError('invalid-operation');
    return {ok: true, value};
  } catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(cause.code) ? cause.code : 'OPERATION_FAILED';
    return {ok: false, error: {code, message: code === 'SECURE_STORAGE_UNAVAILABLE' ? '系统安全存储不可用，无法保存登录状态' : '操作未完成，本机内容已保留'}};
  }
}
