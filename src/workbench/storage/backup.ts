import type {Conflict, Entity, JsonValue, LocalReceipt} from '../contracts/data';
import type {BlobDescriptor} from '../contracts/files';
import type {BackupImport, MigrationMarker, RepositoryBackupData} from '../contracts/backup';
import {SYNC_MAX_BODY_BYTES} from '../contracts/sync';
import {canonical, deterministicId, sourceFingerprint, validateEntity} from './repository';
import {validateConflictParents} from './conflict-lineage';
import {sha256, validateFile} from '../files/storage';
export type BackupDocument = {
  format: 'growth-workbench';
  schemaVersion: 2;
  exportedAt: string;
  entities: Entity[];
  conflicts: Conflict[];
  conflictParents?: Record<string, string[]>;
  migrationMarkers: MigrationMarker[];
  files: BlobDescriptor[];
  devicePreferences: JsonValue | null;
  fileContents?: Record<string, string | number[]>;
};
export type RestorePreview = {
  batchId: string;
  entities: Entity[];
  files: BlobDescriptor[];
  conflicts: Conflict[];
  missingFiles: string[];
  readonly: boolean;
  source: Uint8Array;
  devicePreferences: JsonValue | null;
};
export interface BackupRepository {
  readonly deviceId: string | null;
  get(ref: {moduleId: string; entityId: string}): Promise<Entity | null>;
  exportData(): Promise<RepositoryBackupData>;
  importData(data: BackupImport): Promise<LocalReceipt>;
}
export type BackupFiles = {
  read(file: BlobDescriptor): Promise<Uint8Array | null>;
  write(file: BlobDescriptor, bytes: Uint8Array): Promise<void>;
  restored?(): Promise<void>;
};
export const MAX_EMBEDDED_FILE_BYTES = 32 * 1024 ** 2;
export const MAX_BACKUP_JSON_BYTES = 64 * 1024 ** 2;
type Options = {schemas?: Record<string, Record<string, number>>; files?: BackupFiles; now?: () => string};
/** An explicit device-only allowlist. Legacy settings/model profiles and recovery
 * snapshots can contain plaintext keys and are never ordinary backup fields. */
