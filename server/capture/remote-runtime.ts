import {request, type IncomingMessage} from 'node:http';
import {isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import type {WorkerInput} from '../../worker/runner';
import type {CaptureRuntime, IsolatedResult} from './runtime';
import {CAPTURE_LIMITS} from './policy';
import {CAPTURE_CONTENT_TYPE, parseWorkerInput, readCaptureResult} from './stream-protocol';
export function validateSocketPath(path:string):void {if(!isAbsolute(path)||Buffer.byteLength(path)>100||path.includes('\0'))throw Error('INVALID_CAPTURE_SOCKET');}
/** API-side transport only. stop() cancels these requests, never the broker service. */
export class RemoteCaptureRuntime implements CaptureRuntime {
  private ready=false;
  private readonly active=new Set<AbortController>();
  constructor(readonly socketPath:string,private readonly scratchRoot=tmpdir()) {validateSocketPath(socketPath);}
  private async withResponse<T>(path:string,body:Buffer|undefined,signal:AbortSignal,consume:(response:IncomingMessage)=>Promise<T>):Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve,reject)=>{
      const req=request({socketPath:this.socketPath,path,method:body?'POST':'GET',agent:false,maxHeaderSize:8192,headers:body?{'content-type':'application/json','content-length':body.length}:{}},response=>{
        void consume(response).then(resolve,reject).finally(()=>{response.destroy();req.destroy();});
      });
      const abort=()=>req.destroy(signal.reason instanceof Error?signal.reason:Error('CANCELLED'));
      signal.addEventListener('abort',abort,{once:true});
      req.once('error',error=>reject(signal.aborted?(signal.reason instanceof Error?signal.reason:Error('CANCELLED')):Object.assign(Error('NETWORK'),{cause:error})));
      req.once('close',()=>signal.removeEventListener('abort',abort));
      if(signal.aborted)abort();else req.end(body);
    });
  }
  private async operation<T>(signal:AbortSignal,timeout:number,run:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const own=new AbortController();this.active.add(own);const combined=AbortSignal.any([signal,own.signal]);const timer=setTimeout(()=>own.abort(Error('DEADLINE_EXCEEDED')),timeout);
    try{return await run(combined);}finally{clearTimeout(timer);this.active.delete(own);}
  }
  async checkReady(timeout=1500):Promise<void> {
    await this.operation(new AbortController().signal,timeout,signal=>this.withResponse('/ready',undefined,signal,async res=>{
      if(res.statusCode!==200)throw Error('ISOLATION_NOT_READY');
      let size=0;const chunks:Buffer[]=[];for await(const data of res){size+=data.length;if(size>4096)throw Error('CAPTURE_PROTOCOL');chunks.push(data);}
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(!value||Object.keys(value).sort().join(',')!=='imageDigest,maxConcurrent,protocol,ready'||value.protocol!==1||value.ready!==true||value.maxConcurrent!==2||typeof value.imageDigest!=='string'||! /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(value.imageDigest))throw Error('CAPTURE_PROTOCOL');
    }));
  }
  async start():Promise<void> {this.ready=false;await this.checkReady(10000);this.ready=true;}
  async acquire(input:WorkerInput,signal:AbortSignal):Promise<IsolatedResult> {
    if(!this.ready)throw Error('ISOLATION_NOT_READY');const checked=parseWorkerInput(input);
    return this.operation(signal,CAPTURE_LIMITS.videoTimeoutMs,combined=>this.withResponse('/acquire',Buffer.from(JSON.stringify(checked)),combined,async res=>{
      if(res.statusCode!==200)throw Error(res.statusCode===503?'NETWORK':'CAPTURE_PROTOCOL');
      if(res.headers['content-type']!==CAPTURE_CONTENT_TYPE||res.headers['content-encoding']!==undefined)throw Error('CAPTURE_PROTOCOL');
      try{return await readCaptureResult(res,this.scratchRoot,combined,checked.maxBytes);}catch(error){
        if(combined.aborted)throw combined.reason;
        // Parser rejection also destroys the source while HTTP may still be
        // open. Preserve that explicit security failure; only an actual stream
        // interruption belongs to the queue's transient network retry budget.
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
        if(['ECONNRESET','ERR_STREAM_PREMATURE_CLOSE'].includes(code))throw Error('NETWORK');
        throw error;
      }
    }));
  }
  async stop():Promise<void> {this.ready=false;for(const controller of this.active)controller.abort(Error('CANCELLED'));}
}
