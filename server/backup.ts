import {createHash, randomUUID} from 'node:crypto';
import {backup as sqliteBackup, DatabaseSync} from 'node:sqlite';
import {closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync} from 'node:fs';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertSqliteRuntime, isSafeSqliteVersion} from './database';
import {validateBlob} from './blob-descriptor';
import type {BlobDescriptor} from '../src/workbench/contracts/files';

const OWNER = 'personal-workbench-operator-backup';
const LOCK_APPLICATION_ID = 0x57504231;
const HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT_NAME = /^snapshot-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
const BLOB_PATH = /^blobs\/([a-f0-9]{64})\/([a-f0-9]{64})(\.json)?$/;
const INVARIANTS = {
  immutableCommittedBlobs: true, blobGarbageCollection: false, uploadStagingIncluded: false,
  captureKeyIncluded: false, captureInputs: 'encrypted-with-original-absolute-expiry',
  businessWriter: 'api-only', databaseFile: 'database.sqlite', restoredDatabaseFile: 'db.sqlite',
} as const;
type FileDigest = {path: string; sha256: string; size: number};
type TableDigest = {name: string; rows: number; sha256: string};
export type BackupManifest = {
  version: 1; owner: typeof OWNER; id: string; createdAt: string;
  database: FileDigest & {schemaVersion: number; sqliteVersion: string; nodeVersion: string; logicalSha256: string; tables: TableDigest[]};
  files: FileDigest[]; invariants: typeof INVARIANTS;
};
export type BackupProgress = {phase: 'snapshot-progress'; remainingPages: number; totalPages: number} | {phase: 'snapshot-complete'};
export type BackupOptions = {
  databasePath: string; blobDirectory: string; backupRoot: string; now?: () => Date;
  sqliteRate?: number; onProgress?: (event: BackupProgress) => void; retain?: boolean;
};
export type RetentionResult = {kept: string[]; removed: string[]; untouched: string[]};
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const supportedNode = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version) && Number(version.split('.')[0]) >= 24;
function fail(code: string): never {throw Error(code);}
function quote(value: string): string {return `"${value.replaceAll('"', '""')}"`;}
function syncDir(path: string): void {const fd = openSync(path, 'r'); try {fsyncSync(fd);} finally {closeSync(fd);}}
/** Refuse symlinks in every existing path component, including ancestors. */
function safePath(path: string): string {
  const absolute = resolve(path); let current = absolute;
  while (true) {
    try {if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const parent = dirname(current); if (parent === current) return absolute; current = parent;
  }
}
function privateDir(path: string): void {
  safePath(path); mkdirSync(path, {recursive: true, mode: 0o700});
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail('PRIVATE_DIRECTORY_REQUIRED');
}
function durableJson(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd);} finally {closeSync(fd);}
}
function regular(path: string): void {safePath(path); if (!lstatSync(path).isFile()) fail('REGULAR_FILE_REQUIRED');}
/** Hash from a no-follow file descriptor; copies never preserve permissive modes. */
function digestFile(path: string, destination?: string): {sha256: string; size: number} {
  regular(path); const source = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target: number | undefined;
  const hash = createHash('sha256'), bytes = Buffer.alloc(1024 * 1024); let size = 0;
  try {
    if (destination) target = openSync(destination, 'wx', 0o600);
    const before = fstatSync(source);
    for (;;) {
      const count = readSync(source, bytes, 0, bytes.length, null); if (!count) break;
      hash.update(bytes.subarray(0, count)); size += count;
      if (target !== undefined) {let offset = 0; while (offset < count) {const n = writeSync(target, bytes, offset, count - offset); if (!n) fail('DISK_WRITE_FAILED'); offset += n;}}
    }
    const after = fstatSync(source);
    if (before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('FILE_CHANGED_DURING_COPY');
    if (target !== undefined) fsyncSync(target);
    return {sha256: hash.digest('hex'), size};
  } finally {closeSync(source); if (target !== undefined) closeSync(target);}
}
function same(a: unknown, b: unknown): boolean {return JSON.stringify(a) === JSON.stringify(b);}
function validDigest(value: unknown): value is FileDigest {
  if (!value || typeof value !== 'object') return false; const v = value as FileDigest;
  return typeof v.path === 'string' && HASH.test(v.sha256) && Number.isSafeInteger(v.size) && v.size >= 0;
}
function openRead(path: string, immutable = false): DatabaseSync {regular(path); const db = new DatabaseSync(immutable ? `${pathToFileURL(path).href}?immutable=1` : path, {readOnly: true}); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000'); return db;}
function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `{"bigint":${JSON.stringify(value.toString())}}`;
  if (value instanceof Uint8Array) return `{"bytes":${JSON.stringify(Buffer.from(value).toString('base64'))}}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** All SQL tables (including future modules and sqlite_sequence), exact values, order independent. */
function inspectDatabase(path: string): {schemaVersion: number; sqliteVersion: string; logicalSha256: string; tables: TableDigest[]; references: Map<string, BlobDescriptor>} {
  const db = openRead(path, true);
  try {
    if (!supportedNode(process.versions.node)) fail('DATABASE_RUNTIME_UNSUPPORTED');
    const sqliteVersion = assertSqliteRuntime(db), schemaVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (schemaVersion !== 1) fail('DATABASE_VERSION_UNSUPPORTED');
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')) fail('DATABASE_INTEGRITY');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('DATABASE_FOREIGN_KEY');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name: string}[]).map(row => row.name);
    for (const name of ['accounts','devices','sync_entities','sync_changes','sync_batches','sync_operations']) if (!names.includes(name)) fail('DATABASE_SCHEMA_UNSUPPORTED');
    const accounts = (db.prepare('SELECT id FROM accounts').all() as {id: string}[]).map(row => row.id);
    const jobAccounts = new Map<string, string>(names.includes('capture_jobs') ? (db.prepare('SELECT id,account_id FROM capture_jobs').all() as {id: string; account_id: string}[]).map(row => [row.id, row.account_id]) : []);
    const references = new Map<string, BlobDescriptor>(), tables: TableDigest[] = [];
    function walk(value: unknown, account: string | undefined): void {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {for (const item of value) walk(item, account); return;}
      const object = value as Record<string, unknown>;
      // This is a descriptor-local contract. Ancestor task state never suppresses attachments.
      if (Object.hasOwn(object, 'sha256') && Object.hasOwn(object, 'size') && Object.hasOwn(object, 'mime') && object.availability !== 'pending' && object.availability !== 'link-only') {
        const file = {sha256: object.sha256, size: object.size, mime: object.mime} as BlobDescriptor;
        validateBlob(file); if (!account || !accounts.includes(account)) fail('BLOB_ACCOUNT_UNRESOLVED');
        const path = `blobs/${sha(account)}/${file.sha256}`, previous = references.get(path);
        if (previous && (previous.sha256 !== file.sha256 || previous.size !== file.size)) fail('DESCRIPTOR_MISMATCH'); references.set(path, file);
      }
      for (const item of Object.values(object)) walk(item, account);
    }
    for (const name of names) {
      const statement = db.prepare(`SELECT * FROM ${quote(name)}`); statement.setReadBigInts(true);
      const rows = statement.all();
      const rowHashes = rows.map(row => sha(canonical(row))).sort();
      tables.push({name, rows: rows.length, sha256: sha(rowHashes.join('\n'))});
      for (const row of rows) {
        const account = typeof row.account_id === 'string' ? row.account_id : typeof row.job_id === 'string' ? jobAccounts.get(row.job_id) : accounts.length === 1 ? accounts[0] : undefined;
        for (const [column, value] of Object.entries(row)) if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
          let parsed: unknown;
          try {parsed = JSON.parse(value);} catch {
            if (column === 'envelope' || /(?:^|_)json$/.test(column)) fail('DATABASE_JSON_INVALID');
            continue; // An opaque future SQL text field is not a JSON reference.
          }
          walk(parsed, account);
        }
      }
    }
    return {schemaVersion, sqliteVersion, logicalSha256: sha(canonical({schema, tables})), tables, references};
  } finally {db.close();}
}
function checkDescriptor(path: string, file: BlobDescriptor, bytes: {sha256: string; size: number}): void {
  if (bytes.sha256 !== file.sha256 || bytes.size !== file.size || basename(path) !== file.sha256) fail('BLOB_CORRUPT');
}
/** The immutable committed marker is the visibility boundary; uploads and unmarked bytes are omitted. */
function copyCommittedBlobs(source: string, target: string): FileDigest[] {
  safePath(source); if (!existsSync(source)) fail('BLOB_DIRECTORY_REQUIRED');
  const files: FileDigest[] = []; privateDir(join(target, 'blobs'));
  for (const account of readdirSync(source).sort()) {
    const accountPath = join(source, account); if (lstatSync(accountPath).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    if (!HASH.test(account)) continue; if (!lstatSync(accountPath).isDirectory()) fail('BLOB_DIRECTORY_INVALID');
    for (const name of readdirSync(accountPath).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const blobHash = name.slice(0, 64), relative = `blobs/${account}/${blobHash}`, marker = join(accountPath, name);
      privateDir(join(target, 'blobs', account));
      const markerDigest = digestFile(marker, join(target, `${relative}.json`));
      let file: BlobDescriptor; try {file = JSON.parse(readFileSync(join(target, `${relative}.json`), 'utf8')); validateBlob(file);} catch {fail('BLOB_DESCRIPTOR_INVALID');}
      if (file.sha256 !== blobHash) fail('BLOB_DESCRIPTOR_MISMATCH');
      let bytes: {sha256: string; size: number};
      try {bytes = digestFile(join(accountPath, blobHash), join(target, relative));} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('BLOB_MISSING'); throw error;}
      checkDescriptor(join(accountPath, blobHash), file, bytes);
      files.push({path: relative, ...bytes}, {path: `${relative}.json`, ...markerDigest});
    }
    if (existsSync(join(target, 'blobs', account))) syncDir(join(target, 'blobs', account));
  }
  syncDir(join(target, 'blobs')); return files.sort((a, b) => a.path.localeCompare(b.path));
}
function verifyBlobs(root: string, files: FileDigest[], references: Map<string, BlobDescriptor>): void {
  const indexed = new Map(files.map(file => [file.path, file]));
  for (const file of files) {
    const actual = digestFile(join(root, file.path)); if (!same(actual, {sha256: file.sha256, size: file.size})) fail('FILE_HASH_MISMATCH');
    if (file.path.endsWith('.json')) continue;
    const marker = indexed.get(`${file.path}.json`); if (!marker) fail('BLOB_MARKER_MISSING');
    let descriptor: BlobDescriptor; try {descriptor = JSON.parse(readFileSync(join(root, marker.path), 'utf8')); validateBlob(descriptor);} catch {fail('BLOB_DESCRIPTOR_INVALID');}
    checkDescriptor(file.path, descriptor, actual);
    const required = references.get(file.path); if (required && (descriptor.sha256 !== required.sha256 || descriptor.size !== required.size)) fail('DESCRIPTOR_MISMATCH');
  }
  for (const file of files) if (file.path.endsWith('.json') && !indexed.has(file.path.slice(0, -5))) fail('BLOB_MISSING');
  for (const [path] of references) if (!indexed.has(path) || !indexed.has(`${path}.json`)) fail('BLOB_REQUIRED_MISSING');
}
function checkInventory(root: string, manifest: BackupManifest): void {
  const expectedFiles = new Set(['database.sqlite', 'manifest.json', 'complete.json', ...manifest.files.map(file => file.path)]);
  const expectedDirs = new Set(['blobs', ...manifest.files.map(file => dirname(file.path))]);
  function walk(directory: string, relative = ''): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), rel = relative ? `${relative}/${name}` : name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) {if (!expectedDirs.has(rel)) fail('UNEXPECTED_BACKUP_ENTRY'); walk(path, rel);}
      else if (!stat.isFile() || !expectedFiles.delete(rel)) fail('UNEXPECTED_BACKUP_ENTRY');
    }
  }
  walk(root); if (expectedFiles.size) fail('BACKUP_FILE_MISSING');
}
function verifyUnlocked(path: string): BackupManifest {
  safePath(path); if (!lstatSync(path).isDirectory()) fail('BACKUP_DIRECTORY_REQUIRED');
  regular(join(path, 'complete.json')); regular(join(path, 'manifest.json'));
  const raw = readFileSync(join(path, 'manifest.json'));
  let manifest: BackupManifest, complete: {version: number; manifestSha256: string};
  try {manifest = JSON.parse(raw.toString()); complete = JSON.parse(readFileSync(join(path, 'complete.json'), 'utf8'));} catch {fail('MANIFEST_INVALID');}
  if (complete.version !== 1 || complete.manifestSha256 !== sha(raw)) fail('MANIFEST_HASH_MISMATCH');
  if (manifest.version !== 1 || manifest.owner !== OWNER) fail('MANIFEST_VERSION_UNSUPPORTED');
  if (!SNAPSHOT_NAME.test(manifest.id) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.createdAt) || !Number.isFinite(Date.parse(manifest.createdAt)) || !same(manifest.invariants, INVARIANTS)) fail('MANIFEST_INVALID');
  if (!validDigest(manifest.database) || manifest.database.path !== 'database.sqlite' || manifest.database.schemaVersion !== 1 || typeof manifest.database.sqliteVersion !== 'string' || typeof manifest.database.nodeVersion !== 'string' || !HASH.test(manifest.database.logicalSha256) || !Array.isArray(manifest.database.tables) || !Array.isArray(manifest.files)) fail('MANIFEST_DATABASE_INVALID');
  if (!supportedNode(manifest.database.nodeVersion) || !isSafeSqliteVersion(manifest.database.sqliteVersion)) fail('DATABASE_RUNTIME_UNSUPPORTED');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!validDigest(file) || !BLOB_PATH.test(file.path) || seen.has(file.path)) fail('MANIFEST_PATH_INVALID'); seen.add(file.path);
  }
  checkInventory(path, manifest);
  const database = digestFile(join(path, 'database.sqlite')); if (!same(database, {sha256: manifest.database.sha256, size: manifest.database.size})) fail('DATABASE_HASH_MISMATCH');
  const inspected = inspectDatabase(join(path, 'database.sqlite'));
  if (inspected.schemaVersion !== manifest.database.schemaVersion || inspected.sqliteVersion !== manifest.database.sqliteVersion || inspected.logicalSha256 !== manifest.database.logicalSha256 || !same(inspected.tables, manifest.database.tables)) fail('DATABASE_LOGICAL_MISMATCH');
  verifyBlobs(path, manifest.files, inspected.references); return manifest;
}
/** Separate advisory SQLite file: no business data, OS lock release on crash, atomic no-clobber initialization. */
function acquireRootLock(root: string): () => void {
  privateDir(root); const path = join(root, '.backup-lock.sqlite');
  if (!existsSync(path)) {
    const temporary = join(root, `.lock-init-${randomUUID()}`); closeSync(openSync(temporary, 'wx', 0o600)); const db = new DatabaseSync(temporary);
    try {db.exec(`PRAGMA application_id=${LOCK_APPLICATION_ID}; PRAGMA user_version=1; CREATE TABLE lock_owner(version INTEGER NOT NULL); INSERT INTO lock_owner VALUES(1);`);} finally {db.close();}
    const fd = openSync(temporary, 'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
    try {linkSync(temporary, path); syncDir(root);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;} finally {unlinkSync(temporary);}
  }
  regular(path); const stat = lstatSync(path);
  if (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail('PRIVATE_LOCK_REQUIRED');
  let probe: DatabaseSync | undefined, lock: DatabaseSync | undefined;
  try {
    probe = openRead(path);
    if (probe.prepare('PRAGMA application_id').get()!.application_id !== LOCK_APPLICATION_ID || probe.prepare('PRAGMA user_version').get()!.user_version !== 1) fail('BACKUP_LOCK_NOT_OWNED');
    probe.close(); probe = undefined;
    lock = new DatabaseSync(path); lock.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE');
    if (lstatSync(path).ino !== stat.ino || lstatSync(path).isSymbolicLink()) fail('BACKUP_LOCK_CHANGED');
    const held = lock; return () => {try {held.exec('ROLLBACK');} finally {held.close();}};
  } catch (error) {
    probe?.close(); lock?.close();
    if ((error as Error).message.includes('locked') || (error as Error).message.includes('busy')) fail('BACKUP_BUSY'); throw error;
  }
}
export async function verifyBackup(backupPath: string): Promise<BackupManifest> {
  const path = safePath(backupPath), release = acquireRootLock(dirname(path));
  try {return verifyUnlocked(path);} finally {release();}
}
/** Snapshot first, then immutable blobs. The sole business writer can continue using its connection. */
export async function createBackup(options: BackupOptions): Promise<{path: string; manifest: BackupManifest; retention: RetentionResult}> {
  const databasePath = safePath(options.databasePath), blobDirectory = safePath(options.blobDirectory), root = safePath(options.backupRoot);
  if (root === blobDirectory || root.startsWith(`${blobDirectory}${sep}`) || databasePath === root || databasePath.startsWith(`${root}${sep}`) || blobDirectory.startsWith(`${root}${sep}`)) fail('BACKUP_PATH_OVERLAP');
  const now = (options.now ?? (() => new Date()))(); if (!Number.isFinite(now.getTime())) fail('INVALID_BACKUP_TIME');
  if (options.sqliteRate !== undefined && (!Number.isSafeInteger(options.sqliteRate) || options.sqliteRate < 1)) fail('INVALID_BACKUP_RATE');
  const createdAt = now.toISOString(), id = `snapshot-${createdAt.replaceAll(/[-:.]/g, '')}-${randomUUID()}`;
  const release = acquireRootLock(root), stage = join(root, `.partial-${id}`), destination = join(root, id);
  try {
    privateDir(stage); const source = openRead(databasePath);
    try {
      assertSqliteRuntime(source);
      if (source.prepare('PRAGMA user_version').get()!.user_version !== 1) fail('DATABASE_VERSION_UNSUPPORTED');
      closeSync(openSync(join(stage, 'database.sqlite'), 'wx', 0o600));
      await sqliteBackup(source, join(stage, 'database.sqlite'), {rate: options.sqliteRate ?? 100, progress: info => options.onProgress?.({phase: 'snapshot-progress', ...info})});
    } finally {source.close();}
    // Hash immediately, before opening the snapshot or constructing any service.
    const snapshotFd = openSync(join(stage, 'database.sqlite'), 'r'); try {fsyncSync(snapshotFd);} finally {closeSync(snapshotFd);}
    const initial = digestFile(join(stage, 'database.sqlite'));
    options.onProgress?.({phase: 'snapshot-complete'});
    const inspected = inspectDatabase(join(stage, 'database.sqlite'));
    const files = copyCommittedBlobs(blobDirectory, stage); verifyBlobs(stage, files, inspected.references);
    const manifest: BackupManifest = {version: 1, owner: OWNER, id, createdAt, database: {path: 'database.sqlite', ...initial, schemaVersion: inspected.schemaVersion, sqliteVersion: inspected.sqliteVersion, nodeVersion: process.versions.node, logicalSha256: inspected.logicalSha256, tables: inspected.tables}, files, invariants: INVARIANTS};
    durableJson(join(stage, 'manifest.json'), manifest);
    durableJson(join(stage, 'complete.json'), {version: 1, manifestSha256: sha(readFileSync(join(stage, 'manifest.json')))});
    syncDir(stage); verifyUnlocked(stage);
    if (existsSync(destination)) fail('BACKUP_COLLISION'); renameSync(stage, destination); syncDir(root);
    const retention = options.retain === false ? {kept: [destination], removed: [], untouched: []} : pruneUnlocked(root);
    return {path: destination, manifest, retention};
  } finally {release();}
}
export async function restoreBackup(options: {backupPath: string; destination: string}): Promise<{path: string; manifest: BackupManifest}> {
  const backupPath = safePath(options.backupPath), destination = safePath(options.destination);
  if (existsSync(destination)) fail('DESTINATION_EXISTS');
  if (destination.startsWith(`${backupPath}${sep}`) || backupPath.startsWith(`${destination}${sep}`)) fail('RESTORE_PATH_OVERLAP');
  const release = acquireRootLock(dirname(backupPath));
  let stage: string | undefined;
  try {
    const manifest = verifyUnlocked(backupPath);
    privateDir(dirname(destination)); stage = join(dirname(destination), `.restore-${randomUUID()}`); privateDir(stage);
    digestFile(join(backupPath, 'database.sqlite'), join(stage, 'db.sqlite')); privateDir(join(stage, 'blobs'));
    for (const file of manifest.files) {privateDir(dirname(join(stage, file.path))); const actual = digestFile(join(backupPath, file.path), join(stage, file.path)); if (actual.sha256 !== file.sha256 || actual.size !== file.size) fail('FILE_HASH_MISMATCH');}
    const inspected = inspectDatabase(join(stage, 'db.sqlite'));
    if (inspected.logicalSha256 !== manifest.database.logicalSha256 || !same(inspected.tables, manifest.database.tables)) fail('DATABASE_LOGICAL_MISMATCH');
    if (!same(digestFile(join(stage, 'db.sqlite')), {sha256: manifest.database.sha256, size: manifest.database.size})) fail('DATABASE_HASH_MISMATCH');
    verifyBlobs(stage, manifest.files, inspected.references);
    for (const account of readdirSync(join(stage, 'blobs'))) syncDir(join(stage, 'blobs', account)); syncDir(join(stage, 'blobs')); syncDir(stage);
    // Reserve the new destination atomically. An existing empty directory is never overwritten.
    mkdirSync(destination, {mode: 0o700});
    try {renameSync(stage, destination);} catch (error) {rmdirSync(destination); throw error;}
    stage = undefined; syncDir(dirname(destination)); return {path: destination, manifest};
  } finally {if (stage) rmSync(stage, {recursive: true, force: true}); release();}
}
function utcWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); return day.toISOString().slice(0, 10);
}
function pruneUnlocked(root: string): RetentionResult {
  const valid: {path: string; manifest: BackupManifest}[] = [], untouched: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name === '.backup-lock.sqlite' || name === '.backup-lock.sqlite-journal') continue;
    if (!SNAPSHOT_NAME.test(name)) {untouched.push(name); continue;}
    try {const manifest = verifyUnlocked(join(root, name)); if (manifest.id !== name) fail('BACKUP_ID_MISMATCH'); valid.push({path: join(root, name), manifest});} catch {untouched.push(name);}
  }
  valid.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.manifest.id.localeCompare(a.manifest.id));
  const days = new Set<string>(), weeks = new Set<string>(), keep = new Set<string>();
  for (const item of valid) {
    const day = item.manifest.createdAt.slice(0, 10), week = utcWeek(new Date(item.manifest.createdAt));
    if (!days.has(day) && days.size < 7) {days.add(day); keep.add(item.path);}
    if (!weeks.has(week) && weeks.size < 4) {weeks.add(week); keep.add(item.path);}
  }
  const removed: string[] = [];
  for (const item of valid) if (!keep.has(item.path)) {
    // Revalidate immediately; only this tool's complete snapshots under the locked root qualify.
    verifyUnlocked(item.path); rmSync(item.path, {recursive: true}); removed.push(item.path);
  }
  if (removed.length) syncDir(root);
  return {kept: valid.filter(item => keep.has(item.path)).map(item => item.path), removed, untouched};
}
export async function pruneBackups(options: {backupRoot: string}): Promise<RetentionResult> {
  const root = safePath(options.backupRoot), release = acquireRootLock(root);
  try {return pruneUnlocked(root);} finally {release();}
}

/** Discover complete owned metadata cheaply; fully verify only a newly selected snapshot.
 * Keep the same SQLite maintenance lock through the awaited transfer, so retention cannot
 * remove its input. This lock is separate from the business database. */
export async function withLatestVerifiedBackup(
  backupRoot: string, lastTransferredId: string | null,
  transfer: (path: string, manifest: BackupManifest) => Promise<void>,
): Promise<{status: 'transferred' | 'unchanged'; id: string}> {
  const root = safePath(backupRoot), release = acquireRootLock(root);
  try {
    const candidates: {path: string; id: string; createdAt: string}[] = [];
    for (const name of readdirSync(root)) {
      if (!SNAPSHOT_NAME.test(name)) continue;
      const path = safePath(join(root, name));
      if (!lstatSync(path).isDirectory()) fail('BACKUP_DIRECTORY_REQUIRED');
      if (!existsSync(join(path, 'complete.json'))) continue;
      regular(join(path, 'manifest.json')); regular(join(path, 'complete.json'));
      if (lstatSync(join(path, 'manifest.json')).size > 16 * 1024 * 1024 || lstatSync(join(path, 'complete.json')).size > 1024) fail('MANIFEST_INVALID');
      const raw = readFileSync(join(path, 'manifest.json'));
      let manifest: BackupManifest, complete: {version: number; manifestSha256: string};
      try {manifest = JSON.parse(raw.toString()); complete = JSON.parse(readFileSync(join(path, 'complete.json'), 'utf8'));} catch {fail('MANIFEST_INVALID');}
      if (complete.version !== 1 || complete.manifestSha256 !== sha(raw)) fail('MANIFEST_HASH_MISMATCH');
      if (manifest.version !== 1 || manifest.owner !== OWNER || manifest.id !== name || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.createdAt) || !Number.isFinite(Date.parse(manifest.createdAt))) fail('MANIFEST_INVALID');
      candidates.push({path, id: name, createdAt: manifest.createdAt});
    }
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const latest = candidates[0]; if (!latest) fail('NO_COMPLETE_BACKUP');
    if (latest.id === lastTransferredId) return {status: 'unchanged', id: latest.id};
    const manifest = verifyUnlocked(latest.path); if (manifest.id !== basename(latest.path)) fail('BACKUP_ID_MISMATCH');
    await transfer(latest.path, manifest);
    return {status: 'transferred', id: manifest.id};
  } finally {release();}
}
