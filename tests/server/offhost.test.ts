import {afterEach, expect, it} from 'vitest';
import {mkdtemp, realpath, mkdir, writeFile, chmod, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../server/database';
import {createBackup, pruneBackups, withLatestVerifiedBackup} from '../../server/backup';
import {readReplicationConfig, Replicator, readReplicationState, replicationHealthy, resticEnvironment, replicationConfigIdentity} from '../../server/offhost';
const clean: (()=>unknown)[]=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
async function root(){const p=await realpath(await mkdtemp(join(tmpdir(),'offhost-')));clean.push(()=>rm(p,{recursive:true,force:true}));return p;}
async function fixture(){const p=await root();const backups=join(p,'backups'),blobs=join(p,'blobs');await mkdir(backups,{mode:0o700});await mkdir(blobs,{mode:0o700});const db=openDatabase(join(p,'db.sqlite'));clean.push(()=>db.close());const snapshot=await createBackup({databasePath:join(p,'db.sqlite'),blobDirectory:blobs,backupRoot:backups});return {p,backups,snapshot};}
it('validates only new selected snapshots, checks exact id and keeps the existing lock across transfer',async()=>{
 const {backups,snapshot}=await fixture();let release!:()=>void;const hold=new Promise<void>(r=>release=r);let selected!:()=>void;const entered=new Promise<void>(r=>selected=r);
 const run=withLatestVerifiedBackup(backups,null,async path=>{expect(path).toBe(snapshot.path);selected();await hold;});await entered;
 await expect(pruneBackups({backupRoot:backups})).rejects.toThrow('BACKUP_BUSY');release();await run;
 // An already transferred id skips full hashing; a new transfer must reject damage.
 await writeFile(join(snapshot.path,'database.sqlite'),'damaged');expect(await withLatestVerifiedBackup(backups,snapshot.manifest.id,async()=>{throw Error('must not run');})).toEqual({status:'unchanged',id:snapshot.manifest.id});
 await expect(withLatestVerifiedBackup(backups,null,async()=>{})).rejects.toThrow();
});
it('rejects private config permissions, symlinks and unsafe repositories without leaking values',async()=>{
 const p=await root();const op=join(p,'operator');await mkdir(op,{mode:0o700});const files={'repository':'s3:https://objects.example.org/workbench','password':'random-encryption-password-very-long','credentials.json':JSON.stringify({accessKeyId:'fixtureAccessKey123',secretAccessKey:'fixtureSecretValue1234567890'})};
 for(const [name,value]of Object.entries(files))await writeFile(join(op,name),value,{mode:0o600});
 const c=await readReplicationConfig(op,'stable-prod',async()=>[{address:'93.184.216.34',family:4}]);expect(c.deploymentId).toBe('stable-prod');await writeFile(join(op,'password'),'changed-private-password-value-123');const changed=await readReplicationConfig(op,'stable-prod',async()=>[{address:'93.184.216.34',family:4}]);expect(changed.identity).not.toBe(c.identity);await writeFile(join(op,'password'),files.password);expect(resticEnvironment(c)).not.toHaveProperty('AWS_PROFILE');expect(resticEnvironment(c)).not.toHaveProperty('NODE_OPTIONS');
 await chmod(join(op,'password'),0o644);await expect(readReplicationConfig(op,'stable-prod',async()=>[{address:'93.184.216.34',family:4}])).rejects.toThrow('UNSAFE_OPERATOR_FILE');await chmod(join(op,'password'),0o600);
 for(const url of ['s3:http://objects.example.org/bucket','s3:https://user:pass@example.org/bucket','s3:https://127.0.0.1/bucket','s3:https://example.org/bucket?secret=x','/local/repo']){await writeFile(join(op,'repository'),url);await expect(readReplicationConfig(op,'stable-prod',async()=>[{address:'93.184.216.34',family:4}])).rejects.toThrow('INVALID_REPOSITORY');}
 await writeFile(join(op,'repository'),files.repository);await rm(join(op,'password'));await symlink(join(op,'repository'),join(op,'password'));await expect(readReplicationConfig(op,'stable-prod',async()=>[{address:'93.184.216.34',family:4}])).rejects.toThrow();
});
it('runs filtered stable retention after backup, persists only both successes, single flights and bounds retries',async()=>{
 const {backups,p,snapshot}=await fixture();const config={identity:'a'.repeat(64),deploymentId:'stable-prod',repositoryFile:join(p,'repository'),passwordFile:join(p,'password'),credentials:{accessKeyId:'fixtureAccessKey123',secretAccessKey:'fixtureSecretValue1234567890'}};
 const commands:string[][]=[];let fail=true;const runner=async(args:string[])=>{commands.push(args);if(args[0]==='forget'&&fail)throw Error('raw secret /private/path');};
 const replicate=new Replicator(backups,config,runner);const now=new Date();await replicate.tick(now);let state=await readReplicationState(backups);expect(state.status).toBe('failed');expect(state.lastSuccessId).toBeNull();expect(JSON.stringify(state)).not.toContain('raw secret');
 expect(commands[0]).toEqual(['backup','--host','stable-prod','--tag','personal-workbench','--',snapshot.manifest.id]);expect(commands[1]).toEqual(['forget','--host','stable-prod','--tag','personal-workbench','--group-by','host,tags','--keep-daily','7','--keep-weekly','4']);
 await replicate.tick(new Date(now.getTime()+1000));expect(commands).toHaveLength(2);fail=false;await replicate.tick(new Date(now.getTime()+300000));state=await readReplicationState(backups);expect(state.lastSuccessId).toBe(snapshot.manifest.id);expect(replicationHealthy(state,new Date(now.getTime()+300000),config.identity)).toBe(true);expect(replicationHealthy(state,new Date(now.getTime()+27*3600000),config.identity)).toBe(false);
 await replicate.tick(new Date(now.getTime()+600000));expect(commands).toHaveLength(4);expect((await readFile(join(backups,'.replication-status.json'),'utf8'))).not.toContain('fixtureSecret');
});

it('missing current config persists incomplete even when a previous success is inside retry interval',async()=>{
 const {backups,p}=await fixture();const config={identity:'a'.repeat(64),deploymentId:'stable-prod',repositoryFile:join(p,'repository'),passwordFile:join(p,'password'),credentials:{accessKeyId:'fixtureAccessKey123',secretAccessKey:'fixtureSecretValue1234567890'}};
 const now=new Date();await new Replicator(backups,config,async()=>{}).tick(now);expect(replicationHealthy(await readReplicationState(backups),now,config.identity)).toBe(true);
 await new Replicator(backups,null,async()=>{throw Error('must not run');}).tick(new Date(now.getTime()+1000));const state=await readReplicationState(backups);expect(state.status).toBe('incomplete');expect(replicationHealthy(state,now,config.identity)).toBe(false);
});
it('single flights concurrent ticks and releases the maintenance lock after cancelled transfer',async()=>{
 const {backups,p}=await fixture();const config={identity:'a'.repeat(64),deploymentId:'stable-prod',repositoryFile:join(p,'repository'),passwordFile:join(p,'password'),credentials:{accessKeyId:'fixtureAccessKey123',secretAccessKey:'fixtureSecretValue1234567890'}};
 let calls=0,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),controller=new AbortController();
 const runner=async(_args:string[],options:{signal:AbortSignal})=>{calls++;entered();await new Promise<void>((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});};
 const replicator=new Replicator(backups,config,runner);const first=replicator.tick(new Date(),controller.signal);await ready;const second=replicator.tick(new Date(),controller.signal);expect(first).toBe(second);expect(calls).toBe(1);controller.abort();await first;expect((await readReplicationState(backups)).status).toBe('failed');await expect(pruneBackups({backupRoot:backups})).resolves.toBeTruthy();
});

