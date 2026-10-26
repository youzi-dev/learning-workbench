import {lstat, readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {assertSqliteRuntime} from './database';
import {validateDeploymentConfig, assertLinuxMount, initializeVolume, initializeKey, validateOwnedDirectory, validatePrivateKey, ensureOwnedDirectory} from './deployment';
import {runCli} from './cli-command';
import {runBrokerCli} from './capture/broker-command';
import {RemoteCaptureRuntime} from './capture/remote-runtime';
import {runBackupCli} from './backup-command';
import {BackupScheduler, readSchedulerState, schedulerHealthy} from './backup-scheduler';
const UID_API=11000,GID_API=11000,UID_BROKER=12000,GID_CONTROL=12001,UID_WEB=13000;
async function data(access:'rw'|'ro'){
  await assertLinuxMount('/data',access);await validateOwnedDirectory('/data',UID_API,GID_API,0o700);
  for(const name of await readdir('/data')){
    if(!['.workbench-volume.json','db.sqlite','db.sqlite-wal','db.sqlite-shm','blobs'].includes(name))throw Error('UNEXPECTED_DATA_VOLUME_CONTENT');
    if(name.startsWith('db.sqlite')){const file=await lstat(`/data/${name}`);if(!file.isFile()||file.isSymbolicLink()||file.uid!==UID_API||(file.mode&0o777)!==0o600)throw Error('UNSAFE_DATABASE_FILE');}
  }
}
async function backupVolume(){await assertLinuxMount('/backups','rw');await validateOwnedDirectory('/backups',UID_API,GID_API,0o700);}
function sqlite(){const db=new DatabaseSync(':memory:');try{assertSqliteRuntime(db);}finally{db.close();}}
async function main(){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='health-api'){const response=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(2500)});if(response.status!==200)throw Error('UNAVAILABLE');return;}
  if(mode==='health-broker'){const remote=new RemoteCaptureRuntime('/control/capture.sock');await remote.checkReady(2000);return;}
  if(mode==='health-scheduler'){if(!schedulerHealthy(await readSchedulerState('/backups'),new Date()))throw Error('BACKUP_STALE_OR_FAILED');return;}
  const config=validateDeploymentConfig(process.env);sqlite();
  if(mode==='init'){
    if(process.getuid?.()!==0)throw Error('BOOTSTRAP_ROOT_REQUIRED');
    for(const [purpose,uid,gid,permissions] of [['data',UID_API,GID_API,0o700],['keys',UID_API,GID_API,0o700],['control',UID_BROKER,GID_CONTROL,0o750],['backups',UID_API,GID_API,0o700],['recovery',UID_API,GID_API,0o700],['caddy-data',UID_WEB,UID_WEB,0o700],['caddy-config',UID_WEB,UID_WEB,0o700]] as const){const path=`/init/${purpose}`;await assertLinuxMount(path,'rw');await initializeVolume(path,{purpose,uid,gid,mode:permissions});if(purpose==='keys')await initializeKey(path,UID_API);}
    console.log(JSON.stringify({status:'initialized'}));return;
  }
  if(mode==='api'){
    if(process.getuid?.()!==UID_API)throw Error('API_UID_REQUIRED');
    await data('rw');await assertLinuxMount('/keys','ro');await validateOwnedDirectory('/keys',UID_API,GID_API,0o700);await validatePrivateKey('/keys/capture.key',UID_API);
    await assertLinuxMount('/control','ro');await validateOwnedDirectory('/control',UID_BROKER,GID_CONTROL,0o750);
    await ensureOwnedDirectory('/data/blobs',UID_API,GID_API,0o700);
    await runCli(['serve','--db','/data/db.sqlite','--schemas','/opt/workbench/schemas.mjs','--host','0.0.0.0','--port','8787','--allowed-origins',config.origins.join(','),'--blob-dir','/data/blobs','--capture','on','--capture-key-file','/keys/capture.key','--capture-socket','/control/capture.sock']);return;
  }
  if(mode==='broker'){
    if(process.getuid?.()!==UID_BROKER)throw Error('BROKER_UID_REQUIRED');
    await assertLinuxMount('/control','rw');await validateOwnedDirectory('/control',UID_BROKER,GID_CONTROL,0o750);
    const socket=await lstat('/var/run/docker.sock');if(!socket.isSocket()||socket.gid!==config.socketGid||(socket.mode&0o007)!==0)throw Error('UNSAFE_DOCKER_SOCKET');
    await runBrokerCli(['--socket','/control/capture.sock','--image',config.image,'--platform',config.platform,'--deployment-id',config.deploymentId,'--scratch-dir','/tmp']);return;
  }
  if(!['scheduler','backup','restore'].includes(mode))throw Error('INVALID_DEPLOYMENT_COMMAND');
  if(process.getuid?.()!==UID_API)throw Error('OPERATIONS_UID_REQUIRED');await backupVolume();
  if(mode==='restore'){
    const [snapshot,destination]=args;if(args.length!==2||!/^snapshot-[A-Za-z0-9_-]{1,110}$/.test(snapshot??'')||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(destination??''))throw Error('RESTORE_NAMES_REQUIRED');
    await assertLinuxMount('/recovery','rw');await validateOwnedDirectory('/recovery',UID_API,GID_API,0o700);
    await runBackupCli(['restore','--snapshot',`/backups/${snapshot}`,'--destination',`/recovery/${destination}`]);return;
  }
  await data('ro');
  if(mode==='backup'){if(args.length)throw Error('INVALID_ARGUMENT');await runBackupCli(['create','--db','/data/db.sqlite','--blob-dir','/data/blobs','--backup-root','/backups']);return;}
  const scheduler=new BackupScheduler('/backups');let current:Promise<void>|undefined,stopping=false;
  const tick=()=>{if(stopping||current)return;current=scheduler.tick().catch(()=>{console.error('SCHEDULER_FAILURE');stopping=true;clearInterval(timer);process.exitCode=1;}).finally(()=>{current=undefined;});};
  await scheduler.tick();console.log(JSON.stringify({status:'scheduler-started',schedule:'03:00 Asia/Shanghai'}));
  const timer=setInterval(tick,30000);
  const stop=()=>{stopping=true;clearInterval(timer);process.off('SIGTERM',stop);process.off('SIGINT',stop);};process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
main().catch(error=>{const code=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'DEPLOYMENT_STARTUP_FAILED';console.error(code);process.exitCode=1;});
