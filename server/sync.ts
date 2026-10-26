import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Change, Entity, JsonValue, Mutation, MutationBatch, PullPage, PushResult } from '../src/workbench/contracts/data';
import type { EntitySchema, ModuleManifest } from '../src/workbench/contracts/module';
import {SYNC_MAX_MUTATIONS, SYNC_MAX_BODY_BYTES} from '../src/workbench/contracts/sync';
import type { SyncHello, SyncWelcome } from '../src/workbench/contracts/sync';
import { transaction } from './database';

export type SchemaRegistry = Record<string, Record<string, Pick<EntitySchema, 'version' | 'parse'>>>;
/** Supply only pure manifest definitions; this service never imports a module's UI. */
export function registryFromManifests(manifests: readonly ModuleManifest[]): SchemaRegistry {
  const registry: SchemaRegistry = Object.create(null);
  for (const manifest of manifests) {
    if (Object.hasOwn(registry, manifest.id)) throw new Error('DUPLICATE_MODULE');
    registry[manifest.id] = manifest.schemas;
  }
  return registry;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('INVALID_BATCH');
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,99}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
function exact(value: object, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function validateBatch(batch: MutationBatch): void {
  if (!batch || typeof batch !== 'object' || !exact(batch, ['batchId', 'mutations']) || !id(batch.batchId) || !Array.isArray(batch.mutations) || batch.mutations.length < 1 || batch.mutations.length > SYNC_MAX_MUTATIONS) throw new Error('INVALID_BATCH');
  const operations = new Set<string>(); const entities = new Set<string>();
  for (const mutation of batch.mutations) {
    if (!mutation || typeof mutation !== 'object' || !exact(mutation, ['operationId','deviceId','entityId','moduleId','kind','schemaVersion','baseRevision','createdAt','updatedAt','action','payload']) || !id(mutation.operationId) || !id(mutation.deviceId) || !id(mutation.entityId) || !label(mutation.moduleId) || !label(mutation.kind) || !Number.isSafeInteger(mutation.schemaVersion) || mutation.schemaVersion < 1 || !(mutation.baseRevision === null || Number.isSafeInteger(mutation.baseRevision) && mutation.baseRevision > 0) || !iso(mutation.createdAt) || !iso(mutation.updatedAt) || !['put','delete'].includes(mutation.action) || mutation.action === 'delete' && mutation.payload !== null) throw new Error('INVALID_BATCH');
    if (operations.has(mutation.operationId)) throw new Error('BATCH_MISMATCH');
    const key = `${mutation.moduleId}/${mutation.entityId}`;
    if (entities.has(key)) throw new Error('INVALID_BATCH');
    operations.add(mutation.operationId); entities.add(key);
  }
  if (Buffer.byteLength(canonical(batch), 'utf8') > SYNC_MAX_BODY_BYTES) throw new Error('BATCH_TOO_LARGE');
  canonical(batch); // Reject undefined, NaN, functions and non-JSON payloads before entering SQLite.
}
function localEnvelope(mutation: Mutation): Entity {
  return { id: mutation.entityId, moduleId: mutation.moduleId, kind: mutation.kind, schemaVersion: mutation.schemaVersion, revision: mutation.baseRevision ?? 0, createdAt: mutation.createdAt, updatedAt: mutation.updatedAt, deletedAt: mutation.action === 'delete' ? mutation.updatedAt : null, payload: mutation.payload };
}
export class SyncService {
  constructor(private readonly db: DatabaseSync, private readonly schemas: SchemaRegistry) {}
  handshake(hello: SyncHello): SyncWelcome {
    if (!hello || typeof hello !== 'object' || !hello.schemas || typeof hello.schemas !== 'object' || Array.isArray(hello.schemas)) throw new Error('INVALID_HANDSHAKE');
    const readonlyKinds: string[] = [];
    for (const [moduleId, kinds] of Object.entries(this.schemas)) for (const [kind, schema] of Object.entries(kinds)) {
      if (hello.schemas[moduleId]?.[kind] !== schema.version) readonlyKinds.push(`${moduleId}/${kind}`);
    }
    return { compatible: hello.protocolVersion === 1 && hello.hostApiVersion === 1, minimumProtocol: 1, readonlyKinds };
  }
  async applyBatch(accountId: string, batch: MutationBatch): Promise<PushResult> {
    validateBatch(batch);
    const fingerprint = createHash('sha256').update(canonical(batch)).digest('hex');
    return transaction(this.db, () => {
      const receipt = this.db.prepare('SELECT fingerprint,result_json FROM sync_batches WHERE account_id=? AND batch_id=?').get(accountId, batch.batchId) as { fingerprint: string; result_json: string } | undefined;
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new Error('BATCH_MISMATCH'); return JSON.parse(receipt.result_json) as PushResult; }
      for (const mutation of batch.mutations) {
        if (this.db.prepare('SELECT batch_id FROM sync_operations WHERE account_id=? AND operation_id=?').get(accountId, mutation.operationId)) throw new Error('BATCH_MISMATCH');
      }
      const remote: Entity[] = []; const candidates: Entity[] = []; let conflict: 'stale' | 'deleted' | null = null;
      for (const mutation of batch.mutations) {
        const schema = Object.hasOwn(this.schemas, mutation.moduleId) && Object.hasOwn(this.schemas[mutation.moduleId], mutation.kind) ? this.schemas[mutation.moduleId][mutation.kind] : undefined;
        if (!schema) throw new Error('UNKNOWN_SCHEMA');
        if (schema.version !== mutation.schemaVersion) throw new Error('SCHEMA_VERSION_UNSUPPORTED');
        if (mutation.action === 'put') { try { schema.parse(mutation.payload); } catch { throw new Error('INVALID_PAYLOAD'); } }
        const row = this.db.prepare('SELECT envelope FROM sync_entities WHERE account_id=? AND module_id=? AND entity_id=?').get(accountId, mutation.moduleId, mutation.entityId) as { envelope: string } | undefined;
        const current: Entity | undefined = row ? JSON.parse(row.envelope) as Entity : undefined;
        if (current) remote.push(current);
        // Deletions are permanent identities in v1. Restoring means making a separate copy.
        if (current?.deletedAt) conflict = 'deleted';
        else if (current ? mutation.baseRevision !== current.revision || mutation.kind !== current.kind : mutation.baseRevision !== null || mutation.action === 'delete') conflict ??= 'stale';
        if (current && current.schemaVersion > mutation.schemaVersion) throw new Error('SCHEMA_VERSION_UNSUPPORTED');
        candidates.push({ ...current, ...localEnvelope(mutation), revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? mutation.createdAt, payload: mutation.action === 'delete' && current ? current.payload : mutation.payload });
      }
      let result: PushResult;
      if (conflict) result = { status: 'conflict', conflict: { id: randomUUID(), batch, local: batch.mutations.map(localEnvelope), remote, reason: conflict } };
      else {
        for (const entity of candidates) this.db.prepare('INSERT INTO sync_entities(account_id,module_id,entity_id,envelope) VALUES (?,?,?,?) ON CONFLICT(account_id,module_id,entity_id) DO UPDATE SET envelope=excluded.envelope').run(accountId, entity.moduleId, entity.id, JSON.stringify(entity));
        const inserted = this.db.prepare('INSERT INTO sync_changes(account_id,batch_id,change_json) VALUES (?,?,?)').run(accountId, batch.batchId, '{}');
        const change: Change = { cursor: Number(inserted.lastInsertRowid), batchId: batch.batchId, entities: candidates };
        this.db.prepare('UPDATE sync_changes SET change_json=? WHERE cursor=?').run(JSON.stringify(change), change.cursor);
        result = { status: 'applied', change };
      }
      this.db.prepare('INSERT INTO sync_batches(account_id,batch_id,fingerprint,result_json) VALUES (?,?,?,?)').run(accountId, batch.batchId, fingerprint, JSON.stringify(result));
      for (const mutation of batch.mutations) this.db.prepare('INSERT INTO sync_operations(account_id,operation_id,batch_id) VALUES (?,?,?)').run(accountId, mutation.operationId, batch.batchId);
      return result;
    });
  }
  async pullChanges(accountId: string, cursor: number, limit: number): Promise<PullPage> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_CURSOR');
    const rows = this.db.prepare('SELECT change_json FROM sync_changes WHERE account_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(accountId, cursor, limit + 1) as { change_json: string }[];
    const changes = rows.slice(0, limit).map(row => JSON.parse(row.change_json) as Change);
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor, hasMore: rows.length > limit };
  }
}
