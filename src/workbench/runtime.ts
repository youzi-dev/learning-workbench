import type {Id} from './contracts/data';
import type {ModuleRegistration} from './contracts/module';
import type {PlatformPorts} from './contracts/platform';
import type {SyncTransport} from './contracts/sync';
import {createHost, type ModuleSettingsStore, type WorkbenchHost} from './host';
import {createAccountSession} from './sync/session';
import {createSyncEngine, type SyncEngine, type SyncSnapshot} from './sync/engine';
import {RepositoryError, type ManagedRepository} from './storage/repository';
import type {PairInput} from './ui/account';
import {createResourceManager, adoptResourceFiles, type ResourceManagerOptions} from './files/manager';
import type {ResourcePort} from './contracts/resources';
import {BackupService} from './storage/backup';
import {FileCache} from './files/cache';
import {DurableStaging} from './files/staging';
export type ConnectionProfile = {accountId: Id; deviceId: Id; baseUrl: string};
export interface RuntimeConnection {
  loadProfile(): Promise<ConnectionProfile | null>;
  saveProfile(profile: ConnectionProfile | null): Promise<void>;
  pair(input: PairInput, deviceId: Id): Promise<ConnectionProfile>;
  transport(profile: ConnectionProfile): SyncTransport;
  clearCredential(accountId: Id): Promise<void>;
  authorizedFetch(profile: ConnectionProfile, path: string, init?: RequestInit): Promise<Response>;
}
export type RuntimeHooks = {
  clearCache?(accountId: Id): Promise<void>;
  exportLocal?(accountId: Id, repository: ManagedRepository): Promise<void>;
  deactivate?(accountId: Id): Promise<void>;
  activate?(profile: ConnectionProfile | null, repository: ManagedRepository): Promise<void>;
};
export type RuntimeOptions = {
  registrations: ModuleRegistration[];
  ports: PlatformPorts;
  settings?: ModuleSettingsStore;
  open(accountId: Id, deviceId?: Id): Promise<ManagedRepository>;
  connection: RuntimeConnection;
  hooks?: RuntimeHooks;
  resources?: Pick<ResourceManagerOptions, 'storage' | 'source' | 'preview' | 'exportFile' | 'protectedInputs'> & {saveBackup?(bytes: Uint8Array, name: string): Promise<void>};
  autoSync?: boolean;
  intervalMs?: number;
};
export type RuntimeSnapshot = {host: WorkbenchHost; repository: ManagedRepository; profile: ConnectionProfile | null; engine?: SyncEngine; active: boolean; scope: number; error: string | null; resources?: ResourcePort; backup?: BackupService; saveBackup?(bytes: Uint8Array, name: string): Promise<void>};
export type WorkbenchRuntime = Awaited<ReturnType<typeof createWorkbenchRuntime>>;
/** Shared account composition. Secrets and native resource ownership stay in platform adapters. */
export async function createWorkbenchRuntime(options: RuntimeOptions) {
  let hooks = options.hooks ?? {};
  const repositories = new Set<ManagedRepository>();
  const open = async (accountId: Id, deviceId?: Id) => {const repository = await options.open(accountId, deviceId); repositories.add(repository); return repository;};
  const local = await open('local-device');
  let profile = await options.connection.loadProfile();
  let scope = 0;
  const repository = profile ? await open(profile.accountId, profile.deviceId) : local;
  let snapshot: RuntimeSnapshot;
  let rawEngine: SyncEngine | undefined;
  let scopeAbort = new AbortController();
  let pendingProfile: ConnectionProfile | null | undefined;
  let changing = false, stopped = false, online = true, engineNotification = false;
  let inFlight: Promise<void> | undefined, transition = Promise.resolve();
  let resourceCleanup = async () => {};
  let unsubscribeHost = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {for (const listener of listeners) listener();};
  const clearTimers = () => {clearTimeout(timer); clearInterval(interval); timer = undefined; interval = undefined;};
  async function sync() {
    if (stopped || changing || !online || !snapshot.active || !snapshot.engine) return;
    if (inFlight) return inFlight;
    const activeEngine = rawEngine;
    if (!activeEngine) return;
    const task = activeEngine.sync().finally(() => {if (inFlight === task) inFlight = undefined;});
    inFlight = task; return task;
  }
  function schedule() {
    if (options.autoSync === false || stopped || changing || !online || !snapshot.engine || !snapshot.active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {timer = undefined; void sync().catch(() => {});}, 80);
    (timer as unknown as {unref?(): void}).unref?.();
  }
  async function pauseScope() {
    if (snapshot) await snapshot.host.prepareLeave();
    changing = true;
    scopeAbort.abort(new RepositoryError('scope-changed', '账户已切换，请重新打开文件'));
    clearTimers(); unsubscribeHost(); unsubscribeHost = () => {};
    if (snapshot) await snapshot.host.stop();
    await inFlight?.catch(() => {});
    await resourceCleanup();
    if (snapshot) await hooks.deactivate?.(snapshot.profile?.accountId ?? 'local-device');
  }
  async function compose(repo: ManagedRepository, account: ConnectionProfile | null, active: boolean) {
    const boundScope = ++scope;
    scopeAbort = new AbortController();
    const signal = scopeAbort.signal, accountId = account?.accountId ?? 'local-device';
    const resources = options.resources ? createResourceManager({
      ...options.resources, accountId, signal,
      fetch: account && active ? async (path, init) => {
        signal.throwIfAborted();
        const response = await options.connection.authorizedFetch(account, path, {...init, signal});
        signal.throwIfAborted(); return response;
      } : undefined,
      synchronize: sync,
    }) : undefined;
    resourceCleanup = resources ? () => resources.dispose() : async () => {};
    const host = createHost(options.registrations, {...options.ports, files: resources?.files ?? options.ports.files, resources}, {repository: repo, settings: options.settings});
    let backup: BackupService | undefined;
    if (options.resources) {
      const storage = options.resources.storage, cache = new FileCache(storage);
      const staging = new DurableStaging(accountId, storage, options.resources.source);
      backup = new BackupService(repo, {schemas: host.schemas(), files: {
        async read(file) {
          signal.throwIfAborted();
          const original = (await staging.list()).find(item => item.file.sha256 === file.sha256);
          const ref = original?.ref ?? (await cache.has(accountId, file.sha256) ? cache.reference(accountId, file) : null);
          if (!ref) return null;
          const bytes = new Uint8Array(file.size);
          for (let offset = 0; offset < file.size; offset += 1_048_576) {
            const length = Math.min(1_048_576, file.size - offset);
            bytes.set(await (original ? staging.read(ref, offset, length) : cache.read(ref, offset, length)), offset);
            signal.throwIfAborted();
          }
          return bytes;
        },
        async write(file, bytes) {signal.throwIfAborted(); await resources!.restoreOriginal(file, bytes); signal.throwIfAborted();},
        async restored() {signal.throwIfAborted(); await resources!.bindRestored(await repo.list('library'), id => repo.get({moduleId: 'library', entityId: id})); signal.throwIfAborted(); host.notifyDataChanged();},
      }});
    }
    let engine: SyncEngine | undefined;
    let refreshLocal = async () => {};
    rawEngine = account && active ? createSyncEngine(repo, options.connection.transport(account), {
      schemas: host.schemas(),
      onChange() {engineNotification = true; try {host.notifyDataChanged();} finally {engineNotification = false;}},
    }) : undefined;
    if (rawEngine) {
      const source = rawEngine;
      let status: SyncSnapshot = source.snapshot(), request = 0;
      const subscribers = new Set<() => void>();
      const publish = () => {for (const listener of subscribers) listener();};
      source.subscribe(() => {request++; status = source.snapshot(); publish();});
      const ensureCurrent = () => {
        if (stopped || changing || !snapshot?.active || snapshot.scope !== boundScope) throw new RepositoryError('scope-changed');
      };
      refreshLocal = async () => {
        const current = ++request;
        const [pending, conflicts] = await Promise.all([repo.pending(), repo.conflicts()]);
        if (request !== current) return;
        // Local queue changes must be visible offline without hiding an ongoing
        // sync or a meaningful authentication/connection failure.
        const state = status.state === 'syncing' || status.state === 'failed' ? status.state : conflicts.length ? 'conflict' : pending.length ? 'pending' : 'synced';
        status = {...status, pending: pending.length, conflicts: conflicts.length, state};
        publish();
      };
      engine = {
        snapshot: () => status,
        subscribe(listener) {subscribers.add(listener); return () => {subscribers.delete(listener);};},
        async refresh() {ensureCurrent(); await refreshLocal();},
        async sync() {ensureCurrent(); return sync();},
      };
    }
    const platformSave = options.resources?.saveBackup;
    const saveBackup = platformSave ? async (bytes: Uint8Array, name: string) => {
      const ensure = () => {if (stopped || changing || !snapshot.active || snapshot.scope !== boundScope) throw new RepositoryError('scope-changed', '账户已切换，请在当前账户重新导出备份');};
      ensure(); await platformSave(new Uint8Array(bytes), name); ensure();
    } : undefined;
    snapshot = {host, repository: repo, profile: account, engine, active, scope: boundScope, error: null, resources, backup, saveBackup};
    if (active) await host.start();
    if (active) await hooks.activate?.(account, repo);
    changing = false;
    if (active && resources) void repo.list('library').then(entities => resources.bindRestored(entities, id => repo.get({moduleId: 'library', entityId: id}))).then(() => resources.flushUploads()).catch(() => {});
    unsubscribeHost = host.subscribe(() => {
      if (engineNotification) return;
      void refreshLocal().catch(() => {});
      schedule();
      if (resources) void repo.list('library').then(entities => resources.bindRestored(entities, id => repo.get({moduleId: 'library', entityId: id}))).then(() => online ? resources.flushUploads() : undefined).catch(() => {});
    });
    if (active && engine) {
      await engine.refresh();
      if (options.autoSync !== false) {
        interval = setInterval(() => {void sync().catch(() => {});}, options.intervalMs ?? 20_000);
        (interval as unknown as {unref?(): void}).unref?.();
        schedule();
      }
    }
    emit();
  }
  const notifications = options.ports.capabilities.has('notifications') ? options.ports.notifications : {async permission() {return 'denied' as const;}, async reconcile() {}};
  const accountSession = createAccountSession({
    accountId: profile?.accountId ?? 'local-device', repository, open: id => open(id, pendingProfile?.deviceId ?? profile?.deviceId ?? local.deviceId ?? undefined),
    moduleIds: options.registrations.map(item => item.manifest.id), notifications,
    beforeSwitch: pauseScope,
    clearCache: async id => {
      await hooks.clearCache?.(id);
      if (options.resources) {
        const cache = new FileCache(options.resources.storage);
        for (const entry of await cache.entries(id)) if (entry.local) await cache.removeLocal(id, entry.file.sha256);
      }
    },
    clearCredential: id => options.connection.clearCredential(id),
    exportLocal: async (id, repo) => {
      if (hooks.exportLocal) return hooks.exportLocal(id, repo);
      if (!snapshot.backup || !snapshot.saveBackup) throw new RepositoryError('export-unavailable', '导出功能尚未接通，请保留本机内容');
      const bytes = await snapshot.backup.exportBackup({includeFiles: true});
      await snapshot.saveBackup(bytes, `workbench-${new Date().toISOString().slice(0, 10)}.json`);
    },
    sync,
  });
  const unsubscribeSession = accountSession.subscribe(() => {
    const next = accountSession.snapshot();
    transition = transition.catch(() => {}).then(async () => {
      profile = next.active ? pendingProfile ?? (profile?.accountId === next.accountId ? profile : null) : null;
      pendingProfile = undefined;
      await options.connection.saveProfile(profile);
      await compose(next.repository, profile, next.active);
    }).catch(cause => {changing = false; snapshot = {...snapshot, active: next.active, error: cause instanceof Error ? cause.message : '账户切换未完成'}; emit(); throw cause;});
    void transition.catch(() => {});
  });
  await compose(repository, profile, true);
  async function changeSession(action: () => Promise<void>) {
    await snapshot.host.prepareLeave();
    const previous = snapshot;
    try {await action(); await transition;}
    catch (cause) {
      const current = accountSession.snapshot();
      if (changing && current.repository === previous.repository && current.active === previous.active) {
        try {await compose(previous.repository, previous.profile, previous.active);}
        catch {snapshot = {...snapshot, active: false, error: '账户空间暂时无法恢复，请重新读取'}; emit();}
      } else if (current.repository !== previous.repository) {
        await snapshot.host.stop(); snapshot = {...snapshot, active: false, error: '账户切换尚未完成，请重新连接'}; emit();
      }
      throw cause;
    }
  }
  const session = {
    ...accountSession,
    switchAccount: (accountId: Id) => changeSession(() => accountSession.switchAccount(accountId)),
    adoptLocalProfile: (localId: Id, accountId: Id) => changeSession(async () => {
      if (accountSession.snapshot().accountId !== localId || localId === accountId) throw new RepositoryError('invalid-adoption');
      if (options.resources) await adoptResourceFiles(options.resources.storage, localId, accountId, scopeAbort.signal, options.resources.protectedInputs);
      await accountSession.adoptLocalProfile(localId, accountId);
    }),
    logout: (choice?: 'export' | 'sync' | 'leave') => changeSession(() => accountSession.logout(choice)),
  };
  function ensureFileScope(bound: RuntimeSnapshot) {
    if (stopped || changing || !snapshot.active || snapshot.scope !== bound.scope) throw new RepositoryError('scope-changed', '账户已切换，请在当前账户重新打开文件');
  }
  async function fetchInScope(bound: RuntimeSnapshot, signal: AbortSignal, path: string, init: RequestInit = {}) {
    ensureFileScope(bound);
    const combined = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    combined.throwIfAborted();
    try {
      const response = await options.connection.authorizedFetch(bound.profile!, path, {...init, signal: combined});
      ensureFileScope(bound);
      combined.throwIfAborted();
      return response;
    } catch (cause) {ensureFileScope(bound); throw cause;}
  }
  return {
    session,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    settled: () => transition,
    sync,
    notifyOnline(value = true) {online = value; if (value) {snapshot.host.notifyDataChanged(); schedule(); void snapshot.resources?.flushUploads().catch(() => {});}},
    async pair(input: PairInput) {
      await snapshot.host.prepareLeave();
      if (!snapshot.repository.deviceId) throw new RepositoryError('readonly-schema');
      const next = await options.connection.pair(input, snapshot.repository.deviceId);
      pendingProfile = next;
      try {
        if (session.snapshot().accountId === 'local-device' && input.adoptLocal) {
          await session.adoptLocalProfile('local-device', next.accountId);
        }
        else await session.switchAccount(next.accountId);
        await transition;
      } catch (cause) {pendingProfile = undefined; changing = false; if (!snapshot.active) emit(); throw cause;}
    },
    async setHooks(next: RuntimeHooks) {hooks = {...hooks, ...next}; if (snapshot.active) await next.activate?.(snapshot.profile, snapshot.repository);},
    fileConnection() {
      if (!snapshot.active || !snapshot.profile) throw new RepositoryError('not-connected');
      const bound = snapshot, signal = scopeAbort.signal;
      return {accountId: bound.profile!.accountId, signal, fetch: (path: string, init?: RequestInit) => fetchInScope(bound, signal, path, init)};
    },
    async authorizedFetchFor(accountId: Id, path: string, init?: RequestInit) {
      if (!snapshot.active || snapshot.profile?.accountId !== accountId) throw new RepositoryError('scope-changed');
      return fetchInScope(snapshot, scopeAbort.signal, path, init);
    },
    async authorizedFetch(path: string, init?: RequestInit) {
      if (!snapshot.active || !snapshot.profile) throw new RepositoryError('not-connected', '请先绑定设备');
      return fetchInScope(snapshot, scopeAbort.signal, path, init);
    },
    async stop() {if (stopped) return; await snapshot.host.prepareLeave(); stopped = true; clearTimers(); unsubscribeSession(); await pauseScope(); await transition.catch(() => {}); for (const repo of repositories) repo.close(); listeners.clear();},
  };
}
