/** Browser-safe wire contracts. Server revisions never represent local edit order. */
export type Id = string;
export type IsoTime = string;
export type ModuleId = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type Entity<T = JsonValue> = {id: Id; moduleId: ModuleId; kind: string; schemaVersion: number; revision: number; createdAt: IsoTime; updatedAt: IsoTime; deletedAt: IsoTime | null; payload: T};
export type EntityRef = {moduleId: ModuleId; entityId: Id};
export type Mutation = {operationId: Id; deviceId: Id; entityId: Id; moduleId: ModuleId; kind: string; schemaVersion: number; baseRevision: number | null; createdAt: IsoTime; updatedAt: IsoTime; action: 'put' | 'delete'; payload: JsonValue | null};
export type MutationBatch = {batchId: Id; mutations: Mutation[]};
export type Change = {cursor: number; batchId: Id; entities: Entity[]};
export type Conflict = {id: Id; batch: MutationBatch; local: Entity[]; remote: Entity[]; reason: 'stale' | 'deleted' | 'import-collision'; provenance?: {kind: 'import'; sourceFingerprint: string; targetAtResolution?: Entity[]}};
export type PushResult = {status: 'applied'; change: Change} | {status: 'conflict'; conflict: Conflict};
export type PullPage = {changes: Change[]; nextCursor: number; hasMore: boolean};
export type LocalReceipt = {batchId: Id; state: 'saved-local'};
