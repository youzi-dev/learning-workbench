import type {Id, Entity, MutationBatch} from '../contracts/data';
import {SYNC_MAX_MUTATIONS, SYNC_MAX_BODY_BYTES} from '../contracts/sync';
import type {NotificationPort} from '../contracts/platform';
import {canonical, deterministicId, sourceFingerprint, RepositoryError, type ManagedRepository} from '../storage/repository';
export type SessionOptions = {accountId: Id; repository: ManagedRepository; open(accountId: Id): Promise<ManagedRepository>; moduleIds: string[]; notifications: NotificationPort; clearCache(accountId: Id): Promise<void>; beforeSwitch?(): Promise<void>; clearCredential?(accountId: Id): Promise<void>; exportLocal?(accountId: Id, repository: ManagedRepository): Promise<void>; sync?(): Promise<void>};
export type SessionSnapshot = {accountId: Id; repository: ManagedRepository; active: boolean};
/** Owns account scope, never edits another profile's existing mutations or identity. */
export function createAccountSession(options: SessionOptions) {
  let snapshot: SessionSnapshot = {accountId: options.accountId, repository: options.repository, active: true};
  const listeners = new Set<() => void>(); let queue: Promise<unknown> = Promise.resolve();
  const emit = () => {for (const listener of listeners) listener();};
  const serial = <T>(action: () => Promise<T>): Promise<T> => {const task = queue.catch(() => {}).then(action); queue = task; return task;};
  async function activate(accountId: Id, repository?: ManagedRepository) {
    if (!accountId) throw new RepositoryError('invalid-account');
    const next = repository ?? await options.open(accountId), old = snapshot;
    await options.beforeSwitch?.();
    await options.notifications.reconcile(old.accountId, []);
    await options.clearCache(old.accountId);
    snapshot = {accountId, repository: next, active: true}; emit();
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    switchAccount: (accountId: Id) => serial(() => activate(accountId)),
    logout: (choice?: 'export' | 'sync' | 'leave') => serial(async () => {
      const {accountId, repository} = snapshot;
      if ((await repository.pending()).length || (await repository.conflicts()).length) {
        if (!choice) throw new RepositoryError('pending-logout', '本机还有未同步内容，请导出、继续同步或明确保留并退出');
        if (choice === 'export') {if (!options.exportLocal) throw new RepositoryError('export-unavailable'); await options.exportLocal(accountId, repository);}
        if (choice === 'sync') {if (!options.sync) throw new RepositoryError('sync-unavailable'); await options.sync(); if ((await repository.pending()).length || (await repository.conflicts()).length) throw new RepositoryError('pending-logout');}
      }
      await options.beforeSwitch?.(); await options.notifications.reconcile(accountId, []); await options.clearCache(accountId); await options.clearCredential?.(accountId);
      snapshot = {...snapshot, active: false}; emit();
    }),
    adoptLocalProfile: (localId: Id, accountId: Id) => serial(async () => {
      if (snapshot.accountId !== localId || localId === accountId) throw new RepositoryError('invalid-adoption');
      const source = snapshot.repository, target = await options.open(accountId);
      if (!target.deviceId) throw new RepositoryError('readonly-schema');
      if ((await source.conflicts()).length) throw new RepositoryError('unresolved-local-conflicts', '请先解决本机版本冲突后绑定');
      const entities = sortEntities((await Promise.all(options.moduleIds.map(id => source.list(id)))).flat());
      const tag = `${localId}:${target.deviceId}:${await sourceFingerprint(new TextEncoder().encode(canonical(entities)))}`;
      const plans = adoptionChunks(entities, tag, target.deviceId);
      // Plan and validate every encoded chunk before the first write. One entity
      // larger than the protocol cannot create a poisoned immutable outbox entry.
      for (const plan of plans) {
        const original = await target.localBatch(plan.batch.batchId);
        const pending: Entity[] = [];
        for (const entity of plan.entities) {
          const current = await target.get({moduleId: entity.moduleId, entityId: entity.id});
          const proven = original?.mutations.some(m => m.entityId === entity.id && m.moduleId === entity.moduleId && canonical(m.payload) === canonical(entity.payload));
          if (current) {
            const interruptedDeletion = entity.deletedAt && !current.deletedAt && proven && sameContent({...entity, deletedAt: null}, current);
            if (!sameContent(entity, current) && !interruptedDeletion) throw new RepositoryError('adoption-collision', '账户内已有不同版本，请先导出并处理冲突');
          } else pending.push(entity);
        }
        const batch = original ?? {...plan.batch, mutations: plan.batch.mutations.filter(m => pending.some(entity => entity.id === m.entityId && entity.moduleId === m.moduleId))};
        if (batch.mutations.length) await target.commit(batch);
        const deletions = plan.entities.filter(entity => entity.deletedAt && batch.mutations.some(m => m.entityId === entity.id && m.moduleId === entity.moduleId));
        const deleteId = deterministicId(`adopt-delete:${tag}:${plan.index}`), previousDeletion = await target.localBatch(deleteId);
        if (previousDeletion) await target.commit(previousDeletion);
        else if (deletions.length) {
          const mutations: MutationBatch['mutations'] = [];
          for (const entity of deletions) {
            const copied = await target.get({moduleId: entity.moduleId, entityId: entity.id});
            if (copied?.deletedAt) continue;
            mutations.push({operationId: deterministicId(`adopt-delete:${tag}:${entity.moduleId}:${entity.id}`), deviceId: target.deviceId!, entityId: entity.id, moduleId: entity.moduleId, kind: entity.kind, schemaVersion: entity.schemaVersion, baseRevision: copied?.revision || null, createdAt: entity.createdAt, updatedAt: entity.deletedAt!, action: 'delete', payload: null});
          }
          if (mutations.length) await target.commit({batchId: deleteId, mutations});
        }
      }
      for (const entity of entities) {
        const copied = await target.get({moduleId: entity.moduleId, entityId: entity.id});
        if (!copied || !sameContent(entity, copied)) throw new RepositoryError('adoption-integrity-failed');
      }
      const sourceNow = sortEntities((await Promise.all(options.moduleIds.map(id => source.list(id)))).flat());
      if (canonical(sourceNow) !== canonical(entities)) throw new RepositoryError('source-changed-during-adoption', '本机资料有新修改，请重新核对绑定');
      await activate(accountId, target);
    })
  };
}
function sameContent(a: Entity, b: Entity): boolean {return a.kind === b.kind && a.schemaVersion === b.schemaVersion && canonical(a.payload) === canonical(b.payload) && Boolean(a.deletedAt) === Boolean(b.deletedAt);}
export type AccountSession = ReturnType<typeof createAccountSession>;

