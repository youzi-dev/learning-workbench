import {constants} from 'node:fs';
import {chmod, chown, lstat, mkdir, open, readFile, readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
export const DEPLOYMENT_PATHS={data:'/data',keys:'/keys',control:'/control',backups:'/backups',recovery:'/recovery'} as const;
const PIN=/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/;
export function validateDeploymentConfig(env:NodeJS.ProcessEnv){
  const domain=env.WORKBENCH_DOMAIN??'';
  if(domain.length>253||! /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)||domain.endsWith('.localhost')||domain.endsWith('.local'))throw Error('PUBLIC_DOMAIN_REQUIRED');
  const platform=env.WORKBENCH_PLATFORM;if(!['linux/amd64','linux/arm64'].includes(platform??''))throw Error('PLATFORM_REQUIRED');
  const image=env.WORKBENCH_WORKER_IMAGE??'';if(!PIN.test(image))throw Error('WORKER_IMAGE_PIN_REQUIRED');
  const deploymentId=env.WORKBENCH_DEPLOYMENT_ID??'';if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(deploymentId))throw Error('DEPLOYMENT_ID_REQUIRED');
  const socketGid=env.DOCKER_SOCKET_GID??'';if(!/^[0-9]{1,10}$/.test(socketGid)||Number(socketGid)>2147483647)throw Error('DOCKER_SOCKET_GID_REQUIRED');
  const origins=(env.WORKBENCH_ALLOWED_ORIGINS??'https://localhost').split(',').map(v=>v.trim());
  if(origins.length>2||new Set(origins).size!==origins.length||!origins.includes('https://localhost')||origins.some(origin=>{try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||url.username!==''||url.password!==''||url.hostname.includes('*');}catch{return true;}}))throw Error('UNSAFE_ALLOWED_ORIGINS');
  return {domain,platform:platform as 'linux/amd64'|'linux/arm64',image,deploymentId,socketGid:Number(socketGid),origins};
}
function unescapeMount(value:string){return value.replace(/\\([0-7]{3})/g,(_match,octal:string)=>String.fromCharCode(parseInt(octal,8)));}
/** Exact mountpoint proof; a directory on the image's writable layer never qualifies. */
export function assertPersistentMount(path:string,mountinfo:string,access:'rw'|'ro'):void{
  const entries=mountinfo.trim().split('\n').map(line=>{const [left,right]=line.split(' - ');const fields=left.split(' ');return {path:unescapeMount(fields[4]??''),options:(fields[5]??'').split(','),fs:right?.split(' ')[0]};});
  const mount=entries.reverse().find(entry=>entry.path===path);
  if(!mount||!mount.fs||['tmpfs','ramfs','overlay','aufs','squashfs','nfs','nfs4','cifs','smb3','9p'].includes(mount.fs)||!mount.options.includes(access))throw Error('PERSISTENT_MOUNT_REQUIRED');
}
export async function assertLinuxMount(path:string,access:'rw'|'ro'){if(process.platform!=='linux')throw Error('LINUX_HOST_REQUIRED');assertPersistentMount(path,await readFile('/proc/self/mountinfo','utf8'),access);}
/** A default-pattern guard, not an entropy proof. Bootstrap still uses randomBytes(32). */
function predictableKey(bytes:Uint8Array):boolean{
  for(let period=1;period<=16;period++)if(bytes.every((byte,index)=>byte===bytes[index%period]))return true;
  if(bytes.every((byte,index)=>byte===(bytes[0]+index)%256)||bytes.every((byte,index)=>byte===(bytes[0]-index+256)%256))return true;
  return /0123456789|abcdefghijklmnopqrstuvwxyz|ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(Buffer.from(bytes).toString('latin1'));
}
export async function validatePrivateKey(path:string,uid:number):Promise<Uint8Array>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const details=await file.stat();if(!details.isFile()||details.size!==32||details.uid!==uid||(details.mode&0o777)!==0o600)throw Error('UNSAFE_CAPTURE_KEY');const bytes=await file.readFile();if(bytes.length!==32||new Set(bytes).size<16||predictableKey(bytes))throw Error('UNSAFE_CAPTURE_KEY');return new Uint8Array(bytes);}finally{await file.close();}
}
export type VolumeOwner={purpose:string;uid:number;gid:number;mode:number};
const MARKER='.workbench-volume.json';
export async function validateOwnedDirectory(path:string,uid:number,gid:number,mode:number){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o777)!==mode)throw Error('UNSAFE_VOLUME_OWNERSHIP');}
export async function ensureOwnedDirectory(path:string,uid:number,gid:number,mode:number){
  try{await mkdir(path,{mode});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  await validateOwnedDirectory(path,uid,gid,mode);
}
/** Only an empty explicitly-mounted volume may be adopted. No recursive chown. */
export async function initializeVolume(path:string,owner:VolumeOwner):Promise<void>{
  const details=await lstat(path);if(!details.isDirectory()||details.isSymbolicLink())throw Error('UNSAFE_VOLUME');
  const entries=await readdir(path);const marker=join(path,MARKER);
  if(entries.length){
    await validateOwnedDirectory(path,owner.uid,owner.gid,owner.mode);
    const handle=await open(marker,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const info=await handle.stat();if(!info.isFile()||info.uid!==owner.uid||(info.mode&0o777)!==0o600||JSON.stringify(JSON.parse(await handle.readFile('utf8')))!==JSON.stringify({version:1,...owner}))throw Error('UNEXPECTED_VOLUME_CONTENT');}finally{await handle.close();}
    return;
  }
  if(details.uid!==0&&details.uid!==owner.uid)throw Error('UNSAFE_VOLUME_OWNERSHIP');
  await chown(path,owner.uid,owner.gid);await chmod(path,owner.mode);
  if(owner.purpose==='keys')await initializeKey(path,owner.uid);
  const handle=await open(marker,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify({version:1,...owner}));await handle.chown(owner.uid,owner.gid);await handle.sync();}finally{await handle.close();}
  const directory=await open(path,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
}
export async function initializeKey(directory:string,uid:number):Promise<void>{
  const path=join(directory,'capture.key');const entries=await readdir(directory);
  if(entries.some(name=>![MARKER,'capture.key','.key-created'].includes(name)))throw Error('UNEXPECTED_KEY_VOLUME_CONTENT');
  if(entries.includes('capture.key')){await validatePrivateKey(path,uid);return;}
  if(entries.includes('.key-created')||entries.includes(MARKER))throw Error('CAPTURE_KEY_MISSING');
  // Only first initialization of an empty private volume may create this key.
  const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(randomBytes(32));await handle.chown(uid,(await lstat(directory)).gid);await handle.sync();}finally{await handle.close();}
  await validatePrivateKey(path,uid);
  const marker=await open(join(directory,'.key-created'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await marker.writeFile('1');await marker.chown(uid,(await lstat(directory)).gid);await marker.sync();}finally{await marker.close();}
  const parent=await open(directory,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}
}
