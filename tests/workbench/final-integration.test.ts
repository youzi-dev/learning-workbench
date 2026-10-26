import {afterEach, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, readFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IDBFactory} from 'fake-indexeddb';
import {openDatabase} from '../../server/database';
import {AuthService} from '../../server/auth';
import {SyncService, registryFromManifests} from '../../server/sync';
import {DiskBlobStore} from '../../server/blob';
import {createApp} from '../../server/app';
import {CaptureQueue} from '../../server/capture/queue';
import {createBackup, restoreBackup} from '../../server/backup';
import {catalogSchemas, manifests} from '../../src/workbench/catalog';
import {catalog} from '../../src/workbench/catalog-ui';
import {createWorkbenchRuntime} from '../../src/workbench/runtime';
import {createBrowserConnection} from '../../src/platforms/browser/session';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {openRepository} from '../../src/platforms/browser/repository';
import {BrowserFileStorage} from '../../src/platforms/browser/file-storage';
import {browserProtectedInputs} from '../../src/platforms/browser/protected-inputs';
import {createRepository, emptyRepositoryState, canonical} from '../../src/workbench/storage/repository';
import {CalendarService} from '../../src/modules/calendar/service';
import {JournalService} from '../../src/modules/journal/service';
import {createSyncEngine} from '../../src/workbench/sync/engine';
import {FileCache} from '../../src/workbench/files/cache';
import {createResourceManager} from '../../src/workbench/files/manager';
import {sha256, readJson} from '../../src/workbench/files/storage';
import type {MutationBatch, Entity} from '../../src/workbench/contracts/data';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose();});
async function cloud() {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'final-integration-'))); cleanup.push(() => rm(root,{recursive:true,force:true}));
 const databasePath = join(root,'db.sqlite'), blobDirectory = join(root,'blobs'), backupRoot = join(root,'backups');
 const db = openDatabase(databasePath); cleanup.push(() => db.close());
 const auth = new AuthService(db), account = await auth.provisionOwner(), blobs = new DiskBlobStore(blobDirectory);
 const sync = new SyncService(db, registryFromManifests(manifests));
 const queue = new CaptureQueue(db, {secretKey: new Uint8Array(32).fill(7)});
 const app = createApp({auth,sync,blobs,capture:{queue}});
 await new Promise<void>(resolve => app.listen(0,'127.0.0.1',resolve)); cleanup.push(() => new Promise<void>(resolve => app.close(() => resolve())));
 return {root,databasePath,blobDirectory,backupRoot,db,auth,account,blobs,sync,queue,baseUrl:`http://127.0.0.1:${(app.address() as {port:number}).port}`};
}
const transport = (server: Awaited<ReturnType<typeof cloud>>) => ({handshake: async (hello:any) => server.sync.handshake(hello),pull: (cursor:number,limit:number) => server.sync.pullChanges(server.account,cursor,limit),push: (batch:MutationBatch) => server.sync.applyBatch(server.account,batch)});
async function repository() {const repo = await openRepository('test',{indexedDB:new IDBFactory(),schemas:catalogSchemas});cleanup.push(() => repo.close());return repo;}
const mutation = (deviceId:string,text:string) => ({operationId:randomUUID(),deviceId,entityId:randomUUID(),moduleId:'journal',kind:'journal.entry',schemaVersion:1,baseRevision:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),action:'put' as const,payload:{title:'',text,tags:[],attachments:[]}});
it('I1 actual 99-row CSV and journal flow uses bounded durable batches and server receipts',async()=>{
 const server=await cloud(),repo=await repository(),calendar=new CalendarService(repo,repo.deviceId);
 const csv='title,startLocal,endLocal\n'+Array.from({length:99},(_,i)=>`课程${i},2026-10-26T14:00,2026-10-26T15:00`).join('\n');
 const preview=await calendar.previewImport(csv,'csv');expect(preview.errors).toEqual([]);await calendar.confirmImport(preview);
 await repo.commit({batchId:randomUUID(),mutations:[mutation(repo.deviceId!,'独立日记')]});
 const queued=await repo.pending();expect(queued.map(batch=>batch.mutations.length)).toEqual([100,1,1]);
 for(const batch of queued){expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(1048576);expect(batch.mutations.length).toBeLessThanOrEqual(100);}
 await createSyncEngine(repo,transport(server),{schemas:catalogSchemas}).sync();expect(await repo.pending()).toEqual([]);
 const rows=server.db.prepare('SELECT count(*) AS n FROM sync_entities WHERE account_id=?').get(server.account) as {n:number};expect(rows.n).toBe(102);
 expect(await server.sync.applyBatch(server.account,queued[0])).toEqual(await server.sync.applyBatch(server.account,queued[0]));
 const oversize={batchId:randomUUID(),mutations:[mutation(repo.deviceId!,'字'.repeat(400000))]};
 await expect(repo.commit(oversize)).rejects.toMatchObject({code:'ENTITY_TOO_LARGE'});expect(await repo.pending()).toEqual([]);
 await expect(server.sync.applyBatch(server.account,oversize)).rejects.toThrow('BATCH_TOO_LARGE');
 expect((server.db.prepare('SELECT count(*) AS n FROM sync_entities').get() as {n:number}).n).toBe(102);
});
it('I1 legacy attempted oversize batches retain recovery evidence and cannot starve unrelated work',async()=>{
 const server=await cloud();let state=emptyRepositoryState();const deviceId=randomUUID();state.cursors.deviceId=deviceId;
 const original={batchId:randomUUID(),mutations:Array.from({length:101},(_,i)=>mutation(deviceId,`old${i}`))};
 await expect(server.sync.applyBatch(server.account,original)).rejects.toThrow('INVALID_BATCH');
 expect((server.db.prepare('SELECT count(*) AS n FROM sync_operations').get() as {n:number}).n).toBe(0);
 const indivisible={batchId:randomUUID(),mutations:[mutation(deviceId,'字'.repeat(400000))]};
 for(const [index,batch] of [original,indivisible].entries()) {state.outbox[batch.batchId]={batch,wire:structuredClone(batch),attempted:true,sequence:index+1};state.cursors[`batch:${batch.batchId}`]=canonical(batch);}
 const repo=await createRepository({readonly:false,read:async fn=>fn(state),write:async fn=>{const draft=structuredClone(state);const result=fn(draft);state=draft;return result;},close(){}},{schemas:catalogSchemas});
 await repo.commit({batchId:randomUUID(),mutations:[mutation(deviceId,'new independent')]});
 await createSyncEngine(repo,transport(server),{schemas:catalogSchemas}).sync();
 expect(await repo.pending()).toHaveLength(1);expect((await repo.queue())[0]).toMatchObject({failure:'ENTITY_TOO_LARGE',blocked:true});
 expect(state.cursors[`oversize-recovery:${original.batchId}`]).toMatchObject({wire:original,attempted:true});
 expect((server.db.prepare('SELECT count(*) AS n FROM sync_entities').get() as {n:number}).n).toBe(102);
 await repo.commit({batchId:randomUUID(),mutations:[{...indivisible.mutations[0],operationId:randomUUID(),payload:{title:'修正',text:'用户明确缩短后的内容',tags:[],attachments:[]}}]});
 await createSyncEngine(repo,transport(server),{schemas:catalogSchemas}).sync();expect(await repo.pending()).toEqual([]);expect(state.cursors[`oversize-replaced-by:${indivisible.batchId}`]).toBeTruthy();
});
function store(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
async function device(bytes:Uint8Array) {
 const indexedDB=new IDBFactory(),storage=await BrowserFileStorage.open({indexedDB});cleanup.push(()=>storage.close());
 const source={async import(){return [{token:'source',name:'notes.txt',mime:'text/plain',size:bytes.length}];},async stage(ref:any){return ref;},async read(_ref:any,offset:number,length:number){return bytes.slice(offset,offset+length);}};
 const options={registrations:catalog.filter(item=>item.manifest.id==='library'),ports:createBrowserPorts(source),resources:{storage,source,protectedInputs:await browserProtectedInputs(indexedDB)},connection:createBrowserConnection({metadata:store(),sessionStorage:store()}),open:(accountId:string,deviceId?:string)=>openRepository(accountId,{indexedDB,deviceId,schemas:catalogSchemas}),autoSync:false};
 const runtime=await createWorkbenchRuntime(options);cleanup.push(()=>runtime.stop());return {runtime,options,storage};
}
async function settle(condition:()=>Promise<boolean>){for(let n=0;n<100;n++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('condition not reached');}
it('I2 runtime backup restore survives cache eviction, publishes original, and reaches a fresh device',async()=>{
 const bytes=new TextEncoder().encode('unique offline restored original'),server=await cloud(),a=await device(bytes),b=await device(bytes),c=await device(bytes);
 const [ref]=await a.runtime.snapshot().resources!.importFiles(),id=randomUUID(),file=await a.runtime.snapshot().resources!.bindAsset(id,ref);
 const payload={title:'restore.txt',publicSourceUrl:null,source:'本地导入',acquiredAt:null,...file,purpose:'保留用途',tags:[],availability:'pending'};
 await a.runtime.snapshot().host.invoke('library','save',{id,asset:payload});
 const backup=await a.runtime.snapshot().backup!.exportBackup({includeFiles:true}),preview=await b.runtime.snapshot().backup!.previewRestore(backup);
 await b.runtime.snapshot().backup!.restore(preview);await b.runtime.snapshot().backup!.restore(preview);
 await new FileCache(b.storage,{budgetBytes:0}).collect('local-device');
 expect((await b.runtime.snapshot().resources!.localForAsset(id,file)).state).toBe('staged');
 expect(Object.keys(await readJson(b.storage,'local-device','asset-original-bindings',{}))).toEqual([id]);
 await b.runtime.pair({baseUrl:server.baseUrl,code:await server.auth.createPairingCode(server.account),name:'restored',recover:false,adoptLocal:true});
 await settle(async()=>{await b.runtime.snapshot().resources!.flushUploads();return ((await b.runtime.snapshot().repository.get({moduleId:'library',entityId:id}))?.payload as {availability?:string}|undefined)?.availability==='available';});
 await b.runtime.sync();
 await c.runtime.pair({baseUrl:server.baseUrl,code:await server.auth.createPairingCode(server.account),name:'fresh',recover:false,adoptLocal:false});await c.runtime.sync();
 const fresh=await c.runtime.snapshot().resources!.ensureLocal(id,file);expect(await c.runtime.snapshot().resources!.read(fresh,0,bytes.length)).toEqual(bytes);
});
it('I3 same bytes with different MIME keep immutable marker and historical receipts survive real backup restore',async()=>{
 const server=await cloud(),bytes=new TextEncoder().encode('same bytes'),base={sha256:await sha256(bytes),size:bytes.length,mime:'text/plain'};
 for(const mime of ['text/plain','application/octet-stream']){
  const file={...base,mime},upload=await server.blobs.begin(server.account,file);await server.blobs.putChunk(server.account,upload.uploadId,0,bytes);expect(await server.blobs.commit(server.account,upload.uploadId)).toEqual(file);
  const m=mutation(randomUUID(),'unused');const batch={batchId:randomUUID(),mutations:[{...m,moduleId:'library',kind:'library.asset',payload:{title:mime,publicSourceUrl:null,source:'test',acquiredAt:new Date().toISOString(),...file,purpose:'',tags:[],availability:'available'}}]};await server.sync.applyBatch(server.account,batch);
 }
 expect(await server.blobs.describe(server.account,base.sha256)).toEqual(base);
 const backup=await createBackup(server);const restored=await restoreBackup({backupPath:backup.path,destination:join(server.root,'restored')});
 expect(restored).toBeTruthy();expect(server.db.prepare('SELECT count(*) AS n FROM sync_batches').get()).toMatchObject({n:2});
});
it('I5 real offline paste survives restart/adoption, dispatches once, and excludes signed input from documents',async()=>{
 const server=await cloud(),d=await device(new Uint8Array()),raw='https://example.org/file.pdf?signature=PRIVATE_SIGNED_INPUT';
 const asset=await d.runtime.snapshot().host.invoke('library','collect',{url:raw}) as unknown as Entity;
 expect(await d.runtime.snapshot().resources!.capture.status(asset.id)).toMatchObject({state:'waiting',protected:true});
 expect(new TextDecoder().decode(await d.runtime.snapshot().backup!.exportBackup())).not.toContain('PRIVATE_SIGNED_INPUT');
 expect(JSON.stringify(await readJson(d.storage,'local-device','capture-intents-v1',{}))).not.toContain('PRIVATE_SIGNED_INPUT');
 const original=await d.runtime.snapshot().resources!.capture.status(asset.id);
 await d.runtime.stop();const restarted=await createWorkbenchRuntime(d.options);cleanup.push(()=>restarted.stop());
  await restarted.pair({baseUrl:server.baseUrl,code:await server.auth.createPairingCode(server.account),name:'capture',recover:false,adoptLocal:true});
 await settle(async()=>{await restarted.sync();await restarted.snapshot().resources!.capture.flush();return (await restarted.snapshot().resources!.capture.status(asset.id))?.state==='submitted';});
 await restarted.snapshot().resources!.capture.flush();restarted.notifyOnline();await restarted.sync();
 const status=await restarted.snapshot().resources!.capture.status(asset.id);expect(status?.operationId).toBe(original?.operationId);expect(status?.expiresAt).toBe(original?.expiresAt);
 expect(server.db.prepare('SELECT count(*) AS n FROM capture_jobs').get()).toMatchObject({n:1});
 const input=server.db.prepare('SELECT expires_at AS deadline FROM capture_inputs').get() as {deadline:number};expect(input.deadline).toBe(original?.expiresAt);
 const fetcher=d.options.connection.authorizedFetch;d.options.connection.authorizedFetch=async()=>{throw Error('offline fixture');};
 const second=await restarted.snapshot().host.invoke('library','collect',{url:'https://example.org/other.pdf'}) as unknown as Entity;
 await restarted.snapshot().resources!.capture.flush();await restarted.snapshot().host.setEnabled('library',false);
 d.options.connection.authorizedFetch=fetcher;restarted.notifyOnline();await restarted.sync();await new Promise(resolve=>setTimeout(resolve,20));
 // Module-bound dispatcher remains stopped across reconnect; intent is retained.
 expect(await restarted.snapshot().resources!.capture.status(second.id)).toMatchObject({state:'waiting'});
 expect(server.db.prepare('SELECT count(*) AS n FROM capture_jobs').get()).toMatchObject({n:1});
 await expect(restarted.snapshot().host.invoke('library','collect',{url:'https://example.org/blocked'})).rejects.toThrow();
 await restarted.snapshot().host.setEnabled('library',true);
 await settle(async()=>{await restarted.snapshot().resources!.capture.flush();return (await restarted.snapshot().resources!.capture.status(second.id))?.state==='submitted';});
 expect(server.db.prepare('SELECT count(*) AS n FROM capture_jobs').get()).toMatchObject({n:2});
 const other=await createResourceManager({accountId:'other',signal:new AbortController().signal,storage:d.storage,source:d.options.resources.source}).capture.status(asset.id);expect(other).toBeNull();
});
it('I5 expiry removes protected input, keeps explicit re-supply intent and never falls back to sanitized URL',async()=>{
 const d=await device(new Uint8Array()),asset=await d.runtime.snapshot().host.invoke('library','collect',{url:'https://example.org/file?token=private-expiry'}) as unknown as Entity;
 const item=await d.runtime.snapshot().resources!.capture.status(asset.id);const clock=vi.spyOn(Date,'now').mockReturnValue(item!.expiresAt+1);
 await d.runtime.snapshot().resources!.capture.flush();expect(await d.runtime.snapshot().resources!.capture.status(asset.id)).toMatchObject({state:'needs-input'});
 expect(await d.options.resources.protectedInputs.get('local-device',item!.operationId)).toBeNull();clock.mockRestore();
});
it('I4/I6 downloaded cache shares preview/export leases, pins, removes bytes only, and protects unique originals',async()=>{
 const server=await cloud(),bytes=new TextEncoder().encode('opaque epub bytes'),d=await device(bytes),file={sha256:await sha256(bytes),size:bytes.length,mime:'application/epub+zip'};
 const session=await server.blobs.begin(server.account,file);await server.blobs.putChunk(server.account,session.uploadId,0,bytes);await server.blobs.commit(server.account,session.uploadId);
 let exported:Uint8Array|undefined;
 const manager=createResourceManager({accountId:server.account,signal:new AbortController().signal,storage:d.storage,source:d.options.resources.source,blobs:server.blobs,preview:async()=>({url:'safe-test',async release(){}}),exportFile:async input=>{exported=await d.storage.read(input.accountId,input.keys[0])??undefined;}});
 const ref=await manager.ensureLocal('download',file),preview=await manager.preview(ref);
 await expect(manager.removeLocal('download',file)).rejects.toThrow('FILE_IN_USE');
 await preview.release();await manager.setPinned('download',file,true);
 expect(await manager.localForAsset('download',file)).toMatchObject({state:'cached',pinned:true});
 await manager.exportFile(ref,'book.epub');expect(exported).toEqual(bytes);
 await manager.setPinned('download',file,false);await manager.removeLocal('download',file);expect(await manager.localForAsset('download',file)).toEqual({state:'missing'});
 expect(await server.blobs.read(server.account,file.sha256,0,bytes.length)).toEqual(bytes);
 const [staged]=await manager.importFiles();const original=await manager.bindAsset('original',staged);await expect(manager.removeLocal('original',original)).rejects.toThrow('本机原件受保护');
});
it('I2 repeated restore collision never rebinds existing asset bytes and keeps recoverable originals protected',async()=>{
 const a=await device(new TextEncoder().encode('backup original')),b=await device(new TextEncoder().encode('existing original')),id=randomUUID();
 const save=async(d:Awaited<ReturnType<typeof device>>,title:string)=>{const [ref]=await d.runtime.snapshot().resources!.importFiles(),file=await d.runtime.snapshot().resources!.bindAsset(id,ref);await d.runtime.snapshot().host.invoke('library','save',{id,asset:{title,publicSourceUrl:null,source:'test',acquiredAt:null,...file,purpose:'',tags:[],availability:'pending'}});return file;};
 const incoming=await save(a,'backup'),existing=await save(b,'existing'),backup=await a.runtime.snapshot().backup!.exportBackup({includeFiles:true});
 const preview=await b.runtime.snapshot().backup!.previewRestore(backup);expect(preview.conflicts).toHaveLength(1);await b.runtime.snapshot().backup!.restore(preview);await b.runtime.snapshot().backup!.restore(preview);
 expect(await b.runtime.snapshot().resources!.localForAsset(id,existing)).toMatchObject({state:'staged',file:existing});
 const staged=await readJson<Record<string,{file:{sha256:string}}>>(b.storage,'local-device','staging-index',{});expect(Object.values(staged).map(entry=>entry.file.sha256).sort()).toEqual([incoming.sha256,existing.sha256].sort());
 expect(await b.runtime.snapshot().repository.conflicts()).toHaveLength(1);
});
it('I6 desktop native export streams verified parts to chosen destination and preserves it on revoked chooser',async()=>{
 const {createNativeFiles}=await import('../../src/platforms/electron/files');const server=await cloud(),destination=join(server.root,'saved.epub');
 const files=createNativeFiles({directory:join(server.root,'client'),authorize(account){if(account!=='a')throw Error('wrong account');},save:async()=>destination});
 const bytes=new Uint8Array(1048576).fill(12);await files.storage('write','a','stage:one/part/0',bytes);await files.storage('write','a','stage:one/part/1',new Uint8Array([5]));
 const preview=await files.preview({accountId:'a',keys:['stage:one/part/0','stage:one/part/1'],size:bytes.length+1,mime:'application/epub+zip'});await files.export(preview.token,'book.epub');const saved=await readFile(destination);expect(saved.length).toBe(bytes.length+1);expect(saved.at(-1)).toBe(5);
 files.release(preview.token);await expect(files.export(preview.token,'book.epub')).rejects.toThrow();expect(await readFile(destination)).toEqual(saved);files.close();
});
it('R1 desktop first boot migrates 101+ v1 entities atomically and reopens idempotently',async()=>{
 const {writeFile}=await import('node:fs/promises'),{bootElectronWorkbench}=await import('../../src/platforms/electron/boot'),{sourceFingerprint}=await import('../../src/workbench/storage/repository');
 const fixture=JSON.parse(await readFile(new URL('../fixtures/workbench/v1-complete.json',import.meta.url),'utf8'));
 for(let index=0;index<205;index++)fixture.state.usageRecords.push({...fixture.state.usageRecords[0],id:`first-boot-${index}`});
 const root=await mkdtemp(join(tmpdir(),'migration-count-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));const path=join(root,'document-v1.json'),source=Buffer.from(JSON.stringify(fixture));await writeFile(path,source);
 const first=await bootElectronWorkbench(root);cleanup.push(()=>first.close());const entities=await first.list('learning'),batches=await first.pending(),preferences=await first.devicePreferences(),fingerprint=await sourceFingerprint(source);
 expect(entities.length).toBeGreaterThan(205);expect(batches.length).toBeGreaterThan(2);expect(batches.every(batch=>batch.mutations.length<=100&&Buffer.byteLength(JSON.stringify(batch))<=1048576)).toBe(true);
 expect(await first.migrationStatus(fingerprint)).toMatchObject({active:true,imported:entities.length});expect(await first.recoverySnapshot(fingerprint)).toEqual(new Uint8Array(source));
 first.close();const reopened=await bootElectronWorkbench(root);cleanup.push(()=>reopened.close());expect(await reopened.list('learning')).toEqual(entities);expect(await reopened.pending()).toEqual(batches);expect(await reopened.devicePreferences()).toEqual(preferences);expect(await readFile(path)).toEqual(source);
 // A semantically indivisible oversized legacy record still fails explicitly, preserving source.
 const badRoot=join(root,'oversized');await (await import('node:fs/promises')).mkdir(badRoot);fixture.state.columns[0].messages[0].content='中'.repeat(400000);const bad=Buffer.from(JSON.stringify(fixture));await writeFile(join(badRoot,'document-v1.json'),bad);
 await expect(bootElectronWorkbench(badRoot)).rejects.toMatchObject({code:'ENTITY_TOO_LARGE'});expect(await readFile(join(badRoot,'document-v1.json'))).toEqual(bad);
 const {openRepository:openSqlite}=await import('../../src/platforms/electron/repository');const failed=await openSqlite('local-device',{directory:join(badRoot,'workbench-v2'),schemas:catalogSchemas});cleanup.push(()=>failed.close());expect(await failed.list('learning')).toEqual([]);expect(await failed.pending()).toEqual([]);expect(await failed.devicePreferences()).toBeNull();
});
it.each([false,true])('R2 recovered predecessor follows its own partition and rebases without false conflict (failed sibling %s)',async failedSibling=>{
 const server=await cloud();let state=emptyRepositoryState();const deviceId=randomUUID();state.cursors.deviceId=deviceId;
 const original={batchId:randomUUID(),mutations:Array.from({length:101},(_,index)=>mutation(deviceId,failedSibling&&index===100?'中'.repeat(400000):`original${index}`))};
 const first=original.mutations[0],later={batchId:randomUUID(),mutations:[{...first,operationId:randomUUID(),payload:{...first.payload,text:'later offline edit'}}]};
 state.outbox[original.batchId]={batch:original,wire:structuredClone(original),attempted:true,sequence:1,predecessors:{}};
 state.outbox[later.batchId]={batch:later,attempted:false,sequence:2,predecessors:{[JSON.stringify([first.moduleId,first.entityId])]:original.batchId}};
 const repo=await createRepository({readonly:false,read:async fn=>fn(state),write:async fn=>{const draft=structuredClone(state),result=fn(draft);state=draft;return result;},close(){}},{schemas:catalogSchemas});
 await createSyncEngine(repo,transport(server),{schemas:catalogSchemas}).sync();expect(await repo.conflicts()).toEqual([]);
 expect((await repo.get({moduleId:first.moduleId,entityId:first.entityId}))).toMatchObject({revision:2,payload:{text:'later offline edit'}});
 expect(await repo.pending()).toHaveLength(failedSibling?1:0);expect(state.cursors[`oversize-recovery:${original.batchId}`]).toMatchObject({wire:original,attempted:true});
 if(failedSibling)expect((await repo.queue())[0]).toMatchObject({failure:'ENTITY_TOO_LARGE'});
});
it.each(['notified','inflight','cas-race'] as const)('R3 explicit imported collision choice replaces %s A binding, keeps A bytes and publishes only chosen B',async mode=>{
 const {resolveConflict}=await import('../../src/workbench/sync/conflicts');
 const bytesA=new TextEncoder().encode('original A preserved'),bytesB=new TextEncoder().encode('imported chosen B'),server=await cloud(),source=await device(bytesB),target=await device(bytesA),fresh=await device(new Uint8Array()),id=randomUUID();
 const save=async(d:Awaited<ReturnType<typeof device>>,title:string)=>{const [ref]=await d.runtime.snapshot().resources!.importFiles(),file=await d.runtime.snapshot().resources!.bindAsset(id,ref);await d.runtime.snapshot().host.invoke('library','save',{id,asset:{title,publicSourceUrl:null,source:'test',acquiredAt:null,...file,purpose:title,tags:[],availability:'pending'}});return file;};
 const fileB=await save(source,'chosen B'),backup=await source.runtime.snapshot().backup!.exportBackup({includeFiles:true});
 await target.runtime.pair({baseUrl:server.baseUrl,code:await server.auth.createPairingCode(server.account),name:'target',recover:false,adoptLocal:false});
 let release=()=>{},started=()=>{};const barrier=new Promise<void>(resolve=>{release=resolve;}),begun=new Promise<void>(resolve=>{started=resolve;});let held=false;
 cleanup.push(()=>release());
 if(mode==='cas-race') {
  const repo=target.runtime.snapshot().repository,commit=repo.commit.bind(repo),hashA=await sha256(bytesA);
  repo.commit=async(batch,options)=>{if(!held&&batch.mutations.some(mutation=>{const payload=mutation.payload as {availability?:string;sha256?:string}|null;return payload?.availability==='available'&&payload.sha256===hashA;})){held=true;started();await barrier;}return commit(batch,options);};
 }
 const fetcher=target.options.connection.authorizedFetch;
 if(mode==='inflight')target.options.connection.authorizedFetch=async(...args)=>{if(!held&&args[1].endsWith('/commit')){held=true;started();await barrier;}return fetcher(...args);};
 const fileA=await save(target,'existing A'),resources=target.runtime.snapshot().resources!;
 const active=resources.flushUploads();
 if(mode==='notified'){await active;await target.runtime.sync();}else await begun;
 const localA=await resources.localForAsset(id,fileA);expect(localA.state).toBe('staged');
 const preview=await target.runtime.snapshot().backup!.previewRestore(backup);await target.runtime.snapshot().backup!.restore(preview);
 expect(await resources.localForAsset(id,fileA)).toMatchObject({state:'staged',file:fileA});
 const conflict=(await target.runtime.snapshot().repository.conflicts()).find(item=>item.reason==='import-collision')!;
 await resolveConflict(target.runtime.snapshot().repository,conflict.id,'local',target.runtime.snapshot().repository.deviceId!);target.runtime.snapshot().host.notifyDataChanged();
 await settle(async()=>(await resources.localForAsset(id,fileB)).state==='staged');
 const joined=resources.flushUploads();release();await active;await joined;
 const chosen=await target.runtime.snapshot().repository.get({moduleId:'library',entityId:id});expect(chosen?.payload).toMatchObject({...fileB,availability:'available',purpose:'chosen B'});
 expect(localA.state!=='missing'&&await resources.read(localA.ref,0,bytesA.length)).toEqual(bytesA);
 await target.runtime.sync();await fresh.runtime.pair({baseUrl:server.baseUrl,code:await server.auth.createPairingCode(server.account),name:'fresh',recover:false,adoptLocal:false});await fresh.runtime.sync();
 expect((await fresh.runtime.snapshot().repository.get({moduleId:'library',entityId:id}))?.payload).toMatchObject({...fileB,availability:'available'});
 const ref=await fresh.runtime.snapshot().resources!.ensureLocal(id,fileB);expect(await fresh.runtime.snapshot().resources!.read(ref,0,bytesB.length)).toEqual(bytesB);
});
