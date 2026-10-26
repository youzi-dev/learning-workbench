import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IDBFactory} from 'fake-indexeddb';
import {openDatabase} from '../../server/database';
import {AuthService} from '../../server/auth';
import {SyncService, registryFromManifests} from '../../server/sync';
import {createApp} from '../../server/app';
import {manifests, catalogSchemas} from '../../src/workbench/catalog';
import {openRepository} from '../../src/platforms/browser/repository';
import {createBrowserConnection} from '../../src/platforms/browser/session';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {createWorkbenchRuntime} from '../../src/workbench/runtime';
import {registration} from '../fixtures/modules/notes-probe';
import {deterministicId} from '../../src/workbench/storage/repository';
import type {MutationBatch} from '../../src/workbench/contracts/data';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
async function server() {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-server-')); cleanups.push(() => rm(directory, {recursive: true, force: true}));
  const db = openDatabase(join(directory, 'server.sqlite')); cleanups.push(() => db.close());
  const auth = new AuthService(db), accountId = await auth.provisionOwner();
  const app = createApp({auth, sync: new SyncService(db, registryFromManifests([...manifests, registration().manifest]))});
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
  return {auth, accountId, baseUrl: `http://127.0.0.1:${(app.address() as {port: number}).port}`};
}
function storage() {const values = new Map<string, string>(); return {values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};}
async function device() {
  const indexedDB = new IDBFactory(), metadata = storage(), sessionStorage = storage();
  const open = async (accountId: string, deviceId?: string) => {const repo = await openRepository(accountId, {indexedDB, deviceId, schemas: {...catalogSchemas, 'notes-probe': {'notes-probe.note': 1}}}); cleanups.push(() => repo.close()); return repo;};
  const connection = createBrowserConnection({metadata, sessionStorage});
  const options = {registrations: [registration()], ports: createBrowserPorts(), open, connection, autoSync: false};
  const runtime = await createWorkbenchRuntime(options); cleanups.push(() => runtime.stop());
  return {runtime, options, open, metadata, sessionStorage};
}
function batch(deviceId: string, id: string, title: string, baseRevision: number | null = null): MutationBatch {return {batchId: deterministicId(id), mutations: [{operationId: deterministicId(`op-${id}`), deviceId, entityId: '00000000-0000-4000-8000-000000000002', moduleId: 'notes-probe', kind: 'notes-probe.note', schemaVersion: 1, baseRevision, createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:00.000Z', action: 'put', payload: {title}}]};}
it('pairs_with_explicit_local_adoption_syncs_and_restores_profile_after_reload_without_persisting_token_in_metadata', async () => {
  const cloud = await server(), d = await device(), local = d.runtime.snapshot().repository;
  await d.runtime.snapshot().host.invoke('notes-probe', 'write', batch(local.deviceId!, 'local', '本机原文') as any);
  await d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '浏览器', recover: false, adoptLocal: true});
  expect(d.runtime.snapshot().profile?.accountId).toBe(cloud.accountId);
  await d.runtime.sync(); expect(await d.runtime.snapshot().repository.pending()).toEqual([]);
  expect((await local.get({moduleId: 'notes-probe', entityId: '00000000-0000-4000-8000-000000000002'}))?.payload).toEqual({title: '本机原文'});
  const token = [...d.sessionStorage.values.values()][0]; expect(typeof token).toBe('string');
  expect(JSON.stringify([...d.metadata.values.values()])).not.toContain(token);
  await d.runtime.stop(); const reopened = await createWorkbenchRuntime(d.options); cleanups.push(() => reopened.stop());
  expect(reopened.snapshot().profile?.accountId).toBe(cloud.accountId); await reopened.sync();
  expect((await reopened.snapshot().repository.get({moduleId: 'notes-probe', entityId: '00000000-0000-4000-8000-000000000002'}))?.payload).toEqual({title: '本机原文'});
});
it('does_not_adopt_local_records_without_explicit_choice_and_preserves_them_on_pending_logout', async () => {
  const cloud = await server(), d = await device(), local = d.runtime.snapshot().repository;
  await local.commit(batch(local.deviceId!, 'stay-local', '留在原空间'));
  await d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '浏览器', recover: false, adoptLocal: false});
  expect(await d.runtime.snapshot().repository.list('notes-probe')).toEqual([]);
  await d.runtime.snapshot().host.invoke('notes-probe', 'write', batch(d.runtime.snapshot().repository.deviceId!, 'new', '账户本机内容') as any);
  await expect(d.runtime.session.logout()).rejects.toMatchObject({code: 'pending-logout'});
  await expect(d.runtime.session.logout('export')).rejects.toMatchObject({code: 'export-unavailable'});
  await d.runtime.session.logout('leave'); await d.runtime.settled();
  expect(d.runtime.snapshot().active).toBe(false); expect(await local.pending()).toHaveLength(1); expect([...d.sessionStorage.values]).toEqual([]);
});
it('pulls_remote_changes_notifies_host_and_surfaces_expired_device_login_without_losing_local_content', async () => {
  const cloud = await server(), a = await device(), b = await device();
  for (const d of [a, b]) await d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '设备', recover: false, adoptLocal: false});
  const repoA = a.runtime.snapshot().repository;
  await repoA.commit(batch(repoA.deviceId!, 'a', '来自另一台设备')); await a.runtime.sync();
  const host = b.runtime.snapshot().host, before = host.snapshot(); await b.runtime.sync();
  expect(host.snapshot()).toBeGreaterThan(before); expect((await b.runtime.snapshot().repository.list('notes-probe'))[0].payload).toEqual({title: '来自另一台设备'});
  cloud.auth.revoke(cloud.accountId, b.runtime.snapshot().repository.deviceId!);
  await expect(b.runtime.sync()).rejects.toMatchObject({code: 'UNAUTHORIZED'});
  expect(b.runtime.snapshot().engine?.snapshot().state).toBe('failed');
  await b.runtime.snapshot().engine!.refresh();
  expect(b.runtime.snapshot().engine!.snapshot()).toMatchObject({state: 'failed', error: 'UNAUTHORIZED'});
  expect((await b.runtime.snapshot().repository.list('notes-probe'))[0].payload).toEqual({title: '来自另一台设备'});
});
it('file_binding_is_revoked_on_logout_and_cannot_use_the_next_accounts_credentials', async () => {
  const cloud = await server(), d = await device();
  await d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '文件设备', recover: false, adoptLocal: false});
  const binding = d.runtime.fileConnection();
  await expect(d.runtime.authorizedFetchFor('different-account', '/v1/blobs/test')).rejects.toMatchObject({code: 'scope-changed'});
  await d.runtime.session.logout('leave'); await d.runtime.settled();
  await expect(binding.fetch('/v1/blobs/test')).rejects.toMatchObject({code: 'scope-changed'});
});
it('automatically_uploads_metadata_after_module_commit_and_serializes_overlapping_sync_requests', async () => {
  const cloud = await server(), d = await device();
  await d.runtime.stop();
  const runtime = await createWorkbenchRuntime({...d.options, autoSync: true, intervalMs: 25}); cleanups.push(() => runtime.stop());
  await runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '后台设备', recover: false, adoptLocal: false});
  await runtime.snapshot().host.invoke('notes-probe', 'write', batch(runtime.snapshot().repository.deviceId!, 'automatic', '自动同步') as any);
  const deadline = Date.now() + 2000;
  while ((await runtime.snapshot().repository.pending()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(await runtime.snapshot().repository.pending()).toEqual([]);
  await Promise.all([runtime.sync(), runtime.sync(), runtime.sync()]);
  expect(runtime.snapshot().engine?.snapshot().state).toBe('synced');
});
it('failed_scope_cleanup_keeps_the_original_local_host_usable_and_does_not_activate_the_account', async () => {
  const cloud = await server(), d = await device();
  await d.runtime.setHooks({async clearCache() {throw Error('cache cleanup failed');}});
  await expect(d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '设备', recover: false, adoptLocal: false})).rejects.toThrow('cache cleanup failed');
  expect(d.runtime.snapshot().profile).toBeNull();
  await expect(d.runtime.snapshot().host.invoke('notes-probe', 'echo', '还可以继续')).resolves.toBe('还可以继续');
});
it('shared_application_exposes_real_account_sync_and_conflict_controls', async () => {
  const {createRequire} = await import('node:module'); const {JSDOM} = createRequire(import.meta.url)('jsdom') as {JSDOM: new (html: string, options: {url: string}) => {window: Window & typeof globalThis}};
  const {vi} = await import('vitest'), {act, createElement} = await import('react'), {createRoot} = await import('react-dom/client');
  const {WorkbenchApplication} = await import('../../src/workbench/ui/application');
  const dom = new JSDOM('<div id="application"></div>', {url: 'http://localhost/'});
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('navigator', dom.window.navigator); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); cleanups.push(() => {vi.unstubAllGlobals(); dom.window.close();});
  const cloud = await server(), d = await device(); await d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '界面设备', recover: false, adoptLocal: false});
  const container = dom.window.document.getElementById('application')!, root = createRoot(container); cleanups.push(async () => {await act(async () => root.unmount());});
  await act(async () => root.render(createElement(WorkbenchApplication, {runtime: d.runtime})));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="账户与同步"]')!.click());
  expect(container.textContent).toContain('一次性配对码'); expect(container.textContent).toContain('立即同步'); expect(container.textContent).toContain('核对两个版本'); expect(container.textContent).toContain('恢复此设备登录');
});
it('rejects_a_file_response_that_started_before_logout_but_finishes_after_scope_change', async () => {
  const cloud = await server(), d = await device();
  let finish!: (response: Response) => void;
  const runtime = await createWorkbenchRuntime({...d.options, connection: {...d.options.connection, authorizedFetch: async () => new Promise<Response>(resolve => {finish = resolve;})}});
  cleanups.push(() => runtime.stop());
  await runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '延迟文件', recover: false, adoptLocal: false});
  const response = runtime.fileConnection().fetch('/v1/blobs/test');
  const rejected = expect(response).rejects.toMatchObject({code: 'scope-changed'});
  await runtime.session.logout('leave'); finish(new Response('old account bytes'));
  await rejected;
});
it('manual_engine_sync_finishes_before_account_deactivation_and_cache_cleanup', async () => {
  const cloud = await server(), d = await device();
  let finishPull!: (page: {changes: never[]; nextCursor: number; hasMore: boolean}) => void, started!: () => void;
  const pulling = new Promise<void>(resolve => {started = resolve;});
  const connection = {...d.options.connection, transport(profile: import('../../src/workbench/runtime').ConnectionProfile) {const transport = d.options.connection.transport(profile); return {...transport, async pull() {started(); return new Promise<{changes: never[]; nextCursor: number; hasMore: boolean}>(resolve => {finishPull = resolve;});}};}};
  const runtime = await createWorkbenchRuntime({...d.options, connection}); cleanups.push(() => runtime.stop());
  await runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '手动同步', recover: false, adoptLocal: false});
  let deactivated = false; await runtime.setHooks({async deactivate() {deactivated = true;}});
  const manual = runtime.snapshot().engine!.sync(); await pulling;
  cleanups.push(() => finishPull?.({changes: [], nextCursor: 0, hasMore: false}));
  await runtime.snapshot().engine!.refresh(); expect(runtime.snapshot().engine!.snapshot().state).toBe('syncing');
  const logout = runtime.session.logout('leave');
  await new Promise(resolve => setTimeout(resolve, 15)); expect(deactivated).toBe(false); expect(runtime.snapshot().active).toBe(true);
  finishPull({changes: [], nextCursor: 0, hasMore: false}); await manual; await logout;
  expect(deactivated).toBe(true); expect(runtime.snapshot().active).toBe(false);
});
it('local_offline_commit_updates_the_exposed_pending_status_after_a_successful_sync', async () => {
  const cloud = await server(), d = await device();
  await d.runtime.pair({baseUrl: cloud.baseUrl, code: await cloud.auth.createPairingCode(cloud.accountId), name: '离线状态', recover: false, adoptLocal: false});
  await d.runtime.sync(); expect(d.runtime.snapshot().engine!.snapshot().state).toBe('synced');
  d.runtime.notifyOnline(false);
  await d.runtime.snapshot().host.invoke('notes-probe', 'write', batch(d.runtime.snapshot().repository.deviceId!, 'offline-visible', '离线也要显示待同步') as any);
  const deadline = Date.now() + 500;
  while (d.runtime.snapshot().engine!.snapshot().state === 'synced' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(d.runtime.snapshot().engine!.snapshot()).toMatchObject({state: 'pending', pending: 1});
});
it('leave_barrier_rejects_before_pair_recovery_consumes_remote_code',async()=>{
  const cloud=await server(),d=await device();
  await d.runtime.pair({baseUrl:cloud.baseUrl,code:await cloud.auth.createPairingCode(cloud.accountId),name:'original device',recover:false,adoptLocal:false});
  let blocked=true;const guardHost=d.runtime.snapshot().host,original=guardHost.prepareLeave;
  guardHost.prepareLeave=async()=>{if(blocked)throw Error('pending learning input');await original();};
  const code=await cloud.auth.createPairingCode(cloud.accountId),profile=d.runtime.snapshot().profile;
  await expect(d.runtime.pair({baseUrl:cloud.baseUrl,code,name:'blocked recovery',recover:true,adoptLocal:false})).rejects.toThrow('pending learning input');
  expect(d.runtime.snapshot().active).toBe(true);expect(d.runtime.snapshot().profile).toEqual(profile);await d.runtime.sync();
  blocked=false;await d.runtime.pair({baseUrl:cloud.baseUrl,code,name:'same unused recovery code',recover:true,adoptLocal:false});expect(d.runtime.snapshot().profile?.accountId).toBe(cloud.accountId);
});
it('logout_does_not_reactivate_background_hooks_and_switching_back_reactivates_once',async()=>{
 const d=await device(),events:string[]=[];
 await d.runtime.setHooks({async activate(){events.push('activate');},async deactivate(){events.push('deactivate');}});expect(events).toEqual(['activate']);
 await d.runtime.session.logout('leave');expect(d.runtime.snapshot().active).toBe(false);expect(events).toEqual(['activate','deactivate']);
 await d.runtime.session.switchAccount('local-device');expect(d.runtime.snapshot().active).toBe(true);expect(events).toEqual(['activate','deactivate','deactivate','activate']);
});