export function safeDevicePreferences(value: JsonValue | null): JsonValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, JsonValue> = {};
  if (['light', 'dark', 'system'].includes(value.theme as string)) result.theme = value.theme;
  for (const key of ['locale', 'timeZone']) if (typeof value[key] === 'string' && /^[A-Za-z0-9_+./-]{1,80}$/.test(value[key])) result[key] = value[key];
  if (typeof value.cacheBudgetBytes === 'number' && Number.isSafeInteger(value.cacheBudgetBytes) && value.cacheBudgetBytes >= 0) result.cacheBudgetBytes = value.cacheBudgetBytes;
  if (Array.isArray(value.enabledModules) && value.enabledModules.every(item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,60}$/.test(item))) result.enabledModules = value.enabledModules;
  return result;
}
function contentEqual(first: Entity, second: Entity): boolean {
  return first.kind === second.kind && first.schemaVersion === second.schemaVersion && first.deletedAt === second.deletedAt && canonical(first.payload) === canonical(second.payload);
}
function collectFiles(value: unknown, output: Map<string, BlobDescriptor>): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Partial<BlobDescriptor>;
  if (typeof record.sha256 === 'string' && typeof record.size === 'number' && typeof record.mime === 'string') {
    const file = {sha256: record.sha256, size: record.size, mime: record.mime}; validateFile(file); output.set(file.sha256, file);
  }
  for (const child of Object.values(value)) collectFiles(child, output);
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
function unbase64(value: string | number[]): Uint8Array {
  if (Array.isArray(value)) {
    if (!value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('INVALID_FILE_CONTENT');
    return new Uint8Array(value);
  }
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('INVALID_FILE_CONTENT');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function validateConflict(conflict: Conflict): void {
  canonical(conflict);
  if (!conflict || typeof conflict.id !== 'string' || !Array.isArray(conflict.local) || !Array.isArray(conflict.remote) || !conflict.batch || !Array.isArray(conflict.batch.mutations) || !['stale', 'deleted', 'import-collision'].includes(conflict.reason)) throw new Error('INVALID_BACKUP_CONFLICT');
  conflict.local.forEach(validateEntity); conflict.remote.forEach(validateEntity);
}
export class BackupService {
  private readonly previews = new WeakMap<RestorePreview, {document: BackupDocument; fingerprint: string; contents: Map<string, Uint8Array>; readonly: boolean}>();
  constructor(private readonly repository: BackupRepository, private readonly options: Options = {}) {}
  async exportBackup(options: {includeFiles?: boolean} = {}): Promise<Uint8Array> {
    const data = await this.repository.exportData();
    const files = new Map(data.files.map(file => [file.sha256, file])); collectFiles(data.entities, files); collectFiles(data.conflicts, files);
    const document: BackupDocument = {
      format: 'growth-workbench', schemaVersion: 2, exportedAt: this.options.now?.() ?? new Date().toISOString(),
      entities: data.entities, conflicts: data.conflicts, conflictParents: validateConflictParents(data.conflicts, data.conflictParents),
      migrationMarkers: data.migrationMarkers.map(({fingerprint, active, imported}) => ({fingerprint, active, imported})),
      files: [...files.values()], devicePreferences: safeDevicePreferences(data.devicePreferences)
    };
    if (options.includeFiles) {
      if (document.files.reduce((sum, file) => sum + file.size, 0) > MAX_EMBEDDED_FILE_BYTES) throw new Error('EMBEDDED_FILES_TOO_LARGE');
      document.fileContents = {};
      for (const file of document.files) {
        const bytes = await this.options.files?.read(file);
        if (!bytes) continue; // Directory-only backups explicitly list missing content in preview.
        if (bytes.length !== file.size || await sha256(bytes) !== file.sha256) throw new Error('CHECKSUM_MISMATCH');
        document.fileContents[file.sha256] = base64(bytes);
      }
    }
    const bytes = new TextEncoder().encode(canonical(document));
    if (bytes.length > MAX_BACKUP_JSON_BYTES) throw new Error('BACKUP_TOO_LARGE');
    return bytes;
  }
  async previewRestore(source: Uint8Array): Promise<RestorePreview> {
    if (source.byteLength > MAX_BACKUP_JSON_BYTES) throw new Error('BACKUP_TOO_LARGE');
    const bytes = new Uint8Array(source);
    let raw: BackupDocument;
    try {raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); canonical(raw);} catch {throw new Error('INVALID_BACKUP');}
    if (!raw || raw.format !== 'growth-workbench' || !Number.isSafeInteger(raw.schemaVersion) || raw.schemaVersion < 2) throw new Error('INVALID_BACKUP');
    const fingerprint = await sourceFingerprint(bytes), batchId = deterministicId(`${this.repository.deviceId}:${fingerprint}:restore`);
    if (raw.schemaVersion > 2) return {batchId, entities: [], files: [], conflicts: [], missingFiles: [], readonly: true, source: bytes, devicePreferences: null};
    if (!Array.isArray(raw.entities) || !Array.isArray(raw.conflicts) || !Array.isArray(raw.files) || !Array.isArray(raw.migrationMarkers) || !Number.isFinite(Date.parse(raw.exportedAt))) throw new Error('INVALID_BACKUP');
    const keys = new Set<string>(); let readonly = !this.repository.deviceId;
    for (const entity of raw.entities) {
      validateEntity(entity);
      const key = JSON.stringify([entity.moduleId, entity.id]); if (keys.has(key)) throw new Error('INVALID_BACKUP_DUPLICATE'); keys.add(key);
      if (new TextEncoder().encode(canonical(entity)).length + 1024 > SYNC_MAX_BODY_BYTES) throw new Error('ENTITY_TOO_LARGE');
      if (entity.schemaVersion > (this.options.schemas?.[entity.moduleId]?.[entity.kind] ?? (this.options.schemas ? 0 : 1))) readonly = true;
    }
    raw.conflicts.forEach(validateConflict);
    raw.conflictParents = validateConflictParents(raw.conflicts, raw.conflictParents);
    for (const conflict of raw.conflicts) for (const entity of [...conflict.local, ...conflict.remote]) if (entity.schemaVersion > (this.options.schemas?.[entity.moduleId]?.[entity.kind] ?? (this.options.schemas ? 0 : 1))) readonly = true;
    for (const marker of raw.migrationMarkers) if (!marker || typeof marker.fingerprint !== 'string' || typeof marker.active !== 'boolean' || !Number.isSafeInteger(marker.imported) || marker.imported < 0) throw new Error('INVALID_MIGRATION_MARKER');
    const contents = new Map<string, Uint8Array>(), missing: string[] = [], hashes = new Set<string>();
    let embeddedBytes = 0;
    for (const file of raw.files) {
      validateFile(file); if (hashes.has(file.sha256)) throw new Error('INVALID_BACKUP_DUPLICATE'); hashes.add(file.sha256);
      const content = raw.fileContents?.[file.sha256];
      if (content === undefined) {missing.push(file.sha256); continue;}
      const decodedLength = Array.isArray(content) ? content.length : typeof content === 'string' ? Math.floor(content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0) : 0;
      embeddedBytes += decodedLength;
      if (embeddedBytes > MAX_EMBEDDED_FILE_BYTES) throw new Error('EMBEDDED_FILES_TOO_LARGE');
      const fileBytes = unbase64(content); if (fileBytes.length !== file.size || await sha256(fileBytes) !== file.sha256) throw new Error('CHECKSUM_MISMATCH'); contents.set(file.sha256, fileBytes);
    }
    if (raw.fileContents && Object.keys(raw.fileContents).some(hash => !hashes.has(hash))) throw new Error('INVALID_BACKUP_FILE');
    const conflicts = structuredClone(raw.conflicts);
    for (const incoming of raw.entities) {
      const current = await this.repository.get({moduleId: incoming.moduleId, entityId: incoming.id});
      if (current && !contentEqual(incoming, current)) conflicts.push({id: deterministicId(`${batchId}:collision:${incoming.moduleId}:${incoming.id}`), batch: {batchId: deterministicId(`${batchId}:collision-batch:${incoming.id}`), mutations: []}, local: [structuredClone(incoming)], remote: [current], reason: 'import-collision'});
    }
    const preview: RestorePreview = {batchId, entities: structuredClone(raw.entities), files: structuredClone(raw.files), conflicts, missingFiles: missing, readonly, source: bytes, devicePreferences: safeDevicePreferences(raw.devicePreferences)};
    this.previews.set(preview, {document: structuredClone(raw), fingerprint, contents, readonly}); return preview;
  }
  async restore(preview: RestorePreview, options: {restoreDevicePreferences?: boolean} = {}): Promise<LocalReceipt> {
    const saved = this.previews.get(preview);
    if (preview.readonly || saved?.readonly) throw new Error('readonly');
    if (!saved) throw new Error('INVALID_RESTORE_PREVIEW');
    for (const file of saved.document.files) {
      const bytes = saved.contents.get(file.sha256);
      if (bytes) {if (!this.options.files) throw new Error('FILE_STORAGE_REQUIRED'); await this.options.files.write(file, bytes);}
    }
    const receipt = await this.repository.importData({
      fingerprint: saved.fingerprint, entities: saved.document.entities, conflicts: saved.document.conflicts, conflictParents: saved.document.conflictParents ?? {},
      files: saved.document.files, migrationMarkers: saved.document.migrationMarkers,
      devicePreferences: safeDevicePreferences(saved.document.devicePreferences), restoreDevicePreferences: options.restoreDevicePreferences ?? false
    });
    await this.options.files?.restored?.();
    return receipt;
  }
}
