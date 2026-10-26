import {afterEach, expect, it} from 'vitest';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../server/database';
import {AuthService} from '../../server/auth';
import {SyncService, registryFromManifests} from '../../server/sync';
import {createApp} from '../../server/app';
import {manifests} from '../../src/workbench/catalog';
import {createDesktopSession} from '../../src/platforms/electron/session';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
async function env() {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-session-')); cleanups.push(() => rm(directory, {recursive: true, force: true}));
  const db = openDatabase(join(directory, 'server.sqlite')); cleanups.push(() => db.close()); const auth = new AuthService(db), accountId = await auth.provisionOwner();
  const server = createApp({auth, sync: new SyncService(db, registryFromManifests(manifests))}); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const safeStorage = {isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`), decryptString: (value: Uint8Array) => Buffer.from(Buffer.from(value).toString().slice(10), 'base64').toString(), getSelectedStorageBackend: () => 'keychain'};
  return {directory, auth, accountId, safeStorage, baseUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`};
}
it('main_process_keeps_tokens_encrypted_and_renderer_repository_handles_remain_account_bound', async () => {
  const e = await env(), desktop = await createDesktopSession(e); cleanups.push(() => desktop.close());
  const initial = await desktop.initialize();
  const profile = await desktop.pair({baseUrl: e.baseUrl, code: await e.auth.createPairingCode(e.accountId), name: '桌面', recover: false, adoptLocal: false}, initial.local.deviceId!);
  expect(Object.keys(profile).sort()).toEqual(['accountId', 'baseUrl', 'deviceId']);
  await desktop.saveProfile(profile);
  const account = await desktop.openProfile(profile.accountId, profile.deviceId);
  expect(account.handle).not.toBe(initial.local.handle);
  expect(await desktop.repositoryCall(initial.local.handle, 'list', ['journal'])).toEqual([]);
  expect(await desktop.repositoryCall(account.handle, 'queue', [])).toEqual([]);
  await expect(desktop.repositoryCall(account.handle, 'constructor', [])).rejects.toMatchObject({code: 'invalid-operation'});
  await expect(desktop.openProfile('00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({code: 'profile-unavailable'});
  await desktop.sync(profile, 'handshake', {protocolVersion: 1, hostApiVersion: 1, schemas: {}});
  const files = await readdir(join(e.directory, 'workbench-v2', 'credentials'));
  expect(files).toHaveLength(1); const bytes = await readFile(join(e.directory, 'workbench-v2', 'credentials', files[0]), 'utf8'); expect(bytes.startsWith('encrypted:')).toBe(true);
  const metadata = await readFile(join(e.directory, 'workbench-v2', 'connection.json'), 'utf8'); expect(metadata).not.toContain('token'); expect(metadata).not.toContain('encrypted:');
  desktop.close(); const reopened = await createDesktopSession(e); cleanups.push(() => reopened.close()); expect((await reopened.initialize()).profile).toEqual(profile); await reopened.sync(profile, 'handshake', {protocolVersion: 1, hostApiVersion: 1, schemas: {}});
});
it.each([false, 'basic_text'] as const)('refuses_pairing_before_network_when_safe_storage_is_%s', async unavailable => {
  const e = await env();
  const desktop = await createDesktopSession({...e, safeStorage: {...e.safeStorage, isEncryptionAvailable: () => unavailable !== false, getSelectedStorageBackend: () => unavailable === 'basic_text' ? 'basic_text' : 'keychain'}}); cleanups.push(() => desktop.close());
  const initial = await desktop.initialize(), code = await e.auth.createPairingCode(e.accountId);
  await expect(desktop.pair({baseUrl: e.baseUrl, code, name: '桌面', recover: false, adoptLocal: false}, initial.local.deviceId!)).rejects.toMatchObject({code: 'SECURE_STORAGE_UNAVAILABLE'});
  // The unused code still pairs on a working secure adapter: unsafe storage did not consume it.
  desktop.close(); const secure = await createDesktopSession(e); cleanups.push(() => secure.close()); await expect(secure.pair({baseUrl: e.baseUrl, code, name: '桌面', recover: false, adoptLocal: false}, initial.local.deviceId!)).resolves.toMatchObject({accountId: e.accountId});
});
it('renderer_runtime_uses_main_process_sync_and_preserves_repository_error_codes_across_rpc', async () => {
  const e = await env(), desktop = await createDesktopSession(e); cleanups.push(() => desktop.close());
  const {desktopRequest} = await import('../../src/platforms/electron/session');
  const {desktopCall, electronConnection, electronRepository, createElectronPorts} = await import('../../src/platforms/electron/ports');
  const {createWorkbenchRuntime} = await import('../../src/workbench/runtime');
  const {manifest} = await import('../../src/modules/journal/manifest'); const {createModule} = await import('../../src/modules/journal/module');
  const results: unknown[] = [];
  const bridge = {async request(operation: string, args: unknown[] = []) {const result = await desktopRequest(desktop, operation, structuredClone(args)); results.push(result); return structuredClone(result);}};
  const runtime = await createWorkbenchRuntime({registrations: [{manifest, load: async () => createModule()}], ports: createElectronPorts(), autoSync: false, connection: electronConnection(bridge), async open(accountId, deviceId) {return electronRepository(bridge, await desktopCall(bridge, 'open-profile', [accountId, deviceId]));}});
  cleanups.push(() => runtime.stop());
  await runtime.pair({baseUrl: e.baseUrl, code: await e.auth.createPairingCode(e.accountId), name: '桌面桥接', recover: false, adoptLocal: false});
  await runtime.snapshot().host.invoke('journal', 'save', {text: '真实桥接保存', tags: [], attachments: []}); await runtime.sync();
  const repository = runtime.snapshot().repository; expect(await repository.pending()).toEqual([]); expect((await repository.list('journal'))[0].revision).toBe(1);
  await expect(repository.resolutionTarget('00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({code: 'missing-conflict'});
  expect(JSON.stringify(results)).not.toContain('"token"');
});
it('renderer_abort_signal_cancels_the_main_process_file_request_instead_of_being_dropped', async () => {
  const e = await env(); let started!: () => void, nativeSignal: AbortSignal | null = null;
  const began = new Promise<void>(resolve => {started = resolve;});
  const desktop = await createDesktopSession({...e, fetch: async (url, init) => {
    if (!String(url).endsWith('/v1/blobs/delayed')) return fetch(url, init);
    nativeSignal = init!.signal!; started();
    return new Promise<Response>((_resolve, reject) => {nativeSignal!.addEventListener('abort', () => reject(nativeSignal!.reason), {once: true});});
  }}); cleanups.push(() => desktop.close());
  const {desktopRequest} = await import('../../src/platforms/electron/session');
  const {electronConnection} = await import('../../src/platforms/electron/ports');
  const bridge = {request: (operation: string, args: unknown[] = []) => desktopRequest(desktop, operation, structuredClone(args))};
  const connection = electronConnection(bridge), initial = await desktop.initialize();
  const profile = await connection.pair({baseUrl: e.baseUrl, code: await e.auth.createPairingCode(e.accountId), name: '可取消文件', recover: false, adoptLocal: false}, initial.local.deviceId!);
  const controller = new AbortController();
  const pending = connection.authorizedFetch(profile, '/v1/blobs/delayed', {signal: controller.signal});
  const outcome = pending.then(() => 'resolved', cause => cause.name as string);
  await began; controller.abort(); await new Promise(resolve => setTimeout(resolve, 10));
  expect((nativeSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(await outcome).toBe('AbortError');
});
it('learning_native_binding_rejects_stale_profile_handles_after_account_change',async()=>{const e=await env(),desktop=await createDesktopSession(e);cleanups.push(()=>desktop.close());const initial=await desktop.initialize();expect(desktop.learningRepository(initial.local.handle).deviceId).toBe(initial.local.deviceId);const profile=await desktop.pair({baseUrl:e.baseUrl,code:await e.auth.createPairingCode(e.accountId),name:'学习隔离',recover:false,adoptLocal:false},initial.local.deviceId!);const account=await desktop.openProfile(profile.accountId,profile.deviceId);expect(()=>desktop.learningRepository(account.handle)).toThrow();await desktop.saveProfile(profile);expect(()=>desktop.learningRepository(initial.local.handle)).toThrow();expect(desktop.learningRepository(account.handle).deviceId).toBe(profile.deviceId);await desktop.saveProfile(null);expect(()=>desktop.learningRepository(account.handle)).toThrow();});
it('calendar_rpc_binds_actual_current_repository_and_invalid_requests_preserve_prior_reminders',async()=>{
 const {desktopRequest}=await import('../../src/platforms/electron/session');
 const {CalendarService}=await import('../../src/modules/calendar/service');
 const e=await env(),desktop=await createDesktopSession({...e,calendar:{enabled:async()=>true,native:{supported:()=>true,create:()=>{throw Error('not due');}}}});cleanups.push(()=>desktop.close());
 const initial=await desktop.initialize(),repository=desktop.learningRepository(initial.local.handle),service=new CalendarService(repository,repository.deviceId);
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10);await service.create({title:'账户自己的提醒',kind:'meeting',startLocal:`${date}T14:00`,endLocal:`${date}T15:00`,timeZone:'Asia/Shanghai',weekly:null,taskId:null,location:'',notes:'',reminderMinutes:10,sourceUid:null});
 expect(await desktopRequest(desktop,'calendar-bind',[initial.local.handle])).toMatchObject({ok:true,value:{pending:1,permission:'unknown'}});
 for(const args of [[],[null],['invented'],[initial.local.handle,'extra']])expect(await desktopRequest(desktop,'calendar-bind',args)).toMatchObject({ok:false});
 expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{pending:1}});
 expect(await desktopRequest(desktop,'calendar-reconcile',['local-device',[{title:'renderer forged alert'}]])).toMatchObject({ok:false});
 const id=(await service.series())[0].id;
 const proxy={...repository,commit:(...args:Parameters<typeof repository.commit>)=>desktop.repositoryCall(initial.local.handle,'commit',args) as ReturnType<typeof repository.commit>};
 await new CalendarService(proxy,repository.deviceId).delete(id);expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{pending:0}});
 await service.create({title:'切换时取消',kind:'meeting',startLocal:`${date}T16:00`,endLocal:`${date}T17:00`,timeZone:'Asia/Shanghai',weekly:null,taskId:null,location:'',notes:'',reminderMinutes:10,sourceUid:null});await desktopRequest(desktop,'calendar-retry',[]);
 expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{pending:1}});
 const profile=await desktop.pair({baseUrl:e.baseUrl,code:await e.auth.createPairingCode(e.accountId),name:'日程账户',recover:false,adoptLocal:false},initial.local.deviceId!);await desktop.saveProfile(profile);
 expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{pending:0}});
 expect(await desktopRequest(desktop,'calendar-bind',[initial.local.handle])).toMatchObject({ok:false});
 const account=await desktop.openProfile(profile.accountId,profile.deviceId);expect(await desktopRequest(desktop,'calendar-bind',[account.handle])).toMatchObject({ok:true});
 await desktop.clearCredential(profile.accountId);expect(await desktopRequest(desktop,'calendar-bind',[account.handle])).toMatchObject({ok:false});
});
it('calendar_schedule_rebuilds_after_synced_changes_and_device_module_settings',async()=>{
 const {desktopRequest}=await import('../../src/platforms/electron/session');const e=await env();let enabled=true;
 const desktop=await createDesktopSession({...e,calendar:{enabled:async()=>enabled,native:{supported:()=>true,create:()=>{throw Error('not due');}}}});cleanups.push(()=>desktop.close());
 const initial=await desktop.initialize();await desktopRequest(desktop,'calendar-bind',[initial.local.handle]);
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10),at=new Date().toISOString();
 const entity={id:crypto.randomUUID(),moduleId:'calendar',kind:'calendar.series',schemaVersion:1,revision:1,createdAt:at,updatedAt:at,deletedAt:null as string|null,payload:{title:'另一设备保存的会议',kind:'meeting',startLocal:`${date}T14:00`,endLocal:`${date}T15:00`,timeZone:'Asia/Shanghai',weekly:null,taskId:null,location:'',notes:'',reminderMinutes:10,sourceUid:null}};
 const apply=async(cursor:number)=>desktop.repositoryCall(initial.local.handle,'apply',[{changes:[{cursor,batchId:crypto.randomUUID(),entities:[entity]}],nextCursor:cursor,hasMore:false}]);
 await apply(1);expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{pending:1}});
 await desktop.calendarSettingsChange(async()=>{enabled=false;});expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{state:'disabled',pending:0}});
 await desktop.calendarSettingsChange(async()=>{enabled=true;});expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{state:'scheduled',pending:1}});
 entity.deletedAt=at;entity.revision=2;await apply(2);expect(await desktopRequest(desktop,'calendar-status',[])).toMatchObject({ok:true,value:{pending:0}});
});
it('desktop_local_logout_stops_calendar_and_switching_back_rebinds_saved_reminders',async()=>{
 const {desktopRequest}=await import('../../src/platforms/electron/session');const {desktopCall,electronRepository,electronConnection,createElectronPorts}=await import('../../src/platforms/electron/ports');const {desktopCalendarHooks}=await import('../../src/platforms/electron/reminder-hooks');const {createWorkbenchRuntime}=await import('../../src/workbench/runtime');const {manifest}=await import('../../src/modules/calendar/manifest');const {createModule}=await import('../../src/modules/calendar/module');
 const e=await env(),desktop=await createDesktopSession({...e,calendar:{enabled:async()=>true,native:{supported:()=>true,create:()=>{throw Error('not due');}}}});cleanups.push(()=>desktop.close());
 const bridge={request:(operation:string,args:unknown[]=[])=>desktopRequest(desktop,operation,args)},handles=new WeakMap<object,{handle:string;accountId:string}>();
 const runtime=await createWorkbenchRuntime({registrations:[{manifest,load:async()=>createModule()}],ports:createElectronPorts(undefined,bridge),autoSync:false,connection:electronConnection(bridge),hooks:desktopCalendarHooks(bridge,handles,{}),async open(accountId,deviceId){const handle=await desktopCall<import('../../src/platforms/electron/session').RepositoryHandle>(bridge,'open-profile',[accountId,deviceId]);const repository=electronRepository(bridge,handle);handles.set(repository,{...handle,accountId});return repository;}});cleanups.push(()=>runtime.stop());
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10);await runtime.snapshot().host.invoke('calendar','create',{title:'本机退出保留',kind:'meeting',startLocal:`${date}T14:00`,endLocal:`${date}T15:00`,timeZone:'Asia/Shanghai',weekly:null,taskId:null,location:'',notes:'',reminderMinutes:10,sourceUid:null});
 expect(desktop.calendarStatus().pending).toBe(1);await runtime.session.logout('leave');expect(runtime.snapshot()).toMatchObject({active:false,error:null});expect(desktop.calendarStatus()).toMatchObject({state:'stopped',pending:0});
 await runtime.session.switchAccount('local-device');expect(runtime.snapshot()).toMatchObject({active:true,error:null});expect(desktop.calendarStatus()).toMatchObject({state:'scheduled',pending:1});
});
it('I5 protected paste survives main restart, explicit local adoption preserves expiry and account access is scoped',async()=>{
 const e=await env(),first=await createDesktopSession(e),id=crypto.randomUUID(),raw='https://example.org/file?signature=fixture-only',deadline=Date.now()+60000;cleanups.push(()=>first.close());
 await first.captureInput('put','local-device',id,raw,deadline);first.close();
 const reopened=await createDesktopSession(e);cleanups.push(()=>reopened.close());expect(await reopened.captureInput('get','local-device',id)).toBe(raw);
 const initial=await reopened.initialize(),profile=await reopened.pair({baseUrl:e.baseUrl,code:await e.auth.createPairingCode(e.accountId),name:'paste adoption',recover:false,adoptLocal:true},initial.local.deviceId!);
 expect(await reopened.adoptCaptureInput('local-device',profile.accountId,id)).toBe(true);await reopened.saveProfile(profile);
 expect(await reopened.captureInput('get',profile.accountId,id)).toBe(raw);await expect(reopened.captureInput('get','local-device',id)).rejects.toMatchObject({code:'profile-unavailable'});
 await reopened.captureInput('put',profile.accountId,id,raw,deadline+86400000);
 const {vi}=await import('vitest');const clock=vi.spyOn(Date,'now').mockReturnValue(deadline+1);
 try{expect(await reopened.captureInput('get',profile.accountId,id)).toBeNull();}finally{clock.mockRestore();}
});