it('binds success to current target and deployment, retransfers legacy states and rejects changed-file health',async()=>{
 const {backups,p}=await fixture(),now=new Date();const credentials={accessKeyId:'fixtureAccessKey123',secretAccessKey:'fixtureSecretValue1234567890'};
 const identity=(repo:string,host='stable-prod',password='private-password-123')=>replicationConfigIdentity(repo,host,password,credentials);
 const config={identity:identity('s3:https://objects.example.org/target-a'),deploymentId:'stable-prod',repositoryFile:join(p,'repository'),passwordFile:join(p,'password'),credentials};
 let calls=0;const runner=async()=>{calls++;};await new Replicator(backups,config,runner).tick(now);
 const original=await readReplicationState(backups);expect(original.lastSuccessIdentity).toBe(config.identity);
 const changed={...config,identity:identity('s3:https://objects.example.org/target-b')};
 expect(replicationHealthy(original,now,changed.identity)).toBe(false);
 // Changing target within background cooldown cannot claim healthy for the new target.
 expect((await new Replicator(backups,changed,runner).tick(new Date(now.getTime()+1000))).status).toBe('deferred');expect(calls).toBe(2);
 expect((await new Replicator(backups,changed,runner).tick(new Date(now.getTime()+300000))).status).toBe('transferred');expect(calls).toBe(4);
 const otherHost={...changed,deploymentId:'other-deployment',identity:identity('s3:https://objects.example.org/target-b','other-deployment')};
 expect((await new Replicator(backups,otherHost,runner).tick(new Date(now.getTime()+600000))).status).toBe('transferred');expect(calls).toBe(6);
 const legacy=await readReplicationState(backups);delete (legacy as {lastSuccessIdentity?:string|null}).lastSuccessIdentity;await writeFile(join(backups,'.replication-status.json'),JSON.stringify(legacy));
 expect((await new Replicator(backups,otherHost,runner).tick(new Date(now.getTime()+900000))).status).toBe('transferred');expect(calls).toBe(8);
 expect(identity('s3:https://OBJECTS.example.org:443/target-b')).toBe(changed.identity);
 expect(identity('s3:https://objects.example.org/target-b','stable-prod','other-password')).not.toBe(changed.identity);
 expect(replicationHealthy(await readReplicationState(backups),new Date(now.getTime()+900000),identity('s3:https://objects.example.org/target-b','other-deployment','changed-on-disk'))).toBe(false);
 expect(JSON.stringify(await readReplicationState(backups))).not.toContain('objects.example.org');
});
it('explicit once force transfers latest S2 inside cooldown while background returns deferred',async()=>{
 const {backups,p}=await fixture();const now=new Date();const config={identity:'a'.repeat(64),deploymentId:'stable-prod',repositoryFile:join(p,'repository'),passwordFile:join(p,'password'),credentials:{accessKeyId:'fixtureAccessKey123',secretAccessKey:'fixtureSecretValue1234567890'}};const commands:string[][]=[];
 const replicator=new Replicator(backups,config,async args=>{commands.push(args);});await replicator.tick(now);
 const second=await createBackup({databasePath:join(p,'db.sqlite'),blobDirectory:join(p,'blobs'),backupRoot:backups,now:()=>new Date(now.getTime()+60000)});
 expect((await replicator.tick(new Date(now.getTime()+120000))).status).toBe('deferred');expect(commands).toHaveLength(2);
 expect((await replicator.tick(new Date(now.getTime()+120000),undefined,{force:true})).status).toBe('transferred');expect(commands).toHaveLength(4);expect(commands[2].at(-1)).toBe(second.manifest.id);
});
