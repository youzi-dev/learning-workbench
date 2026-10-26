import type {EntityRef, Id, JsonValue, ModuleId} from './contracts/data';
import type {ModuleContext, ModuleManifest, ModuleRegistration, WorkbenchModule} from './contracts/module';
import type {Capability, PlatformPorts} from './contracts/platform';
import {canonical, RepositoryError, type LocalRepository} from './storage/repository';
import {createReferences} from './references';
import type {ResourcePort} from './contracts/resources';
export interface ModuleSettingsStore {get(id: ModuleId): Promise<boolean | null>; set(id: ModuleId, enabled: boolean): Promise<void>;}
export type HostOptions = {repository?: LocalRepository; settings?: ModuleSettingsStore; deviceId?: Id | null; lifecycleTimeoutMs?: number};
export type ModuleStatus = {id: string; title: string; enabled: boolean; state: 'stopped' | 'starting' | 'ready' | 'failed'; error: string | null; settings: string[]; capabilityExplanations: string[]};
export type NavigationItem = {moduleId: string; id: string; title: string};
export type WorkbenchHost = ReturnType<typeof createHost>;
const capabilityText: Record<Capability, string> = {files: '此设备尚未接入文件导入。', 'share-receive': '此设备尚未接入系统分享接收。', notifications: '此设备尚未接入离线日程提醒。', 'desktop-project': '项目、Docker 与终端适用于桌面客户端。'};
const titleFrom = (manifest: ModuleManifest): string => (manifest as ModuleManifest & {title?: string}).title ?? manifest.id;
const missingRepository: LocalRepository = {async get() {throw Error('尚未连接本机数据');}, async list() {throw Error('尚未连接本机数据');}, async commit() {throw Error('尚未连接本机数据');}, async apply() {throw Error('尚未连接本机数据');}};
export function createHost(registrations: ModuleRegistration[], ports: PlatformPorts, options: HostOptions = {}) {
  const registry = new Map<string, {registration: ModuleRegistration; status: ModuleStatus; module?: WorkbenchModule; controller?: AbortController; queue: Promise<void>}>();
  for (const registration of registrations) {
    const {manifest} = registration;
    if (!manifest.id || registry.has(manifest.id)) throw Error(`模块 ID 重复或为空：${manifest.id}`);
    if (manifest.hostApiVersion !== 1) throw Error(`模块 ${manifest.id} 的宿主 API 不兼容`);
    for (const [kind, schema] of Object.entries(manifest.schemas)) if (!kind || !Number.isSafeInteger(schema.version) || schema.version < 1) throw Error(`模块 ${manifest.id} 的数据版本无效`);
    registry.set(manifest.id, {registration, status: {id: manifest.id, title: titleFrom(manifest), enabled: true, state: 'stopped', error: null, settings: [], capabilityExplanations: manifest.capabilities.filter(cap => !ports.capabilities.has(cap)).map(cap => capabilityText[cap])}, queue: Promise.resolve()});
  }
  const repository = options.repository ?? missingRepository;
  const deviceId = 'deviceId' in repository ? (repository as LocalRepository & {deviceId: Id | null}).deviceId : options.deviceId ?? null;
  const flags = new Map<string, boolean>();
  const settings = options.settings ?? {async get(id: string) {return flags.get(id) ?? null;}, async set(id: string, value: boolean) {flags.set(id, value);}};
  const leaveGuards = new Map<string, Set<() => Promise<void>>>();
  async function prepareLeave(moduleId?: string) {for (const [id, guards] of leaveGuards) if (!moduleId || id === moduleId) for (const guard of [...guards]) await guard();}
  const entityListeners = new Set<(ref: EntityRef) => void>();
  const accountListeners = new Set<() => void>();
  const listeners = new Set<() => void>(); let revision = 0, started = false;
  const changed = () => {revision++; for (const listener of listeners) listener();};
  const referenceLookup = createReferences(repository, () => [...registry.keys()], id => registry.get(id)?.status.enabled ?? false);
  async function openReference(ref: EntityRef, ensure = () => {}) {
    const target = {...ref};
    const check = async () => {
      const entry = requireEntry(target.moduleId);
      if (!entry.status.enabled || entry.status.state !== 'ready') throw Error('关联模块已关闭或暂不可用');
      const item = await referenceLookup.resolve(target);
      if (!item || item.deleted) throw Error('关联条目已删除或暂不可用');
    };
    ensure(); await check(); ensure(); await prepareLeave(); ensure(); await check(); ensure();
    for (const listener of entityListeners) listener(target);
  }
  const references = {...referenceLookup, open: (ref: EntityRef) => openReference(ref)};
  const requireEntry = (id: string) => {const entry = registry.get(id); if (!entry) throw new RepositoryError('unknown-module', '找不到这个模块'); return entry;};
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {let timeout: ReturnType<typeof setTimeout> | undefined; try {return await Promise.race([promise, new Promise<never>((_, reject) => {timeout = setTimeout(() => reject(Error('模块响应超时')), options.lifecycleTimeoutMs ?? 5000);})]);} finally {clearTimeout(timeout);}};
  const fail = (entry: ReturnType<typeof requireEntry>, cause: unknown) => {entry.controller?.abort(); const failed = entry.module; entry.module = undefined; entry.status.state = 'failed'; entry.status.error = cause instanceof Error ? cause.message : String(cause); if (failed) void bounded(Promise.resolve().then(() => failed.stop())).catch(() => {}); changed();};
  function contextFor(id: string, signal: AbortSignal): ModuleContext {
    const ensure = () => {if (signal.aborted || !requireEntry(id).status.enabled) throw new RepositoryError('module-disabled', '模块已停用');};
    const own = (moduleId: string) => {ensure(); if (moduleId !== id) throw new RepositoryError('foreign-module', '请通过引用摘要访问其他模块');};
    const platform: PlatformPorts = {
      environment: ports.environment,
      capabilities: new Set(ports.capabilities),
      files: {
        async read(ref, offset, length) {ensure(); const result = await ports.files.read(ref, offset, length); ensure(); return result;},
        async import() {ensure(); const result = await ports.files.import(); ensure(); return result;},
        async stage(ref) {ensure(); const result = await ports.files.stage(ref); ensure(); return result;},
      },
      credentials: {
        async get(key) {ensure(); return ports.credentials.get(key);},
        async set(key, value) {ensure(); return ports.credentials.set(key, value);},
      },
      notifications: {
        async permission() {ensure(); return ports.notifications.permission();},
        async reconcile(accountId, reminders) {ensure(); return ports.notifications.reconcile(accountId, reminders);},
      },
      shares: {
        async pending() {ensure(); return ports.shares.pending();},
        async acknowledge(deliveryId) {ensure(); return ports.shares.acknowledge(deliveryId);},
      },
    };
    if (ports.resources && requireEntry(id).registration.manifest.capabilities.includes('files')) {
      const resources = ports.resources;
      const guarded = async <T>(action: () => Promise<T>): Promise<T> => {ensure(); const result = await action(); ensure(); return result;};
      const bound: ResourcePort = {
        capture: {
          enqueue: (id, raw) => guarded(() => resources.capture.enqueue(id, raw)),
          status: id => guarded(() => resources.capture.status(id)),
          flush: () => guarded(() => resources.capture.flush(signal)),
          start: input => guarded(() => resources.capture.start(input)),
          cancel: id => guarded(() => resources.capture.cancel(id)),
          retry: (id, operationId) => guarded(() => resources.capture.retry(id, operationId)),
          input: input => guarded(() => resources.capture.input(input)),
        },
        importFiles: files => guarded(() => resources.importFiles(files)),
        bindAsset: (id, ref) => guarded(() => resources.bindAsset(id, ref)),
        localForAsset: (id, file) => guarded(() => resources.localForAsset(id, file)),
        upload: id => guarded(() => resources.upload(id)),
        exportFile: (ref, name) => guarded(() => resources.exportFile(ref, name)),
        setPinned: (id, file, pinned) => guarded(() => resources.setPinned(id, file, pinned)),
        removeLocal: (id, file) => guarded(() => resources.removeLocal(id, file)),
        ensureLocal: (id, file) => guarded(() => resources.ensureLocal(id, file)),
        read: (ref, offset, length) => guarded(() => resources.read(ref, offset, length)),
        async preview(ref) {
          ensure(); const result = await resources.preview(ref);
          try {ensure(); return result;} catch (cause) {await result.release(); throw cause;}
        },
        onUploaded(listener) {
          ensure(); const unsubscribe = resources.onUploaded((id, file) => guarded(() => listener(id, file)));
          signal.addEventListener('abort', unsubscribe, {once: true});
          return () => {signal.removeEventListener('abort', unsubscribe); unsubscribe();};
        },
        flushUploads: () => guarded(() => resources.flushUploads()),
      };
      platform.resources = bound;
    }
    return {deviceId, references: {...references, async open(ref) {await openReference(ref, ensure);}}, platform, async prepareLeave() {ensure(); await prepareLeave(id); ensure();}, registerLeaveGuard(guard) {ensure(); const guards = leaveGuards.get(id) ?? new Set<() => Promise<void>>(); leaveGuards.set(id, guards); guards.add(guard); const cleanup = () => {guards.delete(guard); signal.removeEventListener('abort', cleanup);}; signal.addEventListener('abort', cleanup, {once: true}); return cleanup;}, openAccount() {ensure(); for (const listener of accountListeners) listener();}, ...(id === 'learning' && 'devicePreferences' in repository ? {learningPreferences: {read: async () => {ensure(); const value = await (repository as import('./storage/repository').ManagedRepository).devicePreferences(); ensure(); return value;}}} : {}), async invoke(moduleId, command, input) {ensure(); return invoke(moduleId, command, input);},
      subscribe(listener) {ensure(); const guarded = () => {try {listener();} catch (cause) {fail(requireEntry(id), cause);}}; listeners.add(guarded); const cleanup = () => {listeners.delete(guarded); signal.removeEventListener('abort', cleanup);}; signal.addEventListener('abort', cleanup, {once: true}); return cleanup;},
      repository: {
        async get(ref) {own(ref.moduleId); return repository.get(ref);},
        async list(moduleId) {own(moduleId); return repository.list(moduleId);},
        async apply() {throw new RepositoryError('host-only', '同步由基础服务管理');},
        async commit(batch, localOptions) {
          ensure(); const captured = structuredClone(batch); canonical(captured); const checked = localOptions ? structuredClone(localOptions) : undefined;
          const mutations = [captured, ...(checked?.additionalBatches ?? [])].flatMap(batch => batch.mutations);
          if (checked?.learningPreferences && id !== 'learning') throw new RepositoryError('foreign-module');
          for (const entityId of Object.keys(checked?.expectedLocal ?? {})) if (!mutations.some(m => m.entityId === entityId && m.moduleId === id)) throw new RepositoryError('foreign-module');
          if (!deviceId) throw new RepositoryError('readonly-schema', '设备身份尚未就绪，当前只读');
          for (const mutation of mutations) {
            own(mutation.moduleId);
            const schema = requireEntry(id).registration.manifest.schemas[mutation.kind];
            if (!schema || mutation.schemaVersion !== schema.version) throw new RepositoryError('readonly-schema', '此数据版本需要更新客户端后编辑');
            const current = await repository.get({moduleId: id, entityId: mutation.entityId});
            if (current && (current.schemaVersion > schema.version || current.kind !== mutation.kind)) throw new RepositoryError('readonly-schema', '新版数据已保留，当前只读');
            if (mutation.action === 'put') schema.parse(mutation.payload);
            if (mutation.deviceId !== deviceId) throw new RepositoryError('device-mismatch', '操作的设备身份不匹配');
          }
          ensure(); const receipt = await repository.commit(captured, checked); changed(); return receipt;
        }
      }
    };
  }
  async function activate(id: string) {
    const entry = requireEntry(id); if (!entry.status.enabled || entry.status.state === 'ready') return;
    entry.controller = new AbortController(); const signal = entry.controller.signal;
    entry.status.state = 'starting'; entry.status.error = null; changed();
    try {
      const module = await bounded(entry.registration.load());
      if (signal.aborted) return;
      if (module.manifest.id !== id || module.manifest.hostApiVersion !== 1 || canonical(Object.fromEntries(Object.entries(module.manifest.schemas).map(([kind, schema]) => [kind, schema.version]))) !== canonical(Object.fromEntries(Object.entries(entry.registration.manifest.schemas).map(([kind, schema]) => [kind, schema.version])))) throw Error('加载的模块与注册信息不一致');
      if (new Set(module.navigation.map(route => route.id)).size !== module.navigation.length || module.navigation.some(route => !route.id || !route.title)) throw Error('模块导航 ID 重复或为空');
      entry.module = module; if (!(entry.registration.manifest as ModuleManifest & {title?: string}).title) entry.status.title = module.navigation[0]?.title ?? id; entry.status.settings = [...module.settings];
      await bounded(module.start(contextFor(id, signal), signal));
      if (!signal.aborted) {entry.status.state = 'ready'; changed();}
    } catch (cause) {fail(entry, cause);}
  }
  async function deactivate(id: string) {
    const entry = requireEntry(id); entry.controller?.abort(); entry.status.state = 'stopped'; changed();
    if (entry.module) {try {await bounded(entry.module.stop());} catch (cause) {entry.status.error = cause instanceof Error ? cause.message : String(cause); changed();}}
    entry.module = undefined;
  }
  async function invoke(id: string, command: string, input: JsonValue): Promise<JsonValue> {
    const entry = requireEntry(id);
    if (!entry.status.enabled || entry.controller?.signal.aborted) throw new RepositoryError('module-disabled', '模块已停用');
    if (entry.status.state !== 'ready' || !entry.module) throw new RepositoryError('module-unavailable', entry.status.error ?? '模块尚未就绪');
    if (!Object.hasOwn(entry.module.commands, command)) throw new RepositoryError('unknown-command', '找不到这个操作');
    canonical(input); const result = await entry.module.commands[command](structuredClone(input)); canonical(result); changed(); return structuredClone(result);
  }
  return {
    references, repository,
    notifyDataChanged: changed, prepareLeave,
    registerLeaveGuard(moduleId: string, guard: () => Promise<void>) {
      const controller = requireEntry(moduleId).controller;
      if (!controller || controller.signal.aborted) throw new RepositoryError('module-disabled');
      const guards = leaveGuards.get(moduleId) ?? new Set<() => Promise<void>>();
      leaveGuards.set(moduleId, guards); guards.add(guard);
      const cleanup = () => {guards.delete(guard); controller.signal.removeEventListener('abort', cleanup);};
      controller.signal.addEventListener('abort', cleanup, {once: true}); return cleanup;
    },
    onEntityRequested(listener: (ref: EntityRef) => void) {entityListeners.add(listener); return () => {entityListeners.delete(listener);};},
    onAccountRequested(listener: () => void) {accountListeners.add(listener); return () => {accountListeners.delete(listener);};},
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    snapshot: () => revision,
    modules: () => [...registry.values()].map(entry => ({...entry.status, settings: [...entry.status.settings], capabilityExplanations: [...entry.status.capabilityExplanations]})),
    schemas: () => Object.fromEntries([...registry.values()].map(({registration: {manifest}}) => [manifest.id, Object.fromEntries(Object.entries(manifest.schemas).map(([kind, schema]) => [kind, schema.version]))])),
    navigation: (): NavigationItem[] => [...registry.entries()].flatMap(([moduleId, entry]) => entry.status.enabled && entry.status.state === 'ready' ? (entry.module?.navigation ?? []).map(route => ({moduleId, ...route})) : []),
    async start() {if (started) return; started = true; await Promise.all([...registry.keys()].map(async id => {const entry = requireEntry(id); try {entry.status.enabled = await settings.get(id) ?? true; if (entry.status.enabled) await activate(id);} catch (cause) {fail(entry, cause);}})); changed();},
    async stop() {await prepareLeave(); await Promise.all([...registry.keys()].map(id => {const entry = requireEntry(id); entry.controller?.abort(); entry.queue = entry.queue.catch(() => {}).then(() => deactivate(id)); return entry.queue;})); started = false;},
    async setEnabled(id: ModuleId, enabled: boolean) {const entry = requireEntry(id); entry.queue = entry.queue.catch(() => {}).then(async () => {if (!enabled) await prepareLeave(id); await settings.set(id, enabled); entry.status.enabled = enabled; if (enabled) await activate(id); else await deactivate(id); changed();}); return entry.queue;},
    invoke,
    render(id: string, routeId: string, entityId?: string) {const entry = requireEntry(id); if (!entry.status.enabled || entry.status.state !== 'ready') return null; return entry.module?.render(routeId, entityId);},
    reportRenderError(id: string, cause: unknown) {fail(requireEntry(id), cause);},
  };
}
