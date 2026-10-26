import {createServer, type ServerResponse, type IncomingMessage} from 'node:http';
import {connect} from 'node:net';
import {lstat, chmod, unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {CaptureRuntime, IsolatedResult} from './runtime';
import {CAPTURE_LIMITS, errorOutcome} from './policy';
import {CAPTURE_CONTENT_TYPE, parseWorkerInput, resultHeader, validateCaptureSignature} from './stream-protocol';
import {validateSocketPath} from './remote-runtime';
type Options={socketPath:string;imageDigest:string;runtime:CaptureRuntime;hardTimeoutMs?:number};
/** Private UDS endpoint. Has no queue, credentials, database, or BlobStore authority. */
export class CaptureBroker {
  private ready=false;private stopping=false;private active=0;
  private socketIdentity?:{ino:number;dev:number};
  private readonly controllers=new Set<AbortController>();
  private readonly tasks=new Set<Promise<void>>();
  private readonly server=createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},(req,res)=>{
    const task=this.handle(req,res).catch(()=>{res.destroy();}).finally(()=>this.tasks.delete(task));this.tasks.add(task);
  });
  constructor(private readonly options:Options) {
    validateSocketPath(options.socketPath);
    if(! /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(options.imageDigest))throw Error('IMAGE_PIN_REQUIRED');
    if(options.hardTimeoutMs!==undefined&&(!Number.isSafeInteger(options.hardTimeoutMs)||options.hardTimeoutMs<=0||options.hardTimeoutMs>CAPTURE_LIMITS.videoTimeoutMs))throw Error('INVALID_DEADLINE');
    this.server.maxConnections=16;this.server.keepAliveTimeout=1000;
    this.server.on('clientError',(_error,socket)=>socket.destroy());
  }
  private async availableSocket():Promise<void> {
    const directory=await lstat(dirname(this.options.socketPath));
    if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o027)!==0)throw Error('UNSAFE_SOCKET_DIRECTORY');
    const existing=await lstat(this.options.socketPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!existing)return;
    if(!existing.isSocket()||existing.isSymbolicLink()||existing.uid!==process.getuid?.())throw Error('UNSAFE_CAPTURE_SOCKET');
    const stale=await new Promise<boolean>((resolve,reject)=>{const socket=connect(this.options.socketPath);socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('timeout',()=>{socket.destroy();reject(Error('CAPTURE_SOCKET_BUSY'));});socket.once('error',(error:NodeJS.ErrnoException)=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(true);else reject(Error('CAPTURE_SOCKET_BUSY'));});});
    if(!stale)throw Error('CAPTURE_SOCKET_BUSY');const current=await lstat(this.options.socketPath);if(current.ino!==existing.ino||current.dev!==existing.dev)throw Error('CAPTURE_SOCKET_CHANGED');await unlink(this.options.socketPath);
  }
  async start():Promise<void> {
    if(this.ready)return;await this.availableSocket();this.stopping=false;
    try{await new Promise<void>((resolve,reject)=>{const fail=(error:Error)=>reject(error);this.server.once('error',fail);this.server.listen(this.options.socketPath,()=>{this.server.off('error',fail);resolve();});});this.socketIdentity=await lstat(this.options.socketPath);await chmod(this.options.socketPath,0o660);await this.options.runtime.start();this.ready=true;}
    catch(error){await this.stop();throw error;}
  }
  private async body(req:IncomingMessage):Promise<unknown> {
    if(req.headers['content-type']!=='application/json'||req.headers['content-encoding']!==undefined)throw Error('INVALID_CAPTURE_INPUT');
    if(req.headers['content-length']!==undefined&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>CAPTURE_LIMITS.inputMaxBytes))throw Error('INPUT_LIMIT');
    const bytes=await new Promise<Buffer>((resolve,reject)=>{
      let size=0;const chunks:Buffer[]=[];
      const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',fail);};
      const fail=(error:Error)=>{cleanup();reject(error);};
      const aborted=()=>fail(Error('NETWORK'));
      const data=(chunk:Buffer)=>{size+=chunk.length;if(size>CAPTURE_LIMITS.inputMaxBytes){req.pause();fail(Error('INPUT_LIMIT'));return;}chunks.push(chunk);};
      const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
      req.on('data',data);req.once('end',end);req.once('aborted',aborted);req.once('error',fail);
    });return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void> {
    if(req.method==='GET'&&req.url==='/ready'){res.writeHead(this.ready&&!this.stopping?200:503,{'content-type':'application/json'});res.end(JSON.stringify({protocol:1,ready:this.ready&&!this.stopping,imageDigest:this.options.imageDigest,maxConcurrent:2}));return;}
    if(req.method!=='POST'||req.url!=='/acquire'){res.writeHead(404).end();return;}
    if(!this.ready||this.stopping||this.active>=2||this.controllers.size>=8){res.writeHead(503,{'connection':'close'}).end();return;}
    const controller=new AbortController();this.controllers.add(controller);
    const abort=()=>controller.abort(Error('CANCELLED'));
    const responseClose=()=>{if(!res.writableFinished)abort();};
    req.once('aborted',abort);res.once('close',responseClose);
    const timer=setTimeout(()=>{controller.abort(Error('DEADLINE_EXCEEDED'));res.destroy();},this.options.hardTimeoutMs??CAPTURE_LIMITS.videoTimeoutMs);
    let owned=false,result:IsolatedResult|undefined;
    try {
      let input;try{input=parseWorkerInput(await this.body(req));}catch{res.writeHead(400,{'connection':'close'}).end();return;}
      controller.signal.throwIfAborted();if(this.active>=2){res.writeHead(503).end();return;}
      this.active++;owned=true;result=await this.options.runtime.acquire(input,controller.signal);controller.signal.throwIfAborted();
      const header=resultHeader(result.state==='file'?{state:'file',file:result.file,strategy:result.strategy}:result);
      // Reject an invalid local result before emitting a success stream, so a
      // checksum failure remains non-transient rather than looking like a lost socket.
      if(result.state==='file') {
        const digest=createHash('sha256');let count=0,prefix=Buffer.alloc(0);
        for await(const chunk of createReadStream(result.path,{signal:controller.signal})) {count+=chunk.length;if(count>result.file.size||count>(input.maxBytes??CAPTURE_LIMITS.maxBytes))throw Error('BODY_LIMIT');digest.update(chunk);if(prefix.length<32)prefix=Buffer.concat([prefix,chunk.subarray(0,32-prefix.length)]);}
        if(count!==result.file.size||digest.digest('hex')!==result.file.sha256)throw Error('CHECKSUM_MISMATCH');validateCaptureSignature(prefix,result.file.mime);
      }
      res.writeHead(200,{'content-type':CAPTURE_CONTENT_TYPE,'cache-control':'no-store'});res.write(header);
      if(result.state==='file') {
        const file=result.file,hash=createHash('sha256');let size=0;
        const verifier=new Transform({transform(chunk:Buffer,_encoding,callback){size+=chunk.length;if(size>file.size||size>(input.maxBytes??CAPTURE_LIMITS.maxBytes))callback(Error('BODY_LIMIT'));else{hash.update(chunk);callback(null,chunk);}},flush(callback){callback(size===file.size&&hash.digest('hex')===file.sha256?undefined:Error('CHECKSUM_MISMATCH'));}});
        await pipeline(createReadStream(result.path),verifier,res,{signal:controller.signal});
      }else res.end();
    } catch(error) {
      if(!res.headersSent&&!res.destroyed&&!controller.signal.aborted){res.writeHead(200,{'content-type':CAPTURE_CONTENT_TYPE});res.end(resultHeader(errorOutcome(error)));}else res.destroy();
    } finally {
      clearTimeout(timer);req.off('aborted',abort);res.off('close',responseClose);if(result?.state==='file')await result.dispose().catch(()=>{});if(owned)this.active--;this.controllers.delete(controller);
    }
  }
  async stop():Promise<void> {
    this.stopping=true;this.ready=false;for(const controller of this.controllers)controller.abort(Error('CANCELLED'));
    const closed=new Promise<void>(resolve=>{if(!this.server.listening){resolve();return;}this.server.close(()=>resolve());this.server.closeAllConnections();});
    await this.options.runtime.stop();await Promise.allSettled([...this.tasks]);await closed;
    const existing=await lstat(this.options.socketPath).catch(()=>null);if(existing&&this.socketIdentity&&existing.ino===this.socketIdentity.ino&&existing.dev===this.socketIdentity.dev)await unlink(this.options.socketPath);this.socketIdentity=undefined;
  }
}
