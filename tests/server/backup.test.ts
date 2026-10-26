import {afterEach, expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {buildSync} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../server/database';
import {DiskBlobStore} from '../../server/blob';
import {CaptureQueue} from '../../server/capture/queue';
import {AuthService} from '../../server/auth';
import {createBackup, restoreBackup, verifyBackup, pruneBackups} from '../../server/backup';
const cleanup: (() => void)[] = [];
afterEach(() => {for (const dispose of cleanup.splice(0).reverse()) dispose();});
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-backup-test-')));
  const databasePath = join(root, 'source', 'db.sqlite');
  const blobDirectory = join(root, 'source', 'blobs');
  const backupRoot = join(root, 'backups');
  const db = openDatabase(databasePath); const account = randomUUID();
  db.prepare('INSERT INTO accounts(id,created_at) VALUES(?,?)').run(account, 1000);
  const store = new DiskBlobStore(blobDirectory);
  cleanup.push(() => {if (db.isOpen) db.close(); rmSync(root, {recursive: true, force: true});});
  return {root, db, account, store, databasePath, blobDirectory, backupRoot};
}
async function commit(f: ReturnType<typeof fixture>, content: string) {
  const bytes = Buffer.from(content), file = {sha256: hash(bytes), size: bytes.length, mime: 'text/plain'};
  const upload = await f.store.begin(f.account, file); await f.store.putChunk(f.account, upload.uploadId, 0, bytes); await f.store.commit(f.account, upload.uploadId);
  return file;
}
function entity(f: ReturnType<typeof fixture>, payload: unknown, id = randomUUID()) {
  const envelope = {id, moduleId: 'future-module', kind: 'future.file', schemaVersion: 99, revision: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z', payload};
  f.db.prepare('INSERT INTO sync_entities VALUES(?,?,?,?)').run(f.account, envelope.moduleId, id, JSON.stringify(envelope));
  f.db.prepare('INSERT INTO sync_changes(account_id,batch_id,change_json) VALUES(?,?,?)').run(f.account, randomUUID(), JSON.stringify({entities: [envelope]}));
  return envelope;
}
function openRead(path: string) { const db = new DatabaseSync(path, {readOnly: true}); cleanup.push(() => db.close()); return db; }
function mutateManifest(path: string, mutate: (m: any) => void) {
  const file = join(path, 'manifest.json'); const m = JSON.parse(readFileSync(file, 'utf8')); mutate(m); const bytes = JSON.stringify(m); writeFileSync(file, bytes); writeFileSync(join(path, 'complete.json'), JSON.stringify({version: 1, manifestSha256: hash(bytes)}));
}
it('snapshots a live SQLite connection before walking historical and unknown references, with exact isolated restore', async () => {
  const f = fixture(), file = await commit(f, 'durable historical bytes');
  const saved = entity(f, {nested: [{file}]});
  f.db.exec('CREATE TABLE padding(value TEXT);');
  const insert = f.db.prepare('INSERT INTO padding VALUES(?)'); for (let i = 0; i < 50; i++) insert.run('x'.repeat(12000));
  let mutatedOnline = false, cut = false;
  const backup = await createBackup({...f, sqliteRate: 1, onProgress: event => {
    if (event.phase === 'snapshot-progress' && !mutatedOnline) { mutatedOnline = true; f.db.prepare('INSERT INTO padding VALUES(?)').run('live API remains writable'); }
    if (event.phase === 'snapshot-complete') {cut = true; entity(f, {file: {sha256: 'f'.repeat(64), size: 1, mime: 'text/plain'}});}
  }});
  expect(mutatedOnline && cut).toBe(true);
  expect(backup.manifest.database.schemaVersion).toBe(1);
  expect(backup.manifest.files).toHaveLength(2);
  const sourceBytes = readFileSync(join(backup.path, 'database.sqlite'));
  const restored = await restoreBackup({backupPath: backup.path, destination: join(f.root, 'restored')});
  const db = openRead(join(restored.path, 'db.sqlite'));
  expect(JSON.parse((db.prepare('SELECT envelope FROM sync_entities').get() as any).envelope)).toEqual(saved);
  expect((db.prepare('SELECT COUNT(*) AS n FROM padding').get() as any).n).toBe(51);
  expect(readFileSync(join(restored.path, 'blobs', hash(f.account), file.sha256))).toEqual(Buffer.from('durable historical bytes'));
  expect(readFileSync(join(backup.path, 'database.sqlite'))).toEqual(sourceBytes);
  expect(lstatSync(backup.path).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(backup.path, 'database.sqlite')).mode & 0o777).toBe(0o600);
});
it.each(['missing', 'corrupt', 'marker-size', 'marker-hash', 'invalid-mime'] as const)('fails without publishing when required committed file is %s', async mode => {
  const f = fixture(), file = await commit(f, 'required bytes'); entity(f, {file});
  const path = join(f.blobDirectory, hash(f.account), file.sha256);
  if (mode === 'missing') rmSync(path);
  else if (mode === 'corrupt') writeFileSync(path, 'wrong bytes!!!');
  else if (mode === 'marker-size') writeFileSync(`${path}.json`, JSON.stringify({...file, size: file.size + 1}));
  else if (mode === 'marker-hash') writeFileSync(`${path}.json`, JSON.stringify({...file, sha256: 'e'.repeat(64)}));
  else writeFileSync(`${path}.json`, JSON.stringify({...file, mime: 'text/plain\r\nx-test: invalid'}));
  await expect(createBackup(f)).rejects.toThrow(/BLOB|DESCRIPTOR/);
  expect(readdirSync(f.backupRoot).filter(name => name.startsWith('snapshot-'))).toEqual([]);
});
it('preserves orphan committed blobs but excludes pending uploads and raw unmarked bytes', async () => {
  const f = fixture(), orphan = await commit(f, 'committed before queue finalize');
  const pending = {sha256: 'e'.repeat(64), size: 2, mime: 'text/plain'};
  entity(f, {availability: 'pending', ...pending});
  const upload = await f.store.begin(f.account, pending); await f.store.putChunk(f.account, upload.uploadId, 0, Buffer.from('xx'));
  writeFileSync(join(f.blobDirectory, hash(f.account), 'd'.repeat(64)), 'unmarked');
  const backup = await createBackup(f);
  expect(backup.manifest.files.map(file => file.path)).toEqual([`blobs/${hash(f.account)}/${orphan.sha256}`, `blobs/${hash(f.account)}/${orphan.sha256}.json`]);
  await verifyBackup(backup.path);
});
it('walks conflict receipts and requires unknown module references even if no current entity retains them', async () => {
  const f = fixture(), file = {sha256: 'a'.repeat(64), size: 1, mime: 'text/plain'};
  f.db.prepare('INSERT INTO sync_batches VALUES(?,?,?,?)').run(f.account, randomUUID(), 'fingerprint', JSON.stringify({status: 'conflict', conflict: {batch: {mutations: [{payload: {deep: [file]}}]}}}));
  await expect(createBackup(f)).rejects.toThrow(/BLOB/);
});
it('restores queued, leased, encrypted expiring inputs and durable receipt dedup without instantiating services', async () => {
  const f = fixture(), key = new Uint8Array(32).fill(7), now = 1000;
  const queue = new CaptureQueue(f.db, {secretKey: key, now: () => now, leaseMs: 100});
  const input = queue.storeInput(f.account, {url: 'https://example.org/private?token=invented-secret'});
  const request = {operationId: randomUUID(), assetId: randomUUID(), publicSourceUrl: null, inputToken: input.inputToken};
  const job = queue.submit(f.account, request), lease = queue.lease('fixture')!;
  const finished = queue.submit(f.account, {operationId: randomUUID(), assetId: randomUUID(), publicSourceUrl: 'https://example.org/public.pdf'}), finishedLease = queue.lease('fixture')!;
  const outcome = {state: 'needs-permission' as const}; const receipt = queue.settle(finished.id, finishedLease.leaseToken, outcome);
  queue.submit(f.account, {operationId: randomUUID(), assetId: randomUUID(), publicSourceUrl: 'https://example.org/queued.pdf'});
  const before = ['capture_jobs','capture_inputs','capture_receipts'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const backup = await createBackup(f); const restored = await restoreBackup({backupPath: backup.path, destination: join(f.root, 'restored')});
  const db = openDatabase(join(restored.path, 'db.sqlite')); cleanup.push(() => db.close());
  expect(['capture_jobs','capture_inputs','capture_receipts'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  expect(readFileSync(join(backup.path, 'database.sqlite')).includes(Buffer.from('invented-secret'))).toBe(false);
  const reopened = new CaptureQueue(db, {secretKey: key, now: () => 1101, leaseMs: 100});
  expect(reopened.settle(finished.id, finishedLease.leaseToken, outcome)).toEqual(receipt);
  expect(reopened.submit(f.account, request).id).toBe(job.id);
  const recovered = [reopened.lease('replacement-1')!, reopened.lease('replacement-2')!];
  expect(recovered.map(item => item.job.id)).toContain(job.id);
  expect(recovered.find(item => item.job.id === job.id)!.leaseToken).not.toBe(lease.leaseToken);
  expect(() => reopened.settle(job.id, lease.leaseToken, outcome)).toThrow('LEASE_LOST');
  const expired = new CaptureQueue(db, {secretKey: key, now: () => 1000 + 24 * 3600 * 1000});
  expired.maintain(); expect((db.prepare('SELECT COUNT(*) AS n FROM capture_inputs').get() as any).n).toBe(0);
});
it.each(['traversal','version','hash','symlink','collision','sidecar','blob','extra','runtime'] as const)('rejects manifest %s tampering before restore publication', async mode => {
  const f = fixture(); const file = await commit(f, 'protected'); entity(f, {file}); const backup = await createBackup(f);
  if (mode === 'traversal') mutateManifest(backup.path, m => {m.files[0].path = '../escape';});
  if (mode === 'version') mutateManifest(backup.path, m => {m.version = 2;});
  if (mode === 'hash') writeFileSync(join(backup.path, 'database.sqlite'), 'bad SQLite');
  if (mode === 'symlink') {const path = join(backup.path, backup.manifest.files[0].path); rmSync(path); symlinkSync(join(f.blobDirectory, hash(f.account), file.sha256), path);}
  if (mode === 'collision') mutateManifest(backup.path, m => {m.files.push(m.files[0]);});
  if (mode === 'sidecar') writeFileSync(join(backup.path, `${backup.manifest.files[0].path}.json`), '{}');
  if (mode === 'blob') writeFileSync(join(backup.path, backup.manifest.files[0].path), 'tampered');
  if (mode === 'extra') writeFileSync(join(backup.path, 'capture.key'), 'forbidden');
  if (mode === 'runtime') mutateManifest(backup.path, m => {m.database.nodeVersion = '1.0.0';});
  const destination = join(f.root, 'restored'); await expect(restoreBackup({backupPath: backup.path, destination})).rejects.toThrow(); expect(existsSync(destination)).toBe(false);
});
it('leaves an existing restore destination and source completely untouched and rejects unsafe schema and FK faults', async () => {
  const f = fixture(); const backup = await createBackup(f), destination = join(f.root, 'existing'); mkdirSync(destination); writeFileSync(join(destination, 'sentinel'), 'keep');
  await expect(restoreBackup({backupPath: backup.path, destination})).rejects.toThrow('DESTINATION_EXISTS'); expect(readFileSync(join(destination, 'sentinel'), 'utf8')).toBe('keep');
  f.db.exec('PRAGMA user_version=2'); await expect(createBackup(f)).rejects.toThrow('DATABASE_VERSION_UNSUPPORTED'); f.db.exec('PRAGMA user_version=1; PRAGMA foreign_keys=OFF');
  f.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?)').run(randomUUID(), 'nonexistent-account', 'fixture', 'hashed-only', 1, null);
  await expect(createBackup(f)).rejects.toThrow('DATABASE_FOREIGN_KEY');
});
it('retains the union of 7 UTC days and 4 UTC ISO weeks while reporting unrelated and partial entries', async () => {
  const f = fixture(); const backups: {path: string; date: string}[] = [];
  for (const date of ['2026-09-01','2026-09-08','2026-09-15','2026-09-22','2026-09-29','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07','2026-10-07']) {
    f.db.prepare('INSERT INTO pairing_attempts VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET attempts=attempts+1').run('fixture', 1, 1);
    const b = await createBackup({...f, now: () => new Date(`${date}T12:00:00.000Z`), retain: false}); backups.push({path: b.path, date});
  }
  mkdirSync(join(f.backupRoot, 'unrelated')); writeFileSync(join(f.backupRoot, 'note.txt'), 'preserve'); mkdirSync(join(f.backupRoot, '.partial-active')); mkdirSync(join(f.backupRoot, 'snapshot-invalid'));
  const result = await pruneBackups({backupRoot: f.backupRoot});
  expect(result.kept).toHaveLength(9); expect(result.removed).toHaveLength(4);
  expect(result.untouched).toEqual(expect.arrayContaining(['unrelated','note.txt','.partial-active','snapshot-invalid']));
  expect(readFileSync(join(f.backupRoot, 'note.txt'), 'utf8')).toBe('preserve'); expect(existsSync(join(f.backupRoot, '.partial-active'))).toBe(true);
});

it('does not let ancestor or descriptor task states suppress committed unknown-module attachments', async () => {
  const f = fixture(), file = {sha256: 'b'.repeat(64), size: 1, mime: 'text/plain'};
  entity(f, {availability: 'pending', state: 'cancelled', nested: {...file, state: 'pending'}});
  await expect(createBackup(f)).rejects.toThrow('BLOB_REQUIRED_MISSING');
});
it('serializes backup, restore and retention across processes and recovers automatically after SIGKILL', async () => {
  const f = fixture(), first = await createBackup(f), entry = join(f.root, 'backup-harness.mjs'), signal = join(f.root, 'locked');
  buildSync({entryPoints: ['server/backup.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node24'});
  const code = `import {createBackup} from ${JSON.stringify(pathToFileURL(entry).href)}; import {writeFileSync} from 'node:fs'; await createBackup({...JSON.parse(process.argv[1]), onProgress: event => {if(event.phase==='snapshot-complete'){writeFileSync(process.argv[2], 'locked');process.kill(process.pid, 'SIGSTOP');}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({databasePath: f.databasePath, blobDirectory: f.blobDirectory, backupRoot: f.backupRoot}), signal], {stdio: ['ignore', 'pipe', 'pipe']});
  cleanup.push(() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');});
  const deadline = Date.now() + 5000; while (!existsSync(signal) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(existsSync(signal)).toBe(true);
  await expect(createBackup(f)).rejects.toThrow('BACKUP_BUSY');
  await expect(restoreBackup({backupPath: first.path, destination: join(f.root, 'busy-restore')})).rejects.toThrow('BACKUP_BUSY');
  await expect(pruneBackups(f)).rejects.toThrow('BACKUP_BUSY');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const recovered = await createBackup(f); await verifyBackup(recovered.path);
  expect(recovered.retention.untouched.some(name => name.startsWith('.partial-'))).toBe(true);
  expect(existsSync(join(f.root, 'busy-restore'))).toBe(false);
}, 15000);
it('refuses an unowned lock database without modifying it', async () => {
  const f = fixture(); mkdirSync(f.backupRoot, {mode: 0o700}); const path = join(f.backupRoot, '.backup-lock.sqlite');
  const unknown = new DatabaseSync(path); unknown.exec('PRAGMA application_id=123;CREATE TABLE unrelated(value);INSERT INTO unrelated VALUES(42)'); unknown.close();
  const before = readFileSync(path); await expect(createBackup(f)).rejects.toThrow(); expect(readFileSync(path)).toEqual(before);
});

it('rejects invalid null descriptors in unknown modules instead of silently treating them as uncommitted', async () => {
  const f = fixture(); entity(f, {file: {sha256: null, size: null, mime: null}});
  await expect(createBackup(f)).rejects.toThrow('INVALID_BLOB');
});

it('rejects actual SQLite integrity-check failures without publishing', async () => {
  const f = fixture(); f.db.exec('CREATE TABLE corrupt_me(value BLOB); INSERT INTO corrupt_me VALUES(zeroblob(10000)); PRAGMA wal_checkpoint(TRUNCATE)');
  const page = (f.db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='corrupt_me'").get() as any).rootpage;
  const pageSize = (f.db.prepare('PRAGMA page_size').get() as any).page_size;
  const fd = openSync(f.databasePath, 'r+'); try {writeSync(fd, Buffer.from([0xff]), 0, 1, (page - 1) * pageSize);} finally {closeSync(fd);}
  await expect(createBackup(f)).rejects.toThrow(/DATABASE_INTEGRITY|malformed/);
  expect(readdirSync(f.backupRoot).some(name => name.startsWith('snapshot-'))).toBe(false);
});
it('preserves device revocations and valid authentication without saving plaintext tokens', async () => {
  const f = fixture(), auth = new AuthService(f.db);
  const valid = auth.pair(await auth.createPairingCode(f.account), 'fixture-primary', 'fixture');
  const revoked = auth.pair(await auth.createPairingCode(f.account), 'fixture-revoked', 'fixture'); auth.revoke(f.account, revoked.deviceId);
  const backup = await createBackup(f), restored = await restoreBackup({backupPath: backup.path, destination: join(f.root, 'restored')});
  expect(readFileSync(join(backup.path, 'database.sqlite')).includes(Buffer.from(valid.token))).toBe(false);
  expect(readFileSync(join(backup.path, 'database.sqlite')).includes(Buffer.from(revoked.token))).toBe(false);
  const recoveredAuth = new AuthService(openRead(join(restored.path, 'db.sqlite')));
  expect(recoveredAuth.authenticate(valid.token)).toEqual({accountId: f.account, deviceId: valid.deviceId});
  expect(() => recoveredAuth.authenticate(revoked.token)).toThrow('UNAUTHORIZED');
});
it('runs the emitted local CLI create, verify and restore commands with count/hash-only output', async () => {
  const f = fixture(), entry = join(f.root, 'backup-cli.mjs'); entity(f, {invented: true});
  buildSync({entryPoints: ['server/backup-cli.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node24'});
  const run = (...args: string[]) => {const result = spawnSync(process.execPath, [entry, ...args], {encoding: 'utf8'}); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);};
  const created = run('create', '--db', f.databasePath, '--blob-dir', f.blobDirectory, '--backup-root', f.backupRoot);
  expect(created.status).toBe('complete'); const path = join(f.backupRoot, created.snapshot);
  expect(run('verify', '--snapshot', path).databaseSha256).toBe(created.databaseSha256);
  expect(run('restore', '--snapshot', path, '--destination', join(f.root, 'restored')).status).toBe('restored-isolated-directory');
  expect(run('prune', '--backup-root', f.backupRoot).retained).toBe(1);
  expect(JSON.stringify(created)).not.toContain('invented');
});
it('preserves arbitrary future SQL tables and opaque non-JSON text while finding valid JSON references', async () => {
  const f = fixture(), file = await commit(f, 'future SQL module');
  f.db.exec('CREATE TABLE future_module(account_id TEXT, body TEXT, opaque TEXT)');
  f.db.prepare('INSERT INTO future_module VALUES(?,?,?)').run(f.account, JSON.stringify({attachments: [file]}), '{this is opaque text, not JSON');
  const backup = await createBackup(f), restored = await restoreBackup({backupPath: backup.path, destination: join(f.root, 'restored')});
  expect(openRead(join(restored.path, 'db.sqlite')).prepare('SELECT * FROM future_module').all()).toEqual(f.db.prepare('SELECT * FROM future_module').all());
});
