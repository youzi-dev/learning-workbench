import type {Conflict, Entity, JsonValue} from './data';
import type {BlobDescriptor} from './files';
export type MigrationMarker = {fingerprint: string; active: boolean; imported: number};
export type RepositoryBackupData = {
  entities: Entity[];
  conflicts: Conflict[];
  conflictParents?: Record<string, string[]>;
  migrationMarkers: MigrationMarker[];
  devicePreferences: JsonValue | null;
  files: BlobDescriptor[];
};
export type BackupImport = RepositoryBackupData & {fingerprint: string; restoreDevicePreferences: boolean};