function sortEntities(entities: Entity[]): Entity[] {return entities.sort((a, b) => JSON.stringify([a.moduleId, a.id]).localeCompare(JSON.stringify([b.moduleId, b.id])));}
function adoptionChunks(entities: Entity[], tag: string, deviceId: Id): {index: number; entities: Entity[]; batch: MutationBatch}[] {
  const chunks: {index: number; entities: Entity[]; batch: MutationBatch}[] = [];
  const make = () => ({index: chunks.length, entities: [] as Entity[], batch: {batchId: deterministicId(`adopt:${tag}:${chunks.length}`), mutations: [] as MutationBatch['mutations']}});
  let chunk = make();
  const size = (batch: MutationBatch) => new TextEncoder().encode(JSON.stringify(batch)).byteLength;
  for (const entity of entities) {
    const mutation: MutationBatch['mutations'][number] = {operationId: deterministicId(`adopt:${tag}:${entity.moduleId}:${entity.id}`), deviceId, entityId: entity.id, moduleId: entity.moduleId, kind: entity.kind, schemaVersion: entity.schemaVersion, baseRevision: null, createdAt: entity.createdAt, updatedAt: entity.updatedAt, action: 'put', payload: entity.payload};
    if (size({...chunk.batch, mutations: [mutation]}) > SYNC_MAX_BODY_BYTES) throw new RepositoryError('adoption-entity-too-large', '单条资料超过同步大小上限，请先拆分内容后再绑定');
    if (chunk.batch.mutations.length && (chunk.batch.mutations.length === SYNC_MAX_MUTATIONS || size({...chunk.batch, mutations: [...chunk.batch.mutations, mutation]}) > SYNC_MAX_BODY_BYTES)) {chunks.push(chunk); chunk = make();}
    chunk.batch.mutations.push(mutation); chunk.entities.push(entity);
  }
  if (chunk.batch.mutations.length) chunks.push(chunk);
  return chunks;
}
