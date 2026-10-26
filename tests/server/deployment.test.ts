import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, realpath, mkdir, writeFile, readFile, chmod, stat, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {buildSync} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {validateDeploymentConfig, assertPersistentMount, validatePrivateKey, initializeVolume, initializeKey, ensureOwnedDirectory} from '../../server/deployment';
import {BackupScheduler, scheduledSlot, schedulerHealthy, readSchedulerState} from '../../server/backup-scheduler';
import {RemoteCaptureRuntime} from '../../server/capture/remote-runtime';
import {createApp} from '../../server/app';
import {openDatabase} from '../../server/database';
import {AuthService} from '../../server/auth';
import {SyncService} from '../../server/sync';
const cleanup:(()=>unknown)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function directory(){const path=await realpath(await mkdtemp(join(tmpdir(),'deployment-')));cleanup.push(()=>rm(path,{recursive:true,force:true}));return path;}
const image=`sha256:${'a'.repeat(64)}`;
const config={WORKBENCH_DOMAIN:'api.example.org',WORKBENCH_PLATFORM:'linux/arm64',WORKBENCH_WORKER_IMAGE:image,WORKBENCH_DEPLOYMENT_ID:'workbench-prod',DOCKER_SOCKET_GID:'999',WORKBENCH_ALLOWED_ORIGINS:'https://localhost,https://app.example.org'};
it('rejects missing/unsafe deployment inputs and broad browser origins',()=>{
  expect(validateDeploymentConfig(config).origins).toEqual(['https://localhost','https://app.example.org']);
  for(const field of Object.keys(config).filter(key=>key!=='WORKBENCH_ALLOWED_ORIGINS'))expect(()=>validateDeploymentConfig({...config,[field]:''})).toThrow();
  for(const domain of ['localhost','127.0.0.1','https://api.example.org','*.example.org','example.org/path'])expect(()=>validateDeploymentConfig({...config,WORKBENCH_DOMAIN:domain})).toThrow();
  for(const value of ['*','http://localhost','https://app.example.org/path','https://user:pass@example.org','https://*.example.org'])expect(()=>validateDeploymentConfig({...config,WORKBENCH_ALLOWED_ORIGINS:value})).toThrow();
  expect(()=>validateDeploymentConfig({...config,WORKBENCH_WORKER_IMAGE:'worker:latest'})).toThrow();
  expect(()=>validateDeploymentConfig({...config,WORKBENCH_PLATFORM:'darwin/arm64'})).toThrow();
});
it('requires an exact persistent mount from Linux mountinfo and the effective access mode',()=>{
  const root='21 1 0:1 / / rw - overlay overlay rw\n';
  expect(()=>assertPersistentMount('/data',root,'rw')).toThrow('PERSISTENT_MOUNT_REQUIRED');
  for(const fs of ['tmpfs','ramfs','overlay'])expect(()=>assertPersistentMount('/data',root+`32 21 0:2 / /data rw - ${fs} volume rw\n`,'rw')).toThrow();
  expect(()=>assertPersistentMount('/data',root+'32 21 8:1 /var/lib/docker/volumes/a/_data /data rw,nosuid - ext4 /dev/sda rw\n','rw')).not.toThrow();
  expect(()=>assertPersistentMount('/data',root+'32 21 8:1 /x /data ro - ext4 /dev/sda rw\n','rw')).toThrow();
  expect(()=>assertPersistentMount('/data',root+'32 21 8:1 /x /data-extra rw - ext4 /dev/sda rw\n','rw')).toThrow();
});
it('initializes only empty owned volumes, preserves their keys, rejects changed owners/modes and unexpected content',async()=>{
  const root=await directory(), uid=process.getuid!(),gid=process.getgid!();
  const keys=join(root,'keys');await mkdir(keys);
  await initializeVolume(keys,{purpose:'keys',uid,gid,mode:0o700});await initializeKey(keys,uid);const first=await readFile(join(keys,'capture.key'));
  await initializeVolume(keys,{purpose:'keys',uid,gid,mode:0o700});await initializeKey(keys,uid);expect(await readFile(join(keys,'capture.key'))).toEqual(first);expect(first.length).toBe(32);
  await chmod(join(keys,'capture.key'),0o644);await expect(validatePrivateKey(join(keys,'capture.key'),uid)).rejects.toThrow();
  await chmod(join(keys,'capture.key'),0o600);await writeFile(join(keys,'capture.key'),Buffer.alloc(32));await expect(initializeKey(keys,uid)).rejects.toThrow();
  await chmod(keys,0o755);await expect(initializeVolume(keys,{purpose:'keys',uid,gid,mode:0o700})).rejects.toThrow();
  const dirty=join(root,'dirty');await mkdir(dirty);await writeFile(join(dirty,'foreign'),'leave me');await expect(initializeVolume(dirty,{purpose:'data',uid,gid,mode:0o700})).rejects.toThrow();expect(await readFile(join(dirty,'foreign'),'utf8')).toBe('leave me');
});
it('reuses the private blob directory on restart and rejects preexisting unsafe directories or symlinks',async()=>{
  const root=await directory(),blobs=join(root,'blobs'),uid=process.getuid!(),gid=process.getgid!();
  await ensureOwnedDirectory(blobs,uid,gid,0o700);await writeFile(join(blobs,'committed-fixture'),'preserve');
  await ensureOwnedDirectory(blobs,uid,gid,0o700);expect(await readFile(join(blobs,'committed-fixture'),'utf8')).toBe('preserve');
  await chmod(blobs,0o755);await expect(ensureOwnedDirectory(blobs,uid,gid,0o700)).rejects.toThrow('UNSAFE_VOLUME_OWNERSHIP');expect((await stat(blobs)).mode&0o777).toBe(0o755);
  const link=join(root,'blob-link');await symlink(blobs,link);await expect(ensureOwnedDirectory(link,uid,gid,0o700)).rejects.toThrow('UNSAFE_VOLUME_OWNERSHIP');
});
it('rejects trivial, missing and symlink capture keys without regenerating them',async()=>{
  const root=await directory(),key=join(root,'key'),uid=process.getuid!();
  await expect(validatePrivateKey(key,uid)).rejects.toThrow();
  for(const bytes of [Buffer.alloc(32),Buffer.from('01234567890123456789012345678901'),Buffer.from('0123456789abcdef0123456789abcdef'),Buffer.from(Array.from({length:32},(_,i)=>i)),Buffer.from('abcdefghijklmnopqrstuvwxyz012345'),randomBytes(12)]){await writeFile(key,bytes,{mode:0o600});await expect(validatePrivateKey(key,uid)).rejects.toThrow();expect(await readFile(key)).toEqual(bytes);}
  await writeFile(key,randomBytes(32));await expect(validatePrivateKey(key,uid)).resolves.toHaveLength(32);
  const link=join(root,'link');await symlink(key,link);await expect(validatePrivateKey(link,uid)).rejects.toThrow();
  const keys=join(root,'keys');await mkdir(keys);await initializeVolume(keys,{purpose:'keys',uid,gid:process.getgid!(),mode:0o700});await unlink(join(keys,'capture.key'));await expect(initializeKey(keys,uid)).rejects.toThrow('CAPTURE_KEY_MISSING');
});
it('health observes a live broker failure and recovery while keeping business routes authenticated',async()=>{
  const root=await directory(),socket=join(root,'broker.sock');let broker=createServer((_req,res)=>res.end(JSON.stringify({protocol:1,ready:true,imageDigest:image,maxConcurrent:2})));
  broker.listen(socket);await once(broker,'listening');
  const remote=new RemoteCaptureRuntime(socket);await remote.start();
  const db=openDatabase(join(root,'db.sqlite'));cleanup.push(()=>db.close());
  const app=createApp({auth:new AuthService(db),sync:new SyncService(db,{}),readiness:async()=>{db.prepare('SELECT 1').get();await remote.checkReady(250);}});
  app.listen(0,'127.0.0.1');await once(app,'listening');cleanup.push(()=>new Promise<void>(resolve=>app.close(()=>resolve())));
  const base=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
  expect((await fetch(base+'/healthz')).status).toBe(200);expect((await fetch(base+'/v1/sync/pull')).status).toBe(401);
  await new Promise<void>(resolve=>broker.close(()=>resolve()));expect((await fetch(base+'/healthz')).status).toBe(503);
  broker=createServer((_req,res)=>res.end(JSON.stringify({protocol:1,ready:true,imageDigest:image,maxConcurrent:2})));broker.listen(socket);await once(broker,'listening');cleanup.push(()=>new Promise<void>(resolve=>broker.close(()=>resolve())));
  expect((await fetch(base+'/healthz')).status).toBe(200);expect(await (await fetch(base+'/healthz')).json()).toEqual({status:'ready'});await remote.stop();
});
it('calculates 03:00 Shanghai slots independently of host timezone and catches up without overlap',async()=>{
  expect(scheduledSlot(new Date('2026-10-24T18:59:59Z'))).toBe('2026-10-23T19:00:00.000Z');expect(scheduledSlot(new Date('2026-10-24T19:00:00Z'))).toBe('2026-10-24T19:00:00.000Z');
  const root=await directory();let count=0,release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
  const scheduler=new BackupScheduler(root,async()=>{count++;await blocked;});const now=new Date('2026-10-24T20:00:00Z');
  const first=scheduler.tick(now);await new Promise(resolve=>setTimeout(resolve,30));await scheduler.tick(now);expect(count).toBe(1);release();await first;
  const state=await readSchedulerState(root);expect(state.lastSuccessSlot).toBe('2026-10-24T19:00:00.000Z');expect(schedulerHealthy(state,now)).toBe(true);
  const restarted=new BackupScheduler(root,async()=>{count++;});await restarted.tick(now);expect(count).toBe(1);await restarted.tick(new Date('2026-10-25T20:00:00Z'));expect(count).toBe(2);
  await restarted.tick(new Date('2026-10-24T20:00:00Z'));expect(count).toBe(2);
});
it('persists bounded retries, reports failure/staleness and resumes abandoned work after restart',async()=>{
  const root=await directory();let calls=0;const scheduler=new BackupScheduler(root,async()=>{calls++;throw Error('PRIVATE_PATH_TOKEN_should_not_be_logged');});
  const now=new Date('2026-10-24T20:00:00Z');await scheduler.tick(now);let state=await readSchedulerState(root);expect(state.status).toBe('failed');expect(schedulerHealthy(state,now)).toBe(false);expect(JSON.stringify(state)).not.toContain('PRIVATE_PATH');
  await scheduler.tick(new Date(now.getTime()+1000));expect(calls).toBe(1);
  await scheduler.tick(new Date(now.getTime()+60000));await scheduler.tick(new Date(now.getTime()+360000));await scheduler.tick(new Date(now.getTime()+3600000));expect(calls).toBe(3);
  await scheduler.tick(new Date('2026-10-25T20:00:00Z'));expect(calls).toBe(4);
  state={...state,status:'running',attempts:1,nextAttemptAt:null};await writeFile(join(root,'.scheduler-status.json'),JSON.stringify(state),{mode:0o600});
  const recovered=new BackupScheduler(root,async()=>{calls++;});await recovered.tick(now);expect(calls).toBe(5);expect(schedulerHealthy(await readSchedulerState(root),new Date('2026-10-26T20:00:00Z'))).toBe(false);
});
it('scheduler invokes the existing real online backup implementation and persists completed status',async()=>{
  const root=await directory(),data=join(root,'data'),backups=join(root,'backups');await mkdir(data,{mode:0o700});await mkdir(backups,{mode:0o700});await mkdir(join(data,'blobs'),{mode:0o700});
  const db=openDatabase(join(data,'db.sqlite'));cleanup.push(()=>db.close());
  const scheduler=new BackupScheduler(backups,undefined,{databasePath:join(data,'db.sqlite'),blobDirectory:join(data,'blobs')});await scheduler.tick(new Date());const state=await readSchedulerState(backups);expect(state.status).toBe('complete');expect(state.lastSuccessAt).toBeTruthy();expect((await stat(join(backups,'.scheduler-status.json'))).mode&0o077).toBe(0);
});

it('the emitted deployment bundle runs only its selected command, without imported CLI side effects',async()=>{
  const root=await directory(),bundle=join(root,'deploy.mjs');
  buildSync({entryPoints:['server/deploy-entry.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node24'});
  const child=spawnSync(process.execPath,[bundle,'init'],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:10000});
  expect(child.error).toBeUndefined();expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr.trim()).toBe('PUBLIC_DOMAIN_REQUIRED');
});
