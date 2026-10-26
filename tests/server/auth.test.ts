import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, isSafeSqliteVersion } from '../../server/database';
import { AuthService } from '../../server/auth';
import { createApp } from '../../server/app';
import { SyncService } from '../../server/sync';
import { runCli } from '../../server/cli';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup(options: { now?: () => number; maxPairAttempts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-auth-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cloud.sqlite'); const db = openDatabase(path); cleanups.push(() => db.close());
  return { db, path, auth: new AuthService(db, options) };
}
it('provisions only one owner and never accepts empty or default credentials', async () => {
  const { auth } = setup(); const account = await auth.provisionOwner();
  expect(await auth.provisionOwner()).toBe(account);
  for (const value of ['', 'Bearer ', 'admin', 'default', 'undefined']) expect(() => auth.authenticate(value)).toThrow('UNAUTHORIZED');
});
it('pairing codes expire after ten minutes and are single use; stored secrets are hashed', async () => {
  let now = Date.now(); const { auth, db, path } = setup({ now: () => now }); const owner = await auth.provisionOwner();
  const expired = await auth.createPairingCode(owner); now += 600_001;
  expect(() => auth.pair(expired, 'phone', 'phone')).toThrow('INVALID_PAIRING_CODE');
  const code = await auth.createPairingCode(owner); const device = auth.pair(code, 'laptop', 'laptop');
  expect(auth.authenticate(device.token)).toMatchObject({ accountId: owner, deviceId: device.deviceId });
  expect(() => auth.pair(code, 'second', 'second')).toThrow('INVALID_PAIRING_CODE');
  expect(JSON.stringify(db.prepare('SELECT * FROM devices').all())).not.toContain(device.token);
  expect(JSON.stringify(db.prepare('SELECT * FROM pairing_codes').all())).not.toContain(code);
  expect(readFileSync(path).includes(Buffer.from(device.token))).toBe(false);
});
it('pairing brute force is rate limited persistently', async () => {
  const { auth, db } = setup({ maxPairAttempts: 2 });
  expect(() => auth.pair('wrong', 'phone', 'address')).toThrow('INVALID_PAIRING_CODE');
  expect(() => auth.pair('wrong', 'phone', 'address')).toThrow('INVALID_PAIRING_CODE');
  expect(() => new AuthService(db, { maxPairAttempts: 2 }).pair('wrong', 'phone', 'address')).toThrow('RATE_LIMITED');
});
it('revoked_device_is_unauthorized and refresh rotates the credential', async () => {
  const { auth } = setup(); const owner = await auth.provisionOwner();
  const device = auth.pair(await auth.createPairingCode(owner), 'phone', 'address');
  const next = auth.refresh(device.token);
  expect(() => auth.authenticate(device.token)).toThrow('UNAUTHORIZED');
  expect(auth.authenticate(next.token).deviceId).toBe(device.deviceId);
  auth.revoke(owner, device.deviceId); expect(() => auth.authenticate(next.token)).toThrow('UNAUTHORIZED');
});
it('HTTP derives account from credentials, rejects forged identity, and limits request size', async () => {
  const { auth, db } = setup(); const owner = await auth.provisionOwner();
  const server = createApp({ auth, sync: new SyncService(db, {}), maxBodyBytes: 1024 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen');
  const url = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${url}/v1/sync/pull`)).status).toBe(401);
  const paired = await fetch(`${url}/v1/devices/pair`, { method: 'POST', body: JSON.stringify({ code: await auth.createPairingCode(owner), name: 'phone' }) });
  expect(paired.status).toBe(201); const device = await paired.json();
  const headers = { authorization: `Bearer ${device.token}` };
  expect((await fetch(`${url}/v1/sync/pull?accountId=other`, { headers })).status).toBe(400);
  expect((await fetch(`${url}/v1/sync/push`, { method: 'POST', headers, body: JSON.stringify({ accountId: 'other' }) })).status).toBe(400);
  expect((await fetch(`${url}/v1/sync/push`, { method: 'POST', headers, body: 'x'.repeat(1025) })).status).toBe(413);
  auth.revoke(owner, device.deviceId);
  expect((await fetch(`${url}/v1/sync/pull`, { headers })).status).toBe(401);
});
it('WAL gate recognizes repaired branches and rejects vulnerable or malformed versions', () => {
  for (const version of ['3.44.6', '3.44.7', '3.50.7', '3.51.3', '3.52.0', '3.53.3']) expect(isSafeSqliteVersion(version)).toBe(true);
  for (const version of ['3.44.5', '3.45.9', '3.50.6', '3.51.2', 'nonsense']) expect(isSafeSqliteVersion(version)).toBe(false);
});

it('administrator CLI provisions durably, pairs explicitly, and rejects public registration or missing config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-cli-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'private.sqlite'); const output: string[] = [];
  await runCli(['provision', '--db', path], line => output.push(line));
  await runCli(['pair', '--db', path], line => output.push(line));
  const owner = JSON.parse(output[0]).accountId; const code = JSON.parse(output[1]).pairingCode;
  const db = openDatabase(path); cleanups.push(() => db.close());
  expect(new AuthService(db).pair(code, 'CLI phone', 'CLI').accountId).toBe(owner);
  await expect(runCli(['register', '--db', path])).rejects.toThrow('INVALID_COMMAND');
  await expect(runCli(['serve', '--db', path])).rejects.toThrow('SCHEMA_REGISTRY_REQUIRED');
  await expect(runCli(['provision'])).rejects.toThrow('DATABASE_PATH_REQUIRED');
});

it('future server database versions fail startup without silently downgrading', () => {
  const { db, path } = setup(); db.exec('PRAGMA user_version=999');
  expect(() => openDatabase(path)).toThrow('DATABASE_VERSION_UNSUPPORTED');
  expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 999 });
});

it('real HTTP sync handshake, push, pull and token rotation bind to the paired device', async () => {
  const { auth, db } = setup(); const owner = await auth.provisionOwner();
  const schemas = { notes: { note: { version: 1, parse(value: unknown) { if (!value || typeof value !== 'object' || !('text' in value)) throw new Error(); return value as { text: string }; } } } };
  const server = createApp({ auth, sync: new SyncService(db, schemas) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen');
  const url = `http://127.0.0.1:${address.port}`;
  const device = auth.pair(await auth.createPairingCode(owner), 'phone', 'test');
  const headers = { authorization: `Bearer ${device.token}` };
  const hello = await fetch(`${url}/v1/sync/handshake`, { method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, hostApiVersion: 1, schemas: { notes: { note: 1 } } }) });
  expect(await hello.json()).toEqual({ compatible: true, minimumProtocol: 1, readonlyKinds: [] });
  const batch = { batchId: randomUUID(), mutations: [{ operationId: randomUUID(), deviceId: device.deviceId, entityId: randomUUID(), moduleId: 'notes', kind: 'note', schemaVersion: 1, baseRevision: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', action: 'put', payload: { text: 'real HTTP' } }] };
  const pushed = await fetch(`${url}/v1/sync/push`, { method: 'POST', headers, body: JSON.stringify(batch) });
  expect(pushed.status).toBe(200); expect((await pushed.json()).status).toBe('applied');
  const pulled = await fetch(`${url}/v1/sync/pull?cursor=0&limit=1`, { headers });
  expect((await pulled.json()).changes[0].entities[0].payload).toEqual({ text: 'real HTTP' });
  batch.mutations[0].deviceId = randomUUID();
  expect((await fetch(`${url}/v1/sync/push`, { method: 'POST', headers, body: JSON.stringify(batch) })).status).toBe(400);
  const refreshed = await fetch(`${url}/v1/devices/refresh`, { method: 'POST', headers, body: '{}' });
  expect(refreshed.status).toBe(200);
  expect((await fetch(`${url}/v1/sync/pull`, { headers })).status).toBe(401);
});

it('HTTP pairing preserves an offline local device ID and rejects malformed or colliding identities', async () => {
  const { auth, db } = setup(); const owner = await auth.provisionOwner();
  const server = createApp({ auth, sync: new SyncService(db, {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen');
  const url = `http://127.0.0.1:${address.port}/v1/devices/pair`; const deviceId = randomUUID();
  const pair = (code: string, requestedId: string) => fetch(url, { method: 'POST', body: JSON.stringify({ code, name: 'offline device', deviceId: requestedId }) });
  const first = await pair(await auth.createPairingCode(owner), deviceId);
  expect(first.status).toBe(201); const credential = await first.json(); expect(credential.deviceId).toBe(deviceId);
  const secondCode = await auth.createPairingCode(owner);
  const collision = await pair(secondCode, deviceId); expect(collision.status).toBe(400); expect(await collision.json()).toEqual({ error: 'DEVICE_ID_IN_USE' });
  const caseCollision = await pair(secondCode, deviceId.toUpperCase()); expect(caseCollision.status).toBe(400); expect(await caseCollision.json()).toEqual({ error: 'DEVICE_ID_IN_USE' });
  const invalid = await pair(secondCode, 'not-a-uuid'); expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: 'INVALID_DEVICE_ID' });
  expect((await pair(secondCode, randomUUID())).status).toBe(201);
  expect(auth.authenticate(credential.token).deviceId).toBe(deviceId);
});

it('explicit recovery consumes a fresh owner code, rotates revoked credentials and preserves device identity', async () => {
  let now = Date.now(); const {auth, db} = setup({now: () => now, maxPairAttempts: 50}); const owner = await auth.provisionOwner(), id = randomUUID();
  const old = auth.pair(await auth.createPairingCode(owner), 'first', 'first', id);
  const recover = (code: string) => (auth.pair as any)(code, 'recovered', 'recovery', id, true);
  expect(() => recover('wrong')).toThrow('INVALID_PAIRING_CODE');
  const expired = await auth.createPairingCode(owner); now += 600_001; expect(() => recover(expired)).toThrow('INVALID_PAIRING_CODE');
  // Inject a foreign device row to exercise the defensive account boundary; production schema has one owner.
  db.exec('PRAGMA foreign_keys=OFF'); db.prepare('UPDATE devices SET account_id=? WHERE id=?').run(randomUUID(), id);
  const foreign = await auth.createPairingCode(owner); expect(() => recover(foreign)).toThrow('DEVICE_ID_IN_USE'); db.prepare('UPDATE devices SET account_id=? WHERE id=?').run(owner, id); db.exec('PRAGMA foreign_keys=ON');
  auth.revoke(owner, id); const code = await auth.createPairingCode(owner), next = recover(code);
  expect(next.deviceId).toBe(id); expect(auth.authenticate(next.token).accountId).toBe(owner); expect(() => auth.authenticate(old.token)).toThrow('UNAUTHORIZED'); expect(() => recover(code)).toThrow('INVALID_PAIRING_CODE');
});
it('HTTP explicit device recovery and null mutations return controlled statuses', async () => {
  const {auth, db} = setup(); const owner = await auth.provisionOwner(), id = randomUUID(); const old = auth.pair(await auth.createPairingCode(owner), 'first', 'first', id);
  const app = createApp({auth, sync: new SyncService(db, {})}); await new Promise<void>(r => app.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise<void>(r => app.close(() => r()))); const url = `http://127.0.0.1:${(app.address() as any).port}`;
  const recovered = await fetch(`${url}/v1/devices/pair`, {method: 'POST', body: JSON.stringify({code: await auth.createPairingCode(owner), name: 'recover', deviceId: id, replaceExistingDevice: true})}); expect(recovered.status).toBe(201); const credential = await recovered.json(); expect(credential.deviceId).toBe(id); expect(() => auth.authenticate(old.token)).toThrow('UNAUTHORIZED');
  const malformed = await fetch(`${url}/v1/sync/push`, {method: 'POST', headers: {authorization: `Bearer ${credential.token}`}, body: JSON.stringify({batchId: randomUUID(), mutations: [null]})}); expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({error: 'INVALID_BATCH'});
});
it('HTTP CORS permits only explicitly configured browser origins including preflight',async()=>{
 const {auth,db}=setup();const owner=await auth.provisionOwner();const app=createApp({auth,sync:new SyncService(db,{}),allowedOrigins:['http://127.0.0.1:8924']} as any);await new Promise<void>(r=>app.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise<void>(r=>app.close(()=>r())));const url=`http://127.0.0.1:${(app.address() as any).port}`;
 const preflight=await fetch(`${url}/v1/sync/push`,{method:'OPTIONS',headers:{origin:'http://127.0.0.1:8924','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8924');expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
 const code=await auth.createPairingCode(owner);const disallowed=await fetch(`${url}/v1/devices/pair`,{method:'POST',headers:{origin:'https://untrusted.example'},body:JSON.stringify({code,name:'bad'})});expect(disallowed.status).toBe(403);const allowed=await fetch(`${url}/v1/devices/pair`,{method:'POST',headers:{origin:'http://127.0.0.1:8924'},body:JSON.stringify({code,name:'good'})});expect(allowed.status).toBe(201);expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8924');
});
