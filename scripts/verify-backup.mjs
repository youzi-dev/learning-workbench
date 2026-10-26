/** Disposable local recovery drill: real disk, SQLite, two real HTTP API processes.
 * It never connects to installed servers, production credentials, or the capture downloader. */
import {build} from 'esbuild';
import {fork} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-isolated-backup-')));
const processes = [];
const check = (condition, code) => {if (!condition) throw Error(code);};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let api;
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000); timeout.unref();
  await exited; clearTimeout(timeout);
}
try {
  const harness = join(root, 'harness.mjs');
  await build({stdin: {contents: `export {createBackup, restoreBackup} from './server/backup'; export {openDatabase} from './server/database'; export {AuthService} from './server/auth'; export {SyncService} from './server/sync'; export {DiskBlobStore} from './server/blob'; export {createApp} from './server/app';`, resolveDir: project}, outfile: harness, platform: 'node', bundle: true, format: 'esm', target: 'node24'});
  cpSync(join(project, 'server', 'migrations'), join(root, 'migrations'), {recursive: true});
  api = await import(pathToFileURL(harness).href);
  const childEntry = join(root, 'fixture-api.mjs');
  writeFileSync(childEntry, `import {openDatabase, AuthService, SyncService, DiskBlobStore, createApp} from './harness.mjs';
    const db=openDatabase(process.argv[2]);const auth=new AuthService(db);
    const schemas={notes:{note:{version:1,parse:v=>v}},future:{attachment:{version:99,parse:v=>v}}};
    const server=createApp({auth,sync:new SyncService(db,schemas),blobs:new DiskBlobStore(process.argv[3])});
    server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
    process.once('SIGTERM',()=>{server.close(()=>{db.close();process.disconnect();});server.closeIdleConnections();});`, {mode: 0o600});
  async function start(databasePath, blobDirectory) {
    const child = fork(childEntry, [databasePath, blobDirectory], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']}); processes.push(child);
    const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => {throw Error('FIXTURE_API_START_FAILED');})]);
    return `http://127.0.0.1:${message[0].port}`;
  }
  const databasePath = join(root, 'source', 'db.sqlite'), blobDirectory = join(root, 'source', 'blobs'), backupRoot = join(root, 'backups');
  const db = api.openDatabase(databasePath), auth = new api.AuthService(db), owner = await auth.provisionOwner(), code = await auth.createPairingCode(owner);
  db.close();
  const source = await start(databasePath, blobDirectory);
  async function request(base, path, {token, body, raw, method = body !== undefined || raw !== undefined ? 'POST' : 'GET', status = 200} = {}) {
    const response = await fetch(`${base}${path}`, {method, headers: {...token ? {authorization: `Bearer ${token}`} : {}, ...body !== undefined ? {'content-type': 'application/json'} : {}}, body: raw ?? (body === undefined ? undefined : JSON.stringify(body))});
    check(response.status === status, 'UNEXPECTED_HTTP_STATUS');
    return response;
  }
  const credential = await (await request(source, '/v1/devices/pair', {body: {code, name: 'invented recovery drill'}, status: 201})).json();
  const token = credential.token;
  const timestamp = '2026-10-01T00:00:00.000Z';
  const mutation = (payload, values = {}) => ({operationId: randomUUID(), deviceId: credential.deviceId, entityId: randomUUID(), moduleId: 'notes', kind: 'note', schemaVersion: 1, baseRevision: null, createdAt: timestamp, updatedAt: timestamp, action: 'put', payload, ...values});
  const batch = (...mutations) => ({batchId: randomUUID(), mutations});
  const push = async (base, value) => (await request(base, '/v1/sync/push', {token, body: value})).json();
  const content = Buffer.from('Invented durable recovery fixture: complete blob bytes.');
  const file = {sha256: hash(content), size: content.length, mime: 'text/plain'};
  const session = await (await request(source, '/v1/blobs/begin', {token, body: file, status: 201})).json();
  await request(source, `/v1/blobs/uploads/${session.uploadId}/chunks/0`, {token, raw: content, status: 204});
  check(JSON.stringify(await (await request(source, `/v1/blobs/uploads/${session.uploadId}/commit`, {token, body: {}})).json()) === JSON.stringify(file), 'COMMIT_DESCRIPTOR');
  const attachment = mutation({attachment: {nested: file}}, {moduleId: 'future', kind: 'attachment', schemaVersion: 99});
  const initial = batch(attachment); const receipt = await push(source, initial); check(receipt.status === 'applied', 'INITIAL_BATCH');
  const deleted = await push(source, batch({...attachment, operationId: randomUUID(), baseRevision: 1, action: 'delete', payload: null})); check(deleted.status === 'applied', 'DELETE_BATCH');
  const conflictBatch = batch({...attachment, operationId: randomUUID(), baseRevision: 1});
  const conflict = await push(source, conflictBatch); check(conflict.status === 'conflict', 'CONFLICT_BATCH');
  const unknown = await push(source, batch(mutation({nested: [file], name: 'invented'}, {moduleId: 'future', kind: 'attachment', schemaVersion: 99}))); check(unknown.status === 'applied', 'UNKNOWN_MODULE_BATCH');
  // All large rows are sent through HTTP; only the live API writes business data.
  for (let i = 0; i < 8; i++) check((await push(source, batch(mutation({fixturePadding: 'x'.repeat(700_000), ordinal: i})))).status === 'applied', 'PADDING_BATCH');
  const before = await (await request(source, '/v1/sync/pull?cursor=0&limit=100', {token})).json();
  const continuationCursor = before.nextCursor;
  let onlineWrite, writeFinished = false, writeBeforeCut = false;
  const backup = await api.createBackup({databasePath, blobDirectory, backupRoot, sqliteRate: 1, onProgress: event => {
    if (event.phase === 'snapshot-progress' && !onlineWrite) onlineWrite = push(source, batch(mutation({fixture: 'API write during backup'}))).then(result => {check(result.status === 'applied', 'LIVE_API_WRITE'); writeFinished = true;});
    if (event.phase === 'snapshot-complete') writeBeforeCut = writeFinished;
  }});
  await onlineWrite; check(writeBeforeCut, 'LIVE_WRITE_DID_NOT_FINISH_DURING_BACKUP');
  const backedUpBytes = readFileSync(join(backup.path, 'database.sqlite'));
  const restored = await api.restoreBackup({backupPath: backup.path, destination: join(root, 'restored')});
  check(hash(readFileSync(join(backup.path, 'database.sqlite'))) === hash(backedUpBytes), 'BACKUP_CHANGED');
  const recovered = await start(join(restored.path, 'db.sqlite'), join(restored.path, 'blobs'));
  const page = await (await request(recovered, '/v1/sync/pull?cursor=0&limit=100', {token})).json();
  check(page.changes.length === before.changes.length + 1, 'CHANGE_LOG_COUNT');
  check(page.changes.flatMap(change => change.entities).some(entity => entity.id === attachment.entityId && entity.deletedAt !== null), 'TOMBSTONE_MISSING');
  check(page.changes.flatMap(change => change.entities).some(entity => entity.moduleId === 'future' && entity.schemaVersion === 99), 'UNKNOWN_MODULE_MISSING');
  check(JSON.stringify(await push(recovered, initial)) === JSON.stringify(receipt), 'BATCH_RECEIPT_DEDUP');
  check(JSON.stringify(await push(recovered, conflictBatch)) === JSON.stringify(conflict), 'CONFLICT_RECEIPT_DEDUP');
  const continued = await (await request(recovered, `/v1/sync/pull?cursor=${continuationCursor}&limit=100`, {token})).json();
  check(continued.changes.length === 1 && continued.nextCursor > continuationCursor, 'RESTORED_CURSOR');
  const after = await push(recovered, batch(mutation({fixture: 'restored cursor continuation'}))); check(after.status === 'applied' && after.change.cursor > page.nextCursor, 'CURSOR_CONTINUATION');
  const downloaded = Buffer.from(await (await request(recovered, `/v1/blobs/${file.sha256}`, {token})).arrayBuffer());
  check(downloaded.equals(content) && hash(downloaded) === file.sha256, 'RESTORED_FILE_HASH');
  await request(recovered, `/v1/blobs/${file.sha256}`, {status: 401});
  await request(recovered, `/v1/blobs/${file.sha256}`, {token: 'a'.repeat(43), status: 401});
  const sourceAfter = await (await request(source, '/v1/sync/pull?cursor=0&limit=100', {token})).json();
  check(sourceAfter.changes.length === page.changes.length, 'RESTORE_MODIFIED_SOURCE');
  console.log(JSON.stringify({status: 'passed', scope: 'disposable-local-http-recovery', apiProcesses: 2, changeBatches: page.changes.length, liveApiWritesDuringBackup: 1, restoredTombstone: true, unknownModulePreserved: true, batchAndConflictReceiptDedup: true, cursorContinuation: true, authenticatedDownloadHash: file.sha256, unauthenticatedDownloadDenied: true, databaseSha256: backup.manifest.database.sha256, sourceAndBackupUnchangedByRestore: true, cloudRecovery: false}));
} catch (error) {
  console.error(error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ISOLATED_BACKUP_VERIFICATION_FAILED'); process.exitCode = 1;
} finally {
  for (const child of processes.reverse()) await stop(child);
  rmSync(root, {recursive: true, force: true});
}
