import {afterEach, expect, it} from 'vitest';
import {createServer, request} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile, stat, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {CaptureBroker} from '../../server/capture/broker';
import {RemoteCaptureRuntime} from '../../server/capture/remote-runtime';
import {readCaptureResult, parseWorkerInput, resultHeader, CAPTURE_CONTENT_TYPE} from '../../server/capture/stream-protocol';
import type {CaptureRuntime, IsolatedResult} from '../../server/capture/runtime';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const image = `sha256:${'a'.repeat(64)}`;
const bytes = Buffer.from('%PDF-1.7\nprivate fixture\n%%EOF');
const descriptor = {sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime:'application/pdf'};
async function directory() {const dir = await mkdtemp(join(tmpdir(), 'cb-')); cleanups.push(() => rm(dir,{recursive:true,force:true})); return dir;}
function idleRuntime(acquire: CaptureRuntime['acquire']): CaptureRuntime {return {async start(){}, async stop(){}, acquire};}
async function setup(runtime: CaptureRuntime, hardTimeoutMs?: number) {const dir = await directory(), socket = join(dir,'s'); const broker = new CaptureBroker({socketPath:socket, imageDigest:image, runtime, hardTimeoutMs}); await broker.start(); cleanups.push(() => broker.stop()); const remote = new RemoteCaptureRuntime(socket); await remote.start(); cleanups.push(() => remote.stop()); return {broker, remote, socket, dir};}
async function post(socket: string, value: unknown) {return new Promise<number>((resolve,reject) => {const req = request({socketPath:socket,path:'/acquire',method:'POST',headers:{'content-type':'application/json'}}, res => {res.resume(); res.on('end',()=>resolve(res.statusCode!));}); req.on('error',reject); req.end(JSON.stringify(value));});}
it('strictly rejects all request escalation keys, credentials, wrong ports and raised budgets', () => {
  for (const extra of [{image:'evil'}, {args:[]}, {env:{}}, {path:'/tmp'}, {maxBytes:1073741825}, {videoTimeoutMs:1800001}, {url:'https://user:pass@example.org/'}, {url:'https://example.org:444/'}]) expect(() => parseWorkerInput({url:'https://example.org/',...extra})).toThrow();
  expect(parseWorkerInput({url:'https://example.org/',maxBytes:12})).toEqual({url:'https://example.org/',maxBytes:12});
});
it('uses real UDS, does not cancel on normal request-body close, independently verifies bytes and disposes private scratch', async () => {
  let disposed = false;
  const dir = await directory(); const path = join(dir,'resource'); await writeFile(path,bytes);
  const {remote} = await setup(idleRuntime(async (_input,signal) => {await new Promise(r=>setTimeout(r,20)); signal.throwIfAborted(); return {state:'file',path,file:descriptor,strategy:'https',async dispose(){disposed=true;}};}));
  const result = await remote.acquire({url:'https://example.org/manual.pdf'},new AbortController().signal);
  expect(result.state).toBe('file'); if(result.state!=='file') throw Error('fixture');
  expect((await stat(result.path)).mode & 0o777).toBe(0o600); expect(result.file).toEqual(descriptor); await result.dispose(); expect(disposed).toBe(true); await expect(stat(result.path)).rejects.toThrow();
});
it('refuses a third acquisition before invoking the owned runtime and cancellation stops the actual operation', async () => {
  let starts=0, aborted=0;
  const {remote,socket} = await setup(idleRuntime(async (_input,signal) => {starts++; return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++; reject(Error('CANCELLED'));},{once:true});});}));
  const a = new AbortController(), b = new AbortController();
  const pending = [remote.acquire({url:'https://example.org/a'},a.signal).catch(e=>e), remote.acquire({url:'https://example.org/b'},b.signal).catch(e=>e)];
  await expect.poll(()=>starts).toBe(2); expect(await post(socket,{url:'https://example.org/c'})).toBe(503); expect(starts).toBe(2);
  a.abort(); b.abort(); await Promise.all(pending); await expect.poll(()=>aborted).toBe(2);
});
it('broker hard deadline aborts the owned runtime and remote stop only aborts its own requests', async () => {
  let aborted=0;
  const {remote,broker,socket} = await setup(idleRuntime(async (_input,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(Error('DEADLINE_EXCEEDED'));},{once:true}))),30);
  await expect(remote.acquire({url:'https://example.org/'},new AbortController().signal)).rejects.toThrow(); await expect.poll(()=>aborted).toBe(1);
  await remote.stop(); const other = new RemoteCaptureRuntime(socket); await other.start(); await other.stop(); expect(broker).toBeDefined();
});
it.each([
  ['truncated',Buffer.concat([resultHeader({state:'file',file:descriptor,strategy:'https'}),bytes.subarray(0,-1)])],
  ['extra',Buffer.concat([resultHeader({state:'file',file:descriptor,strategy:'https'}),bytes,Buffer.from('x')])],
  ['hash',Buffer.concat([resultHeader({state:'file',file:{...descriptor,sha256:'b'.repeat(64)},strategy:'https'}),bytes])],
  ['mime',Buffer.from(JSON.stringify({state:'file',file:{...descriptor,mime:'text/html'},strategy:'https'})+'\n')],
  ['path',Buffer.from(JSON.stringify({state:'failed',errorCode:'NETWORK',path:'/secret'})+'\n')],
  ['header',Buffer.from('x'.repeat(65537))],
  ['nonfile bytes',Buffer.from('{"state":"unsupported","errorCode":"UNSUPPORTED_TYPE"}\nx')],
])('rejects %s framing and never returns a result', async (_name, wire) => {const dir = await directory(); await expect(readCaptureResult(Readable.from([wire]),dir,new AbortController().signal)).rejects.toThrow();});
it('remote rejects protocol mismatch and premature half-stream disconnect', async () => {
  const dir=await directory(), socket=join(dir,'s'); let ready = false;
  const server = createServer((req,res)=>{if(req.url==='/ready'){res.end(JSON.stringify({protocol:ready?1:2,ready:true,imageDigest:image,maxConcurrent:2}));return;} res.writeHead(200,{'content-type':CAPTURE_CONTENT_TYPE});res.write(resultHeader({state:'file',file:descriptor,strategy:'https'}));res.write(bytes.subarray(0,2));setTimeout(()=>res.destroy(),10);});
  await new Promise<void>(resolve=>server.listen(socket,resolve));cleanups.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const remote=new RemoteCaptureRuntime(socket);await expect(remote.start()).rejects.toThrow();ready=true;await remote.start();await expect(remote.acquire({url:'https://example.org/'},new AbortController().signal)).rejects.toThrow('NETWORK');await remote.stop();
});
it('rejects symlink socket and never unlinks a live broker socket', async () => {
  const {socket,dir}=await setup(idleRuntime(async()=>({state:'unsupported',errorCode:'UNSUPPORTED_TYPE'})));
  const other=new CaptureBroker({socketPath:socket,imageDigest:image,runtime:idleRuntime(async()=>({state:'failed',errorCode:'NETWORK'}))});await expect(other.start()).rejects.toThrow();
  const link=join(dir,'link');await symlink(socket,link);const linked=new CaptureBroker({socketPath:link,imageDigest:image,runtime:idleRuntime(async()=>({state:'failed',errorCode:'NETWORK'}))});await expect(linked.start()).rejects.toThrow();
});
it('rejects oversized raw input and unknown endpoint without touching runtime',async()=>{
  let starts=0;const {socket}=await setup(idleRuntime(async()=>{starts++;return {state:'failed',errorCode:'NETWORK'};}));
  expect(await post(socket,{url:'https://example.org/',image:'evil'})).toBe(400);
  expect([400,-1]).toContain(await post(socket,{url:'https://example.org/',doi:'x'.repeat(33000)}).catch(()=>-1));expect(starts).toBe(0);
});
it('rejects unsigned candidate metadata and state escalation in result headers',()=>{
  for(const value of [{state:'saved',errorCode:'OK'}, {state:'failed',errorCode:'secret raw url'}, {state:'needs-selection',errorCode:'SELECT_SOURCE',candidates:[{id:'1',url:'https://example.org/?token=secret',source:'example.org',version:null,matchReason:'fixture',permission:'public'}]}])expect(()=>resultHeader(value)).toThrow();
});
it('remote stop aborts in-flight operations and a second remote can keep using the broker',async()=>{
  let starts=0,aborted=0;const {remote,socket}=await setup(idleRuntime(async(input,signal)=>{starts++;if(input.url.endsWith('/quick'))return {state:'unsupported',errorCode:'UNSUPPORTED_TYPE'};return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(Error('CANCELLED'));},{once:true}));}));
  const pending=remote.acquire({url:'https://example.org/slow'},new AbortController().signal).catch(e=>e);await expect.poll(()=>starts).toBe(1);await remote.stop();await pending;await expect.poll(()=>aborted).toBe(1);
  const second=new RemoteCaptureRuntime(socket);await second.start();expect(await second.acquire({url:'https://example.org/quick'},new AbortController().signal)).toEqual({state:'unsupported',errorCode:'UNSUPPORTED_TYPE'});await second.stop();
});
it('broker shutdown aborts owned work without publishing a partial result',async()=>{
  let starts=0,aborted=0;const {broker,remote}=await setup(idleRuntime(async(_input,signal)=>{starts++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(Error('CANCELLED'));},{once:true}));}));
  const pending=remote.acquire({url:'https://example.org/'},new AbortController().signal).catch(e=>e);await expect.poll(()=>starts).toBe(1);await broker.stop();expect(await pending).toBeInstanceOf(Error);expect(aborted).toBe(1);
});
it.each(['cancel','old-lease','bad-hash'])('disk queue never publishes a %s remote result',async(mode)=>{
  const {randomUUID}=await import('node:crypto');const {openDatabase}=await import('../../server/database');const {CaptureQueue}=await import('../../server/capture/queue');const {CaptureDispatcher}=await import('../../server/capture/runtime');const {DiskBlobStore}=await import('../../server/blob');
  const dir=await directory(),db=openDatabase(join(dir,'queue.sqlite'));cleanups.push(()=>db.close());let now=1000;const queue=new CaptureQueue(db,{secretKey:new Uint8Array(32).fill(8),now:()=>now,leaseMs:100});const account=randomUUID();const job=queue.submit(account,{operationId:randomUUID(),assetId:randomUUID(),publicSourceUrl:'https://example.org/manual.pdf'});
  const path=join(dir,'source');await writeFile(path,bytes);let release!:()=>void,started=false,disposed=false;
  const {remote}=await setup(idleRuntime(async()=>{started=true;if(mode!=='bad-hash')await new Promise<void>(resolve=>{release=resolve;});return {state:'file',path,file:mode==='bad-hash'?{...descriptor,sha256:'b'.repeat(64)}:descriptor,strategy:'https',async dispose(){disposed=true;}};}));
  const dispatcher=new CaptureDispatcher(queue,new DiskBlobStore(join(dir,'blobs')),remote);await dispatcher.start();cleanups.push(()=>dispatcher.stop());await expect.poll(()=>started).toBe(true);
  if(mode==='cancel'){dispatcher.cancel(account,job.id);release();await expect.poll(()=>disposed).toBe(true);expect(queue.get(account,job.id).payload.state).toBe('cancelled');}
  else if(mode==='old-lease'){now+=101;const replacement=queue.lease('replacement');expect(replacement?.job.id).toBe(job.id);release();await expect.poll(()=>disposed).toBe(true);await new Promise(r=>setTimeout(r,30));expect(queue.get(account,job.id).payload.state).not.toBe('saved');}
  else await expect.poll(()=>queue.get(account,job.id).payload.state).toBe('failed');
  const rows=db.prepare("SELECT envelope FROM sync_entities WHERE account_id=? AND module_id='library'").all(account) as {envelope:string}[];expect(rows.map(row=>JSON.parse(row.envelope)).filter(entity=>entity.kind==='library.asset'&&entity.payload.availability==='available')).toEqual([]);
});
it('rejects coercible array/object states and strategies instead of treating them as strings',()=>{
  for(const value of [{state:['failed'],errorCode:'NETWORK'},{state:'file',file:descriptor,strategy:['https']}])expect(()=>resultHeader(value)).toThrow();
});
it('independently rejects valid hash/length with a MIME claim that disagrees with the file signature',async()=>{
  const dir=await directory();const wire=Buffer.concat([resultHeader({state:'file',file:{...descriptor,mime:'image/png'},strategy:'https'}),bytes]);await expect(readCaptureResult(Readable.from([wire]),dir,new AbortController().signal)).rejects.toThrow('CONTENT_SIGNATURE_MISMATCH');
});
it('production API capture requires an explicit socket and broker rejects DB/TCP flags',async()=>{
  const {runCli}=await import('../../server/cli');const {runBrokerCli}=await import('../../server/capture/broker-cli');
  await expect(runCli(['serve','--db','/unused/database.sqlite','--schemas','/unused/schemas.mjs','--capture','on','--capture-key-file','/unused/key'])).rejects.toThrow('CAPTURE_SOCKET_REQUIRED');
  await expect(runBrokerCli(['--db','/unused/database.sqlite'])).rejects.toThrow('INVALID_BROKER_ARGUMENT');
  await expect(runBrokerCli(['--port','1234'])).rejects.toThrow('INVALID_BROKER_ARGUMENT');expect(()=>new RemoteCaptureRuntime('relative.sock')).toThrow('INVALID_CAPTURE_SOCKET');
});
it('preserves explicit protocol rejection while a real UDS response is still open and never marks it transient',async()=>{
  const {errorOutcome}=await import('../../server/capture/policy');
  const dir=await directory(),socket=join(dir,'s');
  const server=createServer((req,res)=>{
    if(req.url==='/ready'){res.end(JSON.stringify({protocol:1,ready:true,imageDigest:image,maxConcurrent:2}));return;}
    res.writeHead(200,{'content-type':CAPTURE_CONTENT_TYPE});
    // A peer can keep HTTP open after sending an invalid complete header. The
    // parser must reject immediately with a security error, without retrying it.
    res.write('{"state":"saved","errorCode":"OK"}\n');
  });
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  cleanups.push(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
  const remote=new RemoteCaptureRuntime(socket);await remote.start();cleanups.push(()=>remote.stop());
  const error=await remote.acquire({url:'https://example.org/manual.pdf'},new AbortController().signal).catch(error=>error);
  expect(error).toBeInstanceOf(Error);expect(error.message).toBe('CAPTURE_PROTOCOL');
  expect(errorOutcome(error)).toEqual({state:'failed',errorCode:'CAPTURE_PROTOCOL',transient:false});
});
