import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import type {WorkerInput} from '../../worker/runner';
import type {CaptureRuntime, IsolatedResult} from './runtime';
import {CAPTURE_LIMITS} from './policy';
import {parseWorkerInput, readCaptureResult} from './stream-protocol';
const execute=promisify(execFile);
export interface DockerCommandAdapter {run(args:string[],signal?:AbortSignal):Promise<string>}
const docker:DockerCommandAdapter={async run(args,signal){return (await execute('docker',args,{maxBuffer:1048576,timeout:60000,signal})).stdout.trim();}};
export type DockerRuntimeOptions={image:string;platform:'linux/amd64'|'linux/arm64';deploymentId:string;scratchRoot?:string;driver?:DockerCommandAdapter};
const LABEL='org.workbench.capture';
/** Trusted controller. Docker commands, image, paths, limits and network are fixed
 * at startup; no request can supply any of these controls. */
export class IsolatedCaptureRuntime implements CaptureRuntime {
  private readonly instance=randomUUID();
  private readonly prefix:string;
  private readonly scratch:string;
  private readonly driver:DockerCommandAdapter;
  private readonly running=new Map<AbortController,Promise<IsolatedResult>>();
  private proxyIp='';private ready=false;private ownsResources=false;
  constructor(private readonly options:DockerRuntimeOptions) {
    if(! /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(options.image))throw Error('IMAGE_PIN_REQUIRED');
    if(!['linux/amd64','linux/arm64'].includes(options.platform)||! /^[a-z0-9][a-z0-9-]{0,47}$/.test(options.deploymentId))throw Error('INVALID_BROKER_CONFIGURATION');
    if(options.scratchRoot!==undefined&&!isAbsolute(options.scratchRoot))throw Error('INVALID_SCRATCH_ROOT');
    this.driver=options.driver??docker;this.prefix=`workbench-capture-${options.deploymentId}-${this.instance}`;this.scratch=join(options.scratchRoot??tmpdir(),`workbench-broker-${options.deploymentId}`);
  }
  private labels(role:string):string[] {return [`${LABEL}.owner=capture-broker-v1`,`${LABEL}.deployment=${this.options.deploymentId}`,`${LABEL}.instance=${this.instance}`,`${LABEL}.role=${role}`].flatMap(value=>['--label',value]);}
  private async reconcile(instance?:string):Promise<void> {
    const filters=[`${LABEL}.owner=capture-broker-v1`,`${LABEL}.deployment=${this.options.deploymentId}`,...(instance?[`${LABEL}.instance=${instance}`]:[])].flatMap(value=>['--filter',`label=${value}`]);
    for(const kind of ['container','network'] as const) {
      const output=await this.driver.run(kind==='container'?['ps','-aq',...filters]:['network','ls','-q',...filters]);const ids=output?output.split(/\s+/):[];
      if(ids.length>256||ids.some(id=>! /^[a-f0-9]{12,64}$/.test(id)))throw Error('OWNED_RESOURCE_LIMIT');
      if(ids.length)await this.driver.run(kind==='container'?['rm','-f',...ids]:['network','rm',...ids]);
    }
  }
  async start():Promise<void> {
    if(this.ready)return;
    let inspected;
    try {inspected=JSON.parse(await this.driver.run(['image','inspect',this.options.image]));}catch{throw Error('IMAGE_NOT_VERIFIED');}
    const image=Array.isArray(inspected)&&inspected.length===1?inspected[0]:null;
    if(!image||image.Os!=='linux'||`linux/${image.Architecture}`!==this.options.platform||(this.options.image.startsWith('sha256:')?image.Id!==this.options.image:!Array.isArray(image.RepoDigests)||!image.RepoDigests.includes(this.options.image)))throw Error('IMAGE_NOT_VERIFIED');
    // Startup is serialized by the broker socket owner. Only this deployment's
    // two fixed ownership labels qualify a resource for restart reconciliation.
    await this.reconcile();
    const previous=await lstat(this.scratch).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(previous&&(!previous.isDirectory()||previous.isSymbolicLink()||previous.uid!==process.getuid?.()||(previous.mode&0o077)!==0))throw Error('UNSAFE_SCRATCH_ROOT');
    if(previous)await rm(this.scratch,{recursive:true,force:true});
    await mkdir(this.scratch,{mode:0o700});this.ownsResources=true;
    try {
      await this.driver.run(['network','create','--internal',...this.labels('private-network'),`${this.prefix}-private`]);
      await this.driver.run(['run','--log-driver','none','--pull=never','-d','--name',`${this.prefix}-proxy`,'--platform',this.options.platform,'--network',`${this.prefix}-private`,...this.labels('proxy'),'--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user','10001:10001','--pids-limit','64','--memory','256m','--cpus','0.5','--entrypoint','node',this.options.image,'/opt/workbench/proxy.mjs']);
      await this.driver.run(['network','connect','bridge',`${this.prefix}-proxy`]);
      const proxy=JSON.parse(await this.driver.run(['inspect',`${this.prefix}-proxy`]));this.proxyIp=proxy[0].NetworkSettings.Networks[`${this.prefix}-private`].IPAddress;
      if(! /^\d{1,3}(?:\.\d{1,3}){3}$/.test(this.proxyIp))throw Error('ISOLATION_NOT_READY');this.ready=true;
    }catch(error){await this.stop();throw error;}
  }
  async stop():Promise<void> {
    this.ready=false;for(const controller of this.running.keys())controller.abort(Error('CANCELLED'));
    await Promise.allSettled([...this.running.values()]);if(this.ownsResources){await this.reconcile(this.instance);await rm(this.scratch,{recursive:true,force:true});this.ownsResources=false;}
  }
  async acquire(input:WorkerInput,signal:AbortSignal):Promise<IsolatedResult> {
    if(!this.ready)throw Error('ISOLATION_NOT_READY');signal.throwIfAborted();const own=new AbortController(),combined=AbortSignal.any([signal,own.signal]);
    const task=this.run(parseWorkerInput(input),combined);this.running.set(own,task);try{return await task;}finally{this.running.delete(own);}
  }
  private async run(input:WorkerInput,signal:AbortSignal):Promise<IsolatedResult> {
    const id=`${this.prefix}-${randomUUID()}`,guard=`${id}-guard`;
    try {
      signal.throwIfAborted();
      await this.driver.run(['run','--log-driver','none','--pull=never','-d','--name',guard,'--platform',this.options.platform,'--network',`${this.prefix}-private`,...this.labels('guard'),'--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SETPCAP','--security-opt','no-new-privileges','--read-only','--user','0:0','--pids-limit','32','--memory','64m','--cpus','0.25','-e',`WORKBENCH_PROXY_IP=${this.proxyIp}`,'--entrypoint','/bin/sh',this.options.image,'/opt/workbench/egress-guard.sh']);
      let secure=false;
      for(let attempts=0;attempts<20;attempts++) {signal.throwIfAborted();const state=await this.driver.run(['exec',guard,'cat','/proc/1/status'],signal);if(/Uid:\s+10001\s/.test(state)&&/CapEff:\s+0000000000000000/.test(state)){secure=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
      if(!secure)throw Error('ISOLATION_NOT_READY');signal.throwIfAborted();
      const args=['create','--log-driver','none','--pull=never','--rm','-i','--name',id,'--platform',this.options.platform,'--network',`container:${guard}`,...this.labels('downloader'),'--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user','10001:10001','--pids-limit','64','--memory','1536m','--cpus','1','--tmpfs','/work:rw,noexec,nosuid,nodev,size=1073741824,uid=10001,gid=10001','-e',`WORKBENCH_PROXY=http://${this.proxyIp}:3128`,this.options.image];
      // Finish fixed container creation before observing cancellation, so a killed
      // CLI cannot leave a daemon-side creation racing the final removal.
      await this.driver.run(args);signal.throwIfAborted();
      const child=spawn('docker',['start','--attach','--interactive',id],{stdio:['pipe','pipe','ignore']});
      const completed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});void completed.catch(()=>{});
      // Register immediately: abort during Docker creation is followed by a final
      // fixed-name cleanup after the creation command has settled.
      const abort=()=>{void this.driver.run(['rm','-f',id]).catch(()=>{});child.kill('SIGTERM');};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...input,maxBytes:input.maxBytes??CAPTURE_LIMITS.maxBytes,imagePdfTimeoutMs:input.imagePdfTimeoutMs??CAPTURE_LIMITS.imagePdfTimeoutMs,videoTimeoutMs:input.videoTimeoutMs??CAPTURE_LIMITS.videoTimeoutMs}));
      let result:IsolatedResult|undefined;
      try {result=await readCaptureResult(child.stdout,this.scratch,signal,input.maxBytes);const code=await completed;signal.throwIfAborted();if(code!==0)throw Error('WORKER_FAILED');return result;}
      catch(error){if(result?.state==='file')await result.dispose();child.kill('SIGTERM');await completed.catch(()=>{});throw error;}
      finally{signal.removeEventListener('abort',abort);}
    } finally {await this.driver.run(['rm','-f',id,guard]).catch(()=>{});}
  }
}
