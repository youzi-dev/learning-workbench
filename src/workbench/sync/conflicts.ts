import type {Conflict, Entity, Id, LocalReceipt, MutationBatch} from '../contracts/data';
import {canonical, RepositoryError, type SyncRepository} from '../storage/repository';
export type ConflictChoice = 'local' | 'remote' | 'copy';
/** The review and chosen local version include unsent successor edits. */
export async function conflictLocalVersion(repository: SyncRepository, conflict: Conflict): Promise<Entity[]> {
  const local = structuredClone(conflict.local);
  if (conflict.provenance?.kind === 'import') return local;
  for (const entry of await repository.queue()) for (const mutation of entry.batch.mutations) {
    const index = local.findIndex(entity => entity.id === mutation.entityId && entity.moduleId === mutation.moduleId);
    if (index < 0 || entry.resolves.includes(conflict.id)) continue;
    const old = local[index];
    local[index] = {...old, updatedAt: mutation.updatedAt, deletedAt: mutation.action === 'delete' ? mutation.updatedAt : null, payload: mutation.action === 'delete' ? old.payload : mutation.payload};
  }
  return local;
}
/** Latest confirmed view, separate from immutable original conflict evidence. */
export async function conflictRemoteVersion(repository: SyncRepository, conflict: Conflict): Promise<Entity[]> {
  if (conflict.provenance?.kind === 'import') {
    const resolving = (await repository.queue()).some(entry => entry.resolves.includes(conflict.id));
    if (resolving && conflict.provenance.targetAtResolution) return structuredClone(conflict.provenance.targetAtResolution);
    const target: Entity[] = [];
    for (const mutation of conflict.batch.mutations) {
      const current = await repository.get({moduleId: mutation.moduleId, entityId: mutation.entityId});
      if (current) target.push(current);
    }
    return target;
  }
  const remote: Entity[] = [];
  for (const mutation of conflict.batch.mutations) {
    const current = await repository.confirmed({moduleId: mutation.moduleId, entityId: mutation.entityId});
    // Retained backup evidence is historical, never a target-account revision.
    if (current) remote.push(current);
  }
  return remote;
}
export async function resolveConflict(repository: SyncRepository, id: Id, choice: ConflictChoice, deviceId: Id, reviewedRemote?: Entity[]): Promise<LocalReceipt> {
  const conflict = (await repository.conflicts()).find(item => item.id === id);
  if (!conflict) throw new RepositoryError('missing-conflict');
  if (await repository.resolutionTarget(id) !== id) throw new RepositoryError('superseded-conflict', '此原始冲突已有后续版本，请处理当前冲突');
  const remoteVersions = await conflictRemoteVersion(repository, conflict);
  if (reviewedRemote && canonical(reviewedRemote) !== canonical(remoteVersions)) throw new RepositoryError('remote-review-changed', '云端版本已更新，请核对后再次选择');
  const imported = conflict.provenance?.kind === 'import';
  if (choice === 'remote' && (!imported || remoteVersions.length > 0 || conflict.remote.length === 0)) return repository.resolveRemote(id);
  const confirmedVersions = (await Promise.all(conflict.batch.mutations.map(mutation => repository.confirmed({moduleId: mutation.moduleId, entityId: mutation.entityId})))).filter((entity): entity is Entity => entity !== null);
  if (choice === 'local' && confirmedVersions.some(entity => entity.deletedAt)) throw new RepositoryError('deleted', '原记录已删除，请保留为新副本');
  const local = choice === 'remote' && imported ? structuredClone(conflict.remote) : await conflictLocalVersion(repository, conflict);
  if (choice === 'copy' && local.some(entity => entity.deletedAt && entity.payload === null)) throw new RepositoryError('missing-copy-payload', '此旧删除版本缺少完整内容，无法建立有效副本');
  const batch: MutationBatch = {batchId: crypto.randomUUID(), mutations: local.map(entity => {
    const remote = confirmedVersions.find(item => item.id === entity.id && item.moduleId === entity.moduleId);
    return {operationId: crypto.randomUUID(), deviceId, entityId: choice === 'copy' ? crypto.randomUUID() : entity.id, moduleId: entity.moduleId, kind: entity.kind, schemaVersion: entity.schemaVersion, baseRevision: choice === 'copy' ? null : remote?.revision ?? null, createdAt: entity.createdAt, updatedAt: new Date().toISOString(), action: choice === 'copy' || !entity.deletedAt ? 'put' : 'delete', payload: choice !== 'copy' && entity.deletedAt ? null : entity.payload};
  })};
  if (!batch.mutations.length) throw new RepositoryError('empty-conflict');
  return repository.commitResolution(id, batch);
}
