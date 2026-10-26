import type {SyncTransport, SyncHello} from '../contracts/sync';
import type {SyncRepository} from '../storage/repository';
export type SyncState = 'pending' | 'syncing' | 'synced' | 'conflict' | 'failed';
export type SyncSnapshot = {state: SyncState; pending: number; conflicts: number; error: string | null; readonlyKinds: string[]};
export type SyncOptions = {schemas?: SyncHello['schemas']; onChange?: () => void};
const active = new WeakMap<SyncRepository, Promise<void>>();
const safeCode = (cause: unknown): string => cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(cause.code) ? cause.code : 'CONNECTION_FAILED';
export function createSyncEngine(repository: SyncRepository, transport: SyncTransport, options: SyncOptions = {}) {
  let snapshot: SyncSnapshot = {state: 'pending', pending: 0, conflicts: 0, error: null, readonlyKinds: []};
  const listeners = new Set<() => void>();
  const emit = (update: Partial<SyncSnapshot>) => {snapshot = {...snapshot, ...update}; for (const listener of listeners) listener(); options.onChange?.();};
  async function refresh() {const [pending, conflicts] = await Promise.all([repository.pending(), repository.conflicts()]); emit({pending: pending.length, conflicts: conflicts.length, state: conflicts.length ? 'conflict' : pending.length ? 'pending' : 'synced'});}
  async function run() {
    emit({state: 'syncing', error: null});
    try {
      const welcome = await transport.handshake({protocolVersion: 1, hostApiVersion: 1, schemas: options.schemas ?? {}});
      emit({readonlyKinds: welcome.readonlyKinds});
      if (!welcome.compatible) throw Object.assign(Error('请更新客户端后同步'), {code: 'PROTOCOL_UNSUPPORTED'});
      let more = true;
      while (more) {const cursor = await repository.cursor(), page = await transport.pull(cursor, 50); if (page.hasMore && page.nextCursor <= cursor) throw Object.assign(Error('Invalid cursor'), {code: 'INVALID_CURSOR'}); await repository.apply(page); more = page.hasMore;}
      const visited = new Set<string>();
      while (true) {
        const candidate = (await repository.queue()).find(entry => !entry.blocked && !visited.has(entry.batch.batchId));
        if (!candidate) break;
        visited.add(candidate.batch.batchId);
        if (candidate.batch.mutations.some(m => welcome.readonlyKinds.includes(`${m.moduleId}/${m.kind}`))) {await repository.recordFailure(candidate.batch.batchId, 'SCHEMA_VERSION_UNSUPPORTED'); continue;}
        const batch = await repository.prepare(candidate.batch.batchId);
        try {await repository.accept(await transport.push(batch));} catch (cause) {const code = safeCode(cause); await repository.recordFailure(batch.batchId, code); if (!['INVALID_BATCH', 'BATCH_TOO_LARGE', 'INVALID_PAYLOAD', 'UNKNOWN_SCHEMA', 'SCHEMA_VERSION_UNSUPPORTED'].includes(code)) throw cause;}
      }
      await refresh();
      const failed = (await repository.queue()).find(entry => entry.failure);
      if (failed) emit({state: 'failed', error: failed.failure ?? 'CONNECTION_FAILED'});
    } catch (cause) {emit({state: 'failed', error: safeCode(cause)}); throw cause;}
  }
  return {snapshot: () => snapshot, subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};}, refresh, sync() {const existing = active.get(repository); if (existing) return existing; const promise = run().finally(() => active.delete(repository)); active.set(repository, promise); return promise;}};
}
export function syncOnce(repository: SyncRepository, transport: SyncTransport, options: SyncOptions = {}): Promise<void> {return createSyncEngine(repository, transport, options).sync();}
export type SyncEngine = ReturnType<typeof createSyncEngine>;
