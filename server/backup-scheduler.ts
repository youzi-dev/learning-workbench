import {constants} from 'node:fs';
import {open, rename, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBackup} from './backup';
const DAY=86400000, GRACE=2*3600000;
const RETRY=[60000,300000];
export type SchedulerState={version:1;slot:string|null;status:'idle'|'running'|'failed'|'complete';attempts:number;nextAttemptAt:string|null;lastSuccessAt:string|null;lastSuccessSlot:string|null;updatedAt:string;errorCode?:string};
/** 03:00 Asia/Shanghai is always 19:00 UTC on the previous calendar day. */
export function scheduledSlot(now:Date):string{const time=now.getTime(),date=new Date(time);const today=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),19);return new Date(time<today?today-DAY:today).toISOString();}
const empty=():SchedulerState=>({version:1,slot:null,status:'idle',attempts:0,nextAttemptAt:null,lastSuccessAt:null,lastSuccessSlot:null,updatedAt:new Date(0).toISOString()});
const iso=(value:unknown)=>typeof value==='string'&&new Date(value).toISOString()===value;
export async function readSchedulerState(root:string):Promise<SchedulerState>{
  let handle;try{handle=await open(join(root,'.scheduler-status.json'),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty();throw error;}
  try{const s=await handle.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>4096)throw Error('UNSAFE_SCHEDULER_STATE');const value=JSON.parse(await handle.readFile('utf8')) as SchedulerState;
    if(value.version!==1||!['idle','running','failed','complete'].includes(value.status)||!Number.isInteger(value.attempts)||value.attempts<0||value.attempts>3||![value.slot,value.nextAttemptAt,value.lastSuccessAt,value.lastSuccessSlot].every(v=>v===null||iso(v))||!iso(value.updatedAt))throw Error('INVALID_SCHEDULER_STATE');return value;
  }finally{await handle.close();}
}
async function save(root:string,state:SchedulerState){
  const s=await lstat(root);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700)throw Error('UNSAFE_BACKUP_DIRECTORY');
  const temp=join(root,`.scheduler-${randomUUID()}.tmp`);const handle=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}await rename(temp,join(root,'.scheduler-status.json'));const directory=await open(root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
}
export function schedulerHealthy(state:SchedulerState,now:Date):boolean{
  if(state.status==='failed'||!state.lastSuccessAt)return false;
  if(now.getTime()-Date.parse(state.lastSuccessAt)>DAY+GRACE)return false;
  if(state.status==='running'&&now.getTime()-Date.parse(state.updatedAt)>GRACE)return false;
  return (state.lastSuccessSlot??'')>=scheduledSlot(now)||now.getTime()-Date.parse(scheduledSlot(now))<GRACE;
}
/** One process operation at a time; the existing SQLite backup lock also guards separate processes. */
export class BackupScheduler{
  private running=false;private loaded=false;private state=empty();
  constructor(private readonly root:string,private readonly operation:()=>Promise<unknown>=()=>createBackup({databasePath:this.source.databasePath,blobDirectory:this.source.blobDirectory,backupRoot:root}),private readonly source={databasePath:'/data/db.sqlite',blobDirectory:'/data/blobs'}){}
  async tick(now=new Date()):Promise<void>{
    if(this.running)return;this.running=true;
    try{
      if(!this.loaded){this.state=await readSchedulerState(this.root);this.loaded=true;if(this.state.status==='running'){this.state.status='failed';this.state.nextAttemptAt=now.toISOString();this.state.attempts=Math.max(0,this.state.attempts-1);}}
      const slot=scheduledSlot(now);if((this.state.lastSuccessSlot??'')>=slot)return;
      // A backwards clock must never repeat a newer attempted slot.
      if(this.state.slot&&this.state.slot>slot)return;
      if(this.state.slot!==slot){this.state={...this.state,slot,status:'idle',attempts:0,nextAttemptAt:null};}
      if(this.state.attempts>=3||(this.state.nextAttemptAt&&now.getTime()<Date.parse(this.state.nextAttemptAt)))return;
      this.state={...this.state,status:'running',attempts:this.state.attempts+1,nextAttemptAt:null,updatedAt:now.toISOString(),errorCode:undefined};await save(this.root,this.state);
      const started=performance.now();
      try{await this.operation();const completed=new Date(now.getTime()+Math.max(0,performance.now()-started)).toISOString();this.state={...this.state,status:'complete',lastSuccessAt:completed,lastSuccessSlot:slot,updatedAt:completed,errorCode:undefined};}
      catch{this.state={...this.state,status:'failed',errorCode:'BACKUP_FAILED',updatedAt:now.toISOString(),nextAttemptAt:this.state.attempts<3?new Date(now.getTime()+RETRY[this.state.attempts-1]).toISOString():null};}
      await save(this.root,this.state);
    }finally{this.running=false;}
  }
}
