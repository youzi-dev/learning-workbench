import type {BackupImport, MigrationMarker, RepositoryBackupData} from '../contracts/backup';
import {SYNC_MAX_BODY_BYTES, SYNC_MAX_MUTATIONS} from '../contracts/sync';
import {conflictAncestors, validateConflictParents, type ConflictParents} from './conflict-lineage';
import {validateFile} from '../files/storage';
import type {Conflict, Entity, EntityRef, Id, JsonValue, LocalReceipt, ModuleId, Mutation, MutationBatch, PullPage, PushResult} from '../contracts/data';
export type LocalCommitOptions = {additionalBatches?: MutationBatch[]; expectedLocal?: Record<Id, string | null>; learningPreferences?: {expected: JsonValue | null; value: JsonValue}};
export interface LocalRepository {
  get(ref: EntityRef): Promise<Entity | null>;
  list(moduleId: ModuleId): Promise<Entity[]>;
  commit(batch: MutationBatch, options?: LocalCommitOptions): Promise<LocalReceipt>;
  apply(page: PullPage): Promise<void>;
}
export type SyncQueueEntry = {batch: MutationBatch; attempted: boolean; blocked: boolean; failure?: string; resolves: Id[]};
export interface SyncRepository extends LocalRepository {
  resolutionTarget(conflictId: Id): Promise<Id>;
  confirmed(ref: EntityRef): Promise<Entity | null>;
  queue(): Promise<SyncQueueEntry[]>;
  prepare(batchId: Id): Promise<MutationBatch>;
  resolveRemote(conflictId: Id): Promise<LocalReceipt>;
  pending(): Promise<MutationBatch[]>;
  cursor(): Promise<number>;
  accept(result: PushResult): Promise<void>;
  conflicts(): Promise<Conflict[]>;
  commitResolution(conflictId: Id, batch: MutationBatch): Promise<LocalReceipt>;
  recordFailure(batchId: Id, code: string): Promise<void>;
}
export type MigrationImport = {fingerprint: string; entities: Entity[]; devicePreferences: JsonValue; sourceSnapshot: Uint8Array};
export type MigrationStatus = {fingerprint: string; active: true; imported: number; snapshot: number[]};
export interface MigrationRepository extends SyncRepository {importV1(input: MigrationImport): Promise<{fingerprint: string; imported: number}>;}
/** Lifecycle and recovery are deliberately not exposed to business modules. */
export interface ManagedRepository extends MigrationRepository {
  readonly readonly: boolean;
  readonly deviceId: Id | null;
  exportData(): Promise<RepositoryBackupData>;
  importData(input: BackupImport): Promise<LocalReceipt>;
  close(): void;
  localBatch(batchId: Id): Promise<MutationBatch | null>;
  migrationStatus(fingerprint: string): Promise<Omit<MigrationStatus, 'snapshot'> | null>;
  recoverySnapshot(fingerprint: string): Promise<Uint8Array | null>;
  devicePreferences(): Promise<JsonValue | null>;
}
export const TABLES = ['entities', 'confirmed', 'outbox', 'conflicts', 'cursors', 'migrations', 'device_preferences'] as const;
export type Table = typeof TABLES[number];
export type RepositoryState = Record<Table, Record<string, unknown>>;
export interface RepositoryDriver {
  readonly readonly: boolean;
  read<T>(action: (state: RepositoryState) => T): Promise<T>;
  write<T>(action: (state: RepositoryState) => T): Promise<T>;
  close(): void;
}
export class RepositoryError extends Error {
  constructor(public readonly code: string, message = code, public readonly readonly = false) {super(message); this.name = 'RepositoryError';}
}
export function emptyRepositoryState(): RepositoryState {return Object.fromEntries(TABLES.map(name => [name, Object.create(null)])) as RepositoryState;}
export const entityKey = (ref: EntityRef): string => JSON.stringify([ref.moduleId, ref.entityId]);
const keyOf = (e: Entity) => entityKey({moduleId: e.moduleId, entityId: e.id});
const copy = <T>(value: T): T => structuredClone(value);
/** Canonical JSON also rejects nonfinite numbers, prototypes and non-JSON values. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new RepositoryError('invalid', 'Only finite JSON values are supported');
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const time = (v: unknown) => text(v) && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function validateEntity(value: Entity): void {
  canonical(value);
  if (!value || ![value.id, value.moduleId, value.kind].every(text) || !natural(value.schemaVersion) || value.schemaVersion < 1 || !natural(value.revision) || !time(value.createdAt) || !time(value.updatedAt) || (value.deletedAt !== null && !time(value.deletedAt))) throw new RepositoryError('invalid');
}
function validateBatch(batch: MutationBatch): void {
  canonical(batch);
  if (!batch || !text(batch.batchId) || !Array.isArray(batch.mutations) || !batch.mutations.length) throw new RepositoryError('invalid');
  const ids = new Set<string>(), entities = new Set<string>();
  for (const m of batch.mutations) {
    if (!m || ![m.operationId, m.deviceId, m.entityId, m.moduleId, m.kind].every(text) || !natural(m.schemaVersion) || m.schemaVersion < 1 || (m.baseRevision !== null && (!natural(m.baseRevision) || m.baseRevision === 0)) || !time(m.createdAt) || !time(m.updatedAt) || !['put', 'delete'].includes(m.action) || (m.action === 'delete' && m.payload !== null)) throw new RepositoryError('invalid');
    const key = entityKey(m);
    if (ids.has(m.operationId) || entities.has(key)) throw new RepositoryError('invalid');
    ids.add(m.operationId); entities.add(key);
  }
}
/** Wire limits apply to every producer; a local multi-entity operation remains one transaction. */
export function boundedBatches(batch: MutationBatch): MutationBatch[] {
  validateBatch(batch);
  const result: MutationBatch[] = [];
  let current: MutationBatch = {batchId: batch.batchId, mutations: []};
  const fits = (value: MutationBatch) => value.mutations.length <= SYNC_MAX_MUTATIONS && new TextEncoder().encode(JSON.stringify(value)).length <= SYNC_MAX_BODY_BYTES;
  for (const mutation of batch.mutations) {
    if (!fits({...current, mutations: [mutation]})) throw new RepositoryError('ENTITY_TOO_LARGE', '单条内容超过 1 MiB，请缩短文字或改为导入文件');
    if (!fits({...current, mutations: [...current.mutations, mutation]})) {
      result.push(current);
      current = {batchId: deterministicId(`${batch.batchId}:bounded:${result.length}`), mutations: []};
    }
    current.mutations.push(mutation);
  }
  result.push(current);
  return result;
}
const exceedsLimits = (batch: MutationBatch) => batch.mutations.length > SYNC_MAX_MUTATIONS || new TextEncoder().encode(JSON.stringify(batch)).length > SYNC_MAX_BODY_BYTES;
type Outbox = {batch: MutationBatch; wire?: MutationBatch; attempted?: boolean; predecessors?: Record<string, Id>; sequence: number; failure?: string; resolves?: Id[]; localSnapshots?: Entity[]};
const ordered = (state: RepositoryState): Outbox[] => (Object.values(state.outbox) as Outbox[]).sort((a, b) => a.sequence - b.sequence);
function overlay(m: Mutation, confirmed?: Entity, visible?: Entity): Entity {
  return {id: m.entityId, moduleId: m.moduleId, kind: m.kind, schemaVersion: m.schemaVersion, revision: confirmed?.revision ?? 0, createdAt: confirmed?.createdAt ?? visible?.createdAt ?? m.createdAt, updatedAt: m.updatedAt, deletedAt: m.action === 'delete' ? m.updatedAt : null, payload: m.action === 'delete' ? (visible ? visible.payload : confirmed?.payload ?? null) : m.payload};
}
function rebuild(state: RepositoryState): void {
  state.entities = copy(state.confirmed);
  for (const {batch} of ordered(state)) for (const m of batch.mutations) {
    const key = entityKey(m), confirmed = state.confirmed[key] as Entity | undefined;
    // Confirmed deletions and unknown newer schemas remain authoritative in normal views.
    // Preserve older edits in the outbox for explicit conflict/copy handling.
    if (confirmed && ((confirmed.deletedAt !== null && m.action === 'put') || confirmed.schemaVersion > m.schemaVersion || confirmed.kind !== m.kind)) continue;
    state.entities[key] = overlay(m, confirmed, state.entities[key] as Entity | undefined);
  }
}
function isBlocked(state: RepositoryState, item: Outbox): boolean {
  const conflicts = Object.values(state.conflicts) as Conflict[];
  const covered = new Set(item.resolves ?? []);
  const keys = new Set(item.batch.mutations.map(entityKey));
  if (conflicts.some(conflict => conflict.provenance?.kind !== 'import' && !covered.has(conflict.id) && conflict.batch.mutations.some(m => keys.has(entityKey(m))))) return true;
  return Object.values(item.predecessors ?? {}).some(id => !!state.outbox[id]);
}
/** Ancestors remain evidence; only a current descendant may be resolved. */
function resolutionTarget(state: RepositoryState, conflictId: Id): Id {
  if (!state.conflicts[conflictId]) throw new RepositoryError('missing-conflict');
  const ids = Object.keys(state.conflicts), seen = new Set<Id>();
  let current = conflictId;
  for (let depth = 0; depth <= ids.length; depth++) {
    if (seen.has(current)) throw new RepositoryError('invalid-conflict-lineage');
    seen.add(current);
    const descendants = ids.filter(id => {
      const parents = state.cursors[`conflict-parents:${id}`];
      if (parents !== undefined && (!Array.isArray(parents) || !parents.every(text))) throw new RepositoryError('invalid-conflict-lineage');
      return Array.isArray(parents) && parents.includes(current);
    });
    if (!descendants.length) return current;
    current = descendants[descendants.length - 1];
  }
  throw new RepositoryError('invalid-conflict-lineage');
}
function requireCurrentConflict(state: RepositoryState, conflictId: Id): void {
  if (resolutionTarget(state, conflictId) !== conflictId) throw new RepositoryError('superseded-conflict', '此原始冲突已有后续版本，请处理当前冲突');
}
export type RepositoryOptions = {schemas?: Record<ModuleId, Record<string, number>>; deviceId?: Id};
function enqueue(state: RepositoryState, batch: MutationBatch, options: RepositoryOptions = {}): LocalReceipt {
  validateBatch(batch);
  if (exceedsLimits(batch)) throw new RepositoryError('BATCH_TOO_LARGE');
  const receiptKey = `batch:${batch.batchId}`;
  const serialized = canonical(batch), previous = state.cursors[receiptKey];
  if (previous !== undefined) {
    if (previous !== serialized) throw new RepositoryError('BATCH_MISMATCH');
    return {batchId: batch.batchId, state: 'saved-local'};
  }
  for (const m of batch.mutations) {
    if (state.cursors[`operation:${m.operationId}`] !== undefined) throw new RepositoryError('BATCH_MISMATCH');
    const supported = options.schemas ? options.schemas[m.moduleId]?.[m.kind] : 1;
    if (supported === undefined || m.schemaVersion > supported) throw new RepositoryError('readonly-schema', 'Unknown entity version is read-only', true);
    const current = state.entities[entityKey(m)] as Entity | undefined;
    const confirmed = state.confirmed[entityKey(m)] as Entity | undefined;
    if (current && (current.schemaVersion > m.schemaVersion || current.kind !== m.kind)) throw new RepositoryError('readonly-schema', 'Newer entity schema cannot be overwritten', true);
    if ((confirmed?.revision ?? null) !== m.baseRevision) throw new RepositoryError('stale', 'Mutation must use the server-confirmed revision');
    if (confirmed?.deletedAt && m.action === 'put') throw new RepositoryError('deleted', 'A deleted entity requires an explicit conflict resolution or a new ID');
  }
  // A later explicit edit may replace an indivisible legacy oversize unit. Its immutable
  // wire evidence remains archived; fixed protocol limits prove it could never apply.
  const replacing = new Set(batch.mutations.map(entityKey));
  for (const failed of ordered(state)) if (failed.failure === 'ENTITY_TOO_LARGE' && failed.batch.mutations.every(m => replacing.has(entityKey(m)))) {
    state.cursors[`oversize-recovery:${failed.batch.batchId}`] ??= copy(failed);
    state.cursors[`oversize-replaced-by:${failed.batch.batchId}`] = batch.batchId;
    delete state.outbox[failed.batch.batchId];
  }
  const sequence = (state.cursors.localSequence as number ?? 0) + 1;
  state.cursors.localSequence = sequence;
  state.cursors[receiptKey] = serialized;
  for (const m of batch.mutations) state.cursors[`operation:${m.operationId}`] = batch.batchId;
  const predecessors: Record<string, Id> = {};
  for (const m of batch.mutations) {
    const key = entityKey(m);
    const predecessor = ordered(state).filter(item => item.batch.mutations.some(other => entityKey(other) === key)).at(-1);
    if (predecessor) predecessors[key] = predecessor.batch.batchId;
  }
  state.outbox[batch.batchId] = {batch: copy(batch), sequence, predecessors};
  rebuild(state);
  (state.outbox[batch.batchId] as Outbox).localSnapshots = batch.mutations.map(m => copy(state.entities[entityKey(m)] as Entity));
  return {batchId: batch.batchId, state: 'saved-local'};
}
function putConfirmed(state: RepositoryState, entities: Entity[]): void {
  for (const entity of entities) {
    validateEntity(entity);
    if (entity.revision === 0) throw new RepositoryError('invalid', 'A server entity must have a revision');
    const key = keyOf(entity), previous = state.confirmed[key] as Entity | undefined;
    if (previous && previous.revision === entity.revision && canonical(previous) !== canonical(entity)) throw new RepositoryError('revision-mismatch');
    if (!previous || entity.revision > previous.revision) state.confirmed[key] = copy(entity);
  }
}
function contentEqual(a: Entity, b: Entity): boolean {return a.kind === b.kind && a.schemaVersion === b.schemaVersion && canonical(a.payload) === canonical(b.payload) && a.deletedAt === b.deletedAt;}
/** Stable namespaced UUIDs for idempotent import operations (custom UUID version 8). */
export function deterministicId(value: string): Id {
  const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < value.length; i++) for (let j = 0; j < words.length; j++) words[j] = Math.imul(words[j] ^ (value.charCodeAt(i) + j * 31), 0x01000193) >>> 0;
  const hex = words.map(w => w.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export async function sourceFingerprint(source: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(source));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
type RestoreProgress = {signature: string; next: number; complete: boolean; batchId: Id};
function restoreMutation(entity: Entity, deviceId: Id, batchId: Id): Mutation {
  return {
    operationId: deterministicId(`${batchId}:${entity.moduleId}:${entity.id}`), deviceId,
    entityId: entity.id, moduleId: entity.moduleId, kind: entity.kind,
    schemaVersion: entity.schemaVersion, baseRevision: null,
    createdAt: entity.createdAt, updatedAt: entity.deletedAt ?? entity.updatedAt,
    action: entity.deletedAt ? 'delete' : 'put', payload: entity.deletedAt ? null : entity.payload
  };
}
/** Groups are deterministic and bounded before any durable import write. */
function restoreGroups(entities: Entity[], deviceId: Id, rootBatchId: Id): Entity[][] {
  const groups: Entity[][] = []; let current: Entity[] = [];
  const bytes = (items: Entity[]) => new TextEncoder().encode(canonical({batchId: deterministicId(`${rootBatchId}:part:${groups.length}`), mutations: items.map(entity => restoreMutation(entity, deviceId, rootBatchId))})).length;
  for (const entity of entities) {
    if (bytes([entity]) > SYNC_MAX_BODY_BYTES) throw new RepositoryError('ENTITY_TOO_LARGE');
    if (current.length >= SYNC_MAX_MUTATIONS || bytes([...current, entity]) > SYNC_MAX_BODY_BYTES) {groups.push(current); current = [];}
    current.push(entity);
  }
  if (current.length) groups.push(current);
  return groups;
}
function validateBackupImport(input: BackupImport, options: RepositoryOptions): void {
  canonical(input);
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint) || !Array.isArray(input.entities) || !Array.isArray(input.conflicts) || !Array.isArray(input.migrationMarkers) || !Array.isArray(input.files) || typeof input.restoreDevicePreferences !== 'boolean') throw new RepositoryError('invalid');
  const keys = new Set<string>();
  const schema = (entity: Entity) => {
    validateEntity(entity);
    const version = options.schemas?.[entity.moduleId]?.[entity.kind] ?? (options.schemas ? 0 : 1);
    if (entity.schemaVersion > version) throw new RepositoryError('readonly-schema', 'Unknown backup entity is read-only', true);
  };
  for (const entity of input.entities) {schema(entity); const key = keyOf(entity); if (keys.has(key)) throw new RepositoryError('invalid', 'Duplicate backup entity'); keys.add(key);}
  const conflictIds = new Set<string>();
  for (const conflict of input.conflicts) {
    if (!conflict || !text(conflict.id) || conflictIds.has(conflict.id) || !['stale', 'deleted', 'import-collision'].includes(conflict.reason)) throw new RepositoryError('invalid');
    conflictIds.add(conflict.id); validateBatch(conflict.batch); conflict.local.forEach(schema); conflict.remote.forEach(schema);
    validateImportProvenance(conflict);
  }
  validateConflictParents(input.conflicts, input.conflictParents);
  for (const marker of input.migrationMarkers) if (!marker || !text(marker.fingerprint) || typeof marker.active !== 'boolean' || !natural(marker.imported)) throw new RepositoryError('invalid');
  input.files.forEach(validateFile);
}
function validateImportProvenance(conflict: Conflict): void {
  const provenance = conflict.provenance;
  if (!provenance) return;
  if (provenance.kind !== 'import' || !text(provenance.sourceFingerprint)) throw new RepositoryError('invalid-import-provenance');
  if (provenance.targetAtResolution !== undefined) {
    if (!Array.isArray(provenance.targetAtResolution)) throw new RepositoryError('invalid-import-provenance');
    provenance.targetAtResolution.forEach(validateEntity);
  }
}
function storedConflictParents(state: RepositoryState): ConflictParents {
  const parents: ConflictParents = Object.create(null);
  for (const id of Object.keys(state.conflicts)) if (state.cursors[`conflict-parents:${id}`] !== undefined) parents[id] = state.cursors[`conflict-parents:${id}`] as string[];
  return validateConflictParents(Object.values(state.conflicts) as Conflict[], parents);
}
const uuid = (value: unknown): value is Id => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export async function createRepository(driver: RepositoryDriver, options: RepositoryOptions = {}): Promise<ManagedRepository> {
  if (options.deviceId !== undefined && !uuid(options.deviceId)) throw new RepositoryError('invalid', 'Device identity must be a UUID');
  const initializeIdentity = (state: RepositoryState): Id | null => {
    const stored = state.cursors.deviceId;
    if (stored !== undefined && !uuid(stored)) throw new RepositoryError('invalid', 'Stored device identity is invalid');
    if (stored && options.deviceId && stored !== options.deviceId) throw new RepositoryError('device-mismatch', 'Installation identity cannot be rebound');
    if (stored) return stored;
    if (driver.readonly) return null;
    const created = options.deviceId ?? globalThis.crypto.randomUUID();
    state.cursors.deviceId = created; return created;
  };
  const deviceId = driver.readonly ? await driver.read(initializeIdentity) : await driver.write(initializeIdentity);
  const read = <T>(fn: (state: RepositoryState) => T) => driver.read(state => copy(fn(state)));
  const write = <T>(fn: (state: RepositoryState) => T) => {
    if (driver.readonly) return Promise.reject(new RepositoryError('readonly-schema', 'Future container is read-only', true));
    return driver.write(fn);
  };
  if (!driver.readonly && await read(state => ordered(state).some(item => item.failure !== 'ENTITY_TOO_LARGE' && exceedsLimits(item.wire ?? item.batch)))) await write(state => {
    const original = ordered(state);
    const replacements = new Map<Id, Map<string, Id>>();
    for (const item of original) {
      const wire = item.wire ?? item.batch;
      if (item.failure === 'ENTITY_TOO_LARGE' || !exceedsLimits(wire)) continue;
      state.cursors[`oversize-recovery:${item.batch.batchId}`] ??= copy(item);
      let parts: MutationBatch[];
      try {parts = boundedBatches(wire);} catch (cause) {
        if (!(cause instanceof RepositoryError) || cause.code !== 'ENTITY_TOO_LARGE') throw cause;
        // Keep an indivisible record failed, but recover its independent siblings.
        if (wire.mutations.length === 1) {item.failure = 'ENTITY_TOO_LARGE'; continue;}
        parts = [];
        let group: Mutation[] = [];
        for (const mutation of wire.mutations) {
          const single = {batchId: wire.batchId, mutations: [mutation]};
          if (exceedsLimits(single)) {
            if (group.length) parts.push(...boundedBatches({batchId: wire.batchId, mutations: group}));
            group = []; parts.push(single);
          } else group.push(mutation);
        }
        if (group.length) parts.push(...boundedBatches({batchId: wire.batchId, mutations: group}));
      }
      delete state.outbox[item.batch.batchId];
      const owners = new Map<string, Id>();
      parts.forEach((part, index) => {
        // A new batch identity records deliberate protocol-limit recovery. Keep operation identities.
        const batchId = deterministicId(`${item.batch.batchId}:limit-recovery:${index}`);
        const batch = {...part, batchId};
        state.outbox[batchId] = {batch, ...(exceedsLimits(batch) ? {failure: 'ENTITY_TOO_LARGE'} : {}), sequence: item.sequence + index / parts.length, predecessors: Object.fromEntries(Object.entries(item.predecessors ?? {}).filter(([key]) => part.mutations.some(mutation => entityKey(mutation) === key))), resolves: index === parts.length - 1 ? item.resolves : [], localSnapshots: item.localSnapshots?.filter(entity => part.mutations.some(m => keyOf(entity) === entityKey(m)))} satisfies Outbox;
        state.cursors[`batch:${batchId}`] = canonical(batch);
        for (const mutation of batch.mutations) {state.cursors[`operation:${mutation.operationId}`] = batchId; owners.set(entityKey(mutation), batchId);}
      });
      replacements.set(item.batch.batchId, owners);
    }
    ordered(state).forEach((item, index) => {
      item.sequence = index + 1;
      for (const [key, id] of Object.entries(item.predecessors ?? {})) if (replacements.get(id)?.has(key)) item.predecessors![key] = replacements.get(id)!.get(key)!;
    });
    state.cursors.localSequence = ordered(state).length;
  });
  const repository: ManagedRepository = {
    exportData: () => read(s => {
      const entities = (Object.values(s.entities) as Entity[]).map(entity => {
        const source = s.cursors[`restore-tombstone:${keyOf(entity)}`] as Entity | undefined;
        return source && entity.deletedAt && entity.payload === null ? {...entity, payload: source.payload} : entity;
      });
      const markers = new Map<string, MigrationMarker>();
      for (const marker of Object.values(s.migrations) as MigrationStatus[]) markers.set(marker.fingerprint, {fingerprint: marker.fingerprint, active: marker.active, imported: marker.imported});
      for (const marker of (s.cursors.restoredMigrationMarkers as MigrationMarker[] | undefined) ?? []) if (!markers.has(marker.fingerprint)) markers.set(marker.fingerprint, marker);
      return {entities, conflicts: Object.values(s.conflicts) as Conflict[], conflictParents: storedConflictParents(s), migrationMarkers: [...markers.values()], devicePreferences: (s.device_preferences.current as JsonValue | undefined) ?? null, files: (s.cursors.restoredFileList as RepositoryBackupData['files'] | undefined) ?? []};
    }),
    importData: async input => {
      input = copy(input);
      if (!deviceId || driver.readonly) throw new RepositoryError('readonly-schema', 'Container is read-only', true);
      validateBackupImport(input, options);
      const rootBatchId = deterministicId(`${deviceId}:${input.fingerprint}:restore`);
      const signature = await sourceFingerprint(new TextEncoder().encode(canonical(input)));
      const groups = restoreGroups(input.entities, deviceId, rootBatchId), progressKey = `restore:${input.fingerprint}`;
      await write(s => {
        const previous = s.cursors[progressKey] as RestoreProgress | undefined;
        if (previous && previous.signature !== signature) throw new RepositoryError('BATCH_MISMATCH');
        if (!previous) s.cursors[progressKey] = {signature, next: 0, complete: false, batchId: rootBatchId} satisfies RestoreProgress;
      });
      // A chunk and its progress are one transaction. Reopening and choosing the
      // same immutable source resumes without replaying committed chunks.
      for (let index = 0; index < groups.length; index++) await write(s => {
        const progress = s.cursors[progressKey] as RestoreProgress;
        if (progress.next > index || progress.complete) return;
        if (progress.next !== index) throw new RepositoryError('invalid', 'Restore progress mismatch');
        const batchId = deterministicId(`${rootBatchId}:part:${index}`), mutations: Mutation[] = [];
        for (const incoming of groups[index]) {
          const key = keyOf(incoming), current = s.entities[key] as Entity | undefined;
          if (current) {
            if (!contentEqual(incoming, current)) {
              const conflictId = deterministicId(`${rootBatchId}:collision:${incoming.moduleId}:${incoming.id}`);
              const conflictBatchId = deterministicId(`${conflictId}:batch`);
              s.conflicts[conflictId] = {id: conflictId, batch: {batchId: conflictBatchId, mutations: [restoreMutation(incoming, deviceId, conflictBatchId)]}, local: [copy(incoming)], remote: [copy(current)], reason: 'import-collision', provenance: {kind: 'import', sourceFingerprint: input.fingerprint}} satisfies Conflict;
            }
            continue;
          }
          mutations.push(restoreMutation(incoming, deviceId, batchId));
          if (incoming.deletedAt) s.cursors[`restore-tombstone:${key}`] = copy(incoming);
        }
        if (mutations.length) for (const batch of boundedBatches({batchId, mutations})) enqueue(s, batch, options);
        progress.next = index + 1;
      });
      return write(s => {
        const progress = s.cursors[progressKey] as RestoreProgress;
        if (progress.complete) return {batchId: rootBatchId, state: 'saved-local'};
        for (const original of input.conflicts) {
          const id = deterministicId(`${rootBatchId}:backup-conflict:${original.id}`);
          if (!s.conflicts[id]) {
            const batchId = deterministicId(`${id}:batch`);
            s.conflicts[id] = {...copy(original), id, provenance: {...copy(original.provenance ?? {}), kind: 'import', sourceFingerprint: input.fingerprint}, batch: {batchId, mutations: original.batch.mutations.map(mutation => ({...mutation, deviceId, operationId: deterministicId(`${batchId}:${mutation.operationId}`), baseRevision: null}))}};
          }
        }
        const parents = validateConflictParents(input.conflicts, input.conflictParents);
        for (const original of input.conflicts) {
          const id = deterministicId(`${rootBatchId}:backup-conflict:${original.id}`);
          const ancestors = conflictAncestors(parents, original.id);
          if (ancestors.length) s.cursors[`conflict-parents:${id}`] = ancestors.map(parent => deterministicId(`${rootBatchId}:backup-conflict:${parent}`));
        }
        const markers = new Map(((s.cursors.restoredMigrationMarkers as MigrationMarker[] | undefined) ?? []).map(marker => [marker.fingerprint, marker]));
        for (const {fingerprint, active, imported} of input.migrationMarkers) if (!markers.has(fingerprint)) markers.set(fingerprint, {fingerprint, active, imported});
        s.cursors.restoredMigrationMarkers = [...markers.values()];
        const files = new Map(((s.cursors.restoredFileList as RepositoryBackupData['files'] | undefined) ?? []).map(file => [file.sha256, file]));
        for (const {sha256, size, mime} of input.files) files.set(sha256, {sha256, size, mime});
        s.cursors.restoredFileList = [...files.values()];
        if (input.restoreDevicePreferences) s.device_preferences.current = copy(input.devicePreferences);
        progress.complete = true;
        return {batchId: rootBatchId, state: 'saved-local'};
      });
    },
    resolutionTarget: id => read(s => resolutionTarget(s, id)),
    localBatch: id => read(s => typeof s.cursors[`batch:${id}`] === 'string' ? JSON.parse(s.cursors[`batch:${id}`] as string) as MutationBatch : null),
    get readonly() {return driver.readonly;}, get deviceId() {return deviceId;}, close: () => driver.close(),
    confirmed: ref => read(s => (s.confirmed[entityKey(ref)] as Entity | undefined) ?? null),
    get: ref => read(s => (s.entities[entityKey(ref)] as Entity | undefined) ?? null),
    list: moduleId => read(s => (Object.values(s.entities) as Entity[]).filter(e => e.moduleId === moduleId)),
    commit: async (batch, localOptions) => {
      const captured = copy(batch), checked = localOptions ? copy(localOptions) : undefined;
      return write(s => {
        const batches = [captured, ...(checked?.additionalBatches ?? [])].flatMap(batch => batch.mutations.length ? boundedBatches(batch) : [batch]);
        const mutations = batches.flatMap(batch => batch.mutations);
        const affected = new Set<string>();
        for (const mutation of mutations) {const key = entityKey(mutation); if (affected.has(key)) throw new RepositoryError('invalid-precondition'); affected.add(key);}
        if (checked) {
          canonical(checked);
          if (checked.additionalBatches) for (const batch of batches) if (batch.mutations.length > SYNC_MAX_MUTATIONS || new TextEncoder().encode(canonical(batch)).length > SYNC_MAX_BODY_BYTES) throw new RepositoryError('BATCH_TOO_LARGE');
          if (checked.expectedLocal && (Object.keys(checked.expectedLocal).length !== mutations.length || mutations.some(m => !Object.hasOwn(checked.expectedLocal!, m.entityId)))) throw new RepositoryError('invalid-precondition');
          for (const [id, expected] of Object.entries(checked.expectedLocal ?? {})) {
            const mutation = mutations.find(m => m.entityId === id);
            if (!mutation) throw new RepositoryError('invalid-precondition');
            const current = s.entities[entityKey(mutation)];
            if ((current === undefined ? null : canonical(current)) !== expected) {
              let previous: Entity | undefined;
              try {if (typeof expected === 'string') {previous = JSON.parse(expected) as Entity; validateEntity(previous);}} catch {throw new RepositoryError('invalid-precondition');}
              // An own sync ACK advances only the server revision. Rebase within
              // this transaction after proving every other envelope field equal.
              if (!current || !previous || canonical({...current as Entity, revision: 0}) !== canonical({...previous, revision: 0})) throw new RepositoryError('stale', '本机学习记录已改变，请重新读取后再保存');
              mutation.baseRevision = (s.confirmed[entityKey(mutation)] as Entity | undefined)?.revision ?? null;
            }
          }
          if (checked.learningPreferences) {
            if (mutations.some(m => m.moduleId !== 'learning')) throw new RepositoryError('foreign-module');
            if (canonical(s.device_preferences.current ?? null) !== canonical(checked.learningPreferences.expected)) throw new RepositoryError('stale', '本机偏好已改变');
          }
        }
        const receipt = captured.mutations.length ? enqueue(s, batches[0], options) : checked?.learningPreferences ? {batchId: captured.batchId, state: 'saved-local' as const} : (() => {throw new RepositoryError('invalid');})();
        for (const batch of batches.slice(1)) enqueue(s, batch, options);
        if (checked?.learningPreferences) s.device_preferences.current = copy(checked.learningPreferences.value);
        return receipt;
      });
    },
    pending: () => read(s => ordered(s).map(item => item.wire ?? item.batch)),
    queue: () => read(s => ordered(s).map(item => ({batch: item.wire ?? item.batch, attempted: item.attempted ?? false, failure: item.failure, resolves: item.resolves ?? [], blocked: isBlocked(s, item) || item.failure === 'ENTITY_TOO_LARGE'}))),
    prepare: id => write(s => {
      const item = s.outbox[id] as Outbox | undefined;
      if (!item) throw new RepositoryError('missing-batch');
      if (isBlocked(s, item)) throw new RepositoryError('blocked-conflict');
      item.wire ??= copy(item.batch); item.attempted = true; delete item.failure;
      return copy(item.wire);
    }),
    resolveRemote: id => write(s => {
      const conflict = s.conflicts[id] as Conflict | undefined;
      if (!conflict) throw new RepositoryError('missing-conflict');
      requireCurrentConflict(s, id);
      const affected = new Set(conflict.batch.mutations.map(entityKey));
      if (conflict.provenance?.kind === 'import') {
        const pending = ordered(s).filter(item => item.batch.mutations.some(mutation => affected.has(entityKey(mutation))));
        const latest = pending.at(-1);
        if (latest) {
          if (ordered(s).some(item => item !== latest && item.resolves?.includes(id))) throw new RepositoryError('resolution-in-flight');
          conflict.provenance.targetAtResolution = [...affected].flatMap(key => s.entities[key] ? [copy(s.entities[key] as Entity)] : []);
          latest.resolves = [...new Set([...(latest.resolves ?? []), id, ...conflictAncestors(storedConflictParents(s), id)])];
          return {batchId: latest.batch.batchId, state: 'saved-local'};
        }
        for (const parent of conflictAncestors(storedConflictParents(s), id)) delete s.conflicts[parent];
        delete s.conflicts[id]; delete s.cursors[`conflict-parents:${id}`];
        return {batchId: conflict.batch.batchId, state: 'saved-local'};
      }
      // Explicit remote acceptance discards unsent edits to this conflict unit only.
      // A possibly delivered batch must receive its original server receipt first.
      const descendants = ordered(s).filter(item => item.resolves?.includes(id) || item.batch.mutations.some(m => affected.has(entityKey(m))));
      if (descendants.some(item => item.attempted)) throw new RepositoryError('resolution-in-flight');
      if (descendants.some(item => !item.resolves?.includes(id) && item.batch.mutations.some(m => !affected.has(entityKey(m))))) throw new RepositoryError('mixed-dependent-batch');
      for (const item of descendants) delete s.outbox[item.batch.batchId];
      delete s.conflicts[id];
      for (const parent of (s.cursors[`conflict-parents:${id}`] as Id[] | undefined) ?? []) delete s.conflicts[parent];
      delete s.cursors[`conflict-parents:${id}`]; rebuild(s);
      return {batchId: conflict.batch.batchId, state: 'saved-local'};
    }),
    cursor: () => read(s => (s.cursors.pull as number | undefined) ?? 0),
    conflicts: () => read(s => Object.values(s.conflicts) as Conflict[]),
    recordFailure: (batchId, code) => write(s => {if (!text(code)) throw new RepositoryError('invalid'); const entry = s.outbox[batchId] as Outbox | undefined; if (entry) entry.failure = code;}),
    apply: async page => {page = copy(page); return write(s => {
      canonical(page);
      const cursor = (s.cursors.pull as number | undefined) ?? 0;
      if (!natural(page.nextCursor) || page.nextCursor < cursor || !Array.isArray(page.changes) || typeof page.hasMore !== 'boolean') throw new RepositoryError('invalid');
      let last = cursor;
      for (const change of page.changes) {
        if (!natural(change.cursor) || change.cursor <= last || change.cursor > page.nextCursor || !text(change.batchId) || !Array.isArray(change.entities)) throw new RepositoryError('invalid');
        putConfirmed(s, change.entities); last = change.cursor;
      }
      if (last !== page.nextCursor) throw new RepositoryError('invalid', 'Cursor cannot skip a change');
      s.cursors.pull = page.nextCursor; rebuild(s);
    });},
    accept: async result => {result = copy(result); return write(s => {
      canonical(result);
      if (result.status === 'applied') {
        putConfirmed(s, result.change.entities);
        const acknowledged = s.outbox[result.change.batchId] as Outbox | undefined;
        for (const conflictId of acknowledged?.resolves ?? []) delete s.conflicts[conflictId];
        delete s.outbox[result.change.batchId];
        // Rebase only a direct unsent descendant of an actual acknowledged predecessor.
        // A pulled intervening remote revision invalidates that causal shortcut.
        if (acknowledged) for (const item of ordered(s)) {
          if (item.attempted) continue;
          const wire = copy(item.wire ?? item.batch);
          for (const m of wire.mutations) {
            const key = entityKey(m);
            if (item.predecessors?.[key] !== result.change.batchId) continue;
            const acknowledgedEntity = result.change.entities.find(entity => keyOf(entity) === key);
            const current = s.confirmed[key] as Entity | undefined;
            if (acknowledgedEntity && current?.revision === acknowledgedEntity.revision && !current.deletedAt) m.baseRevision = acknowledgedEntity.revision;
            delete item.predecessors![key];
          }
          item.wire = wire;
        }
      } else if (result.status === 'conflict') {
        validateBatch(result.conflict.batch); result.conflict.local.forEach(validateEntity); result.conflict.remote.forEach(validateEntity);
        const failed = s.outbox[result.conflict.batch.batchId] as Outbox | undefined;
        const retained = copy(result.conflict);
        retained.local = retained.local.map(entity => {
          const deletion = failed?.batch.mutations.find(m => m.action === 'delete' && entityKey(m) === keyOf(entity));
          const snapshot = deletion && failed?.localSnapshots?.find(local => keyOf(local) === keyOf(entity));
          return snapshot ? copy(snapshot) : entity;
        });
        s.conflicts[result.conflict.id] = retained;
        // Carry original alternatives through repeated resolution conflicts.
        if (failed?.resolves?.length) s.cursors[`conflict-parents:${result.conflict.id}`] = copy(failed.resolves);
        delete s.outbox[result.conflict.batch.batchId];
        putConfirmed(s, result.conflict.remote);
      } else throw new RepositoryError('invalid');
      // Push responses may be ahead of unpulled changes. Only apply() advances cursor.
      rebuild(s);
    });},
    commitResolution: async (id, batch) => {batch = copy(batch); return write(s => {
      if (!s.conflicts[id]) throw new RepositoryError('missing-conflict');
      requireCurrentConflict(s, id);
      const sourceConflict = s.conflicts[id] as Conflict;
      if (sourceConflict.provenance?.kind === 'import') sourceConflict.provenance.targetAtResolution = sourceConflict.batch.mutations.flatMap(mutation => {
        const target = s.entities[entityKey(mutation)] as Entity | undefined; return target ? [copy(target)] : [];
      });
      const receipt = enqueue(s, batch, options);
      if (ordered(s).some(item => item.batch.batchId !== batch.batchId && item.resolves?.includes(id))) throw new RepositoryError('resolution-in-flight');
      const replacement = s.outbox[batch.batchId] as Outbox | undefined;
      if (!replacement) throw new RepositoryError('invalid', 'A resolution must have a pending replacement batch');
      const parents = conflictAncestors(storedConflictParents(s), id);
      replacement.resolves = [...new Set([...(replacement.resolves ?? []), id, ...(parents ?? [])])];
      // The chosen replacement supersedes only unsent descendants that touch the
      // same conflict unit. Keep their original receipts as an audit/idempotency record.
      const conflict = s.conflicts[id] as Conflict;
      const affected = new Set(conflict.batch.mutations.map(entityKey));
      const importCopy = conflict.provenance?.kind === 'import' && batch.mutations.every(mutation => !affected.has(entityKey(mutation)));
      for (const item of ordered(s)) if (!importCopy && item !== replacement && item.batch.mutations.some(m => affected.has(entityKey(m)))) {
        if (item.attempted) throw new RepositoryError('resolution-in-flight');
        // Never drop a mixed atomic action with unrelated records implicitly.
        if (item.batch.mutations.some(m => !affected.has(entityKey(m)))) throw new RepositoryError('mixed-dependent-batch');
        delete s.outbox[item.batch.batchId];
      }
      replacement.predecessors = {};
      // The alternatives survive crashes, transport errors and repeated conflicts.
      // Only successful acknowledgment of this associated batch removes them.
      return receipt;
    });},
    importV1: async input => {
      if (driver.readonly) throw new RepositoryError('readonly-schema', 'Future container is read-only', true);
      input = copy(input);
      if (!(input.sourceSnapshot instanceof Uint8Array) || await sourceFingerprint(input.sourceSnapshot) !== input.fingerprint) throw new RepositoryError('invalid', 'Source fingerprint mismatch');
      return write(s => {
      if (!text(input.fingerprint) || !(input.sourceSnapshot instanceof Uint8Array)) throw new RepositoryError('invalid');
      const previous = s.migrations[input.fingerprint] as MigrationStatus | undefined;
      if (previous) return {fingerprint: input.fingerprint, imported: 0};
      canonical(input.devicePreferences); input.entities.forEach(validateEntity);
      if (!deviceId) throw new RepositoryError('readonly-schema');
      const batchId = deterministicId(`${deviceId}:${input.fingerprint}:batch`), mutations: Mutation[] = [], collisions: Entity[] = [], existing: Entity[] = [];
      const keys = new Set<string>();
      for (const entity of input.entities) {
        const key = keyOf(entity); if (keys.has(key)) throw new RepositoryError('invalid', 'Duplicate legacy entity ID'); keys.add(key);
        const current = s.entities[key] as Entity | undefined;
        if (current) {if (!contentEqual(entity, current)) {collisions.push(entity); existing.push(current);} continue;}
        mutations.push({operationId: deterministicId(`${batchId}:${entity.moduleId}:${entity.id}`), deviceId, entityId: entity.id, moduleId: entity.moduleId, kind: entity.kind, schemaVersion: entity.schemaVersion, baseRevision: null, createdAt: entity.createdAt, updatedAt: entity.updatedAt, action: entity.deletedAt ? 'delete' : 'put', payload: entity.payload});
      }
      if (mutations.length) for (const batch of boundedBatches({batchId, mutations})) enqueue(s, batch, options);
      if (collisions.length) {
        const conflictBatch: MutationBatch = {batchId: deterministicId(`${batchId}:conflict`), mutations: collisions.map(e => ({operationId: deterministicId(`${batchId}:conflict:${e.id}`), deviceId, entityId: e.id, moduleId: e.moduleId, kind: e.kind, schemaVersion: e.schemaVersion, baseRevision: null, createdAt: e.createdAt, updatedAt: e.updatedAt, action: 'put', payload: e.payload}))};
        const conflict: Conflict = {id: deterministicId(`${batchId}:conflict`), batch: conflictBatch, local: copy(collisions), remote: copy(existing), reason: 'import-collision', provenance: {kind: 'import', sourceFingerprint: input.fingerprint}};
        s.conflicts[conflict.id] = conflict;
      }
      // All recovery material, preferences and activation are committed with entities/outbox.
      if (Object.keys(s.migrations).length === 0) s.device_preferences.current = copy(input.devicePreferences);
      s.device_preferences[`migration:${input.fingerprint}`] = copy(input.devicePreferences);
      s.migrations[input.fingerprint] = {fingerprint: input.fingerprint, active: true, imported: mutations.length, snapshot: Array.from(input.sourceSnapshot)} satisfies MigrationStatus;
      return {fingerprint: input.fingerprint, imported: mutations.length};
    });},
    migrationStatus: fingerprint => read(s => {const value = s.migrations[fingerprint] as MigrationStatus | undefined; if (!value) return null; const {snapshot: _snapshot, ...status} = value; return status;}),
    recoverySnapshot: fingerprint => read(s => {const value = s.migrations[fingerprint] as MigrationStatus | undefined; return value ? new Uint8Array(value.snapshot) : null;}),
    devicePreferences: () => read(s => (s.device_preferences.current as JsonValue | undefined) ?? null)
  };
  return repository;
}
