import {createHash} from 'node:crypto';
import {mkdtemp, open, rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import type {Readable} from 'node:stream';
import type {WorkerInput} from '../../worker/runner';
import {parseCaptureCandidate} from '../../src/modules/library/model';
import type {BlobDescriptor} from '../../src/workbench/contracts/files';
import {validateBlob} from '../blob-descriptor';
import type {IsolatedResult} from './runtime';
import {CAPTURE_LIMITS} from './policy';
export const CAPTURE_CONTENT_TYPE = 'application/vnd.workbench.capture-v1';
export const HEADER_MAX_BYTES = 65536;
type WireResult = {state:'file';file:BlobDescriptor;strategy:'https'|'yt-dlp'} | Exclude<IsolatedResult,{state:'file'}>;
function record(value:unknown):Record<string,unknown> {if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('CAPTURE_PROTOCOL');return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,allowed:string[]) {if(Object.keys(value).some(key=>!allowed.includes(key))) throw Error('CAPTURE_PROTOCOL');}
function https(value:unknown):string {if(typeof value!=='string'||!value||value.length>8192||/[\u0000-\u0020]/.test(value)) throw Error('INVALID_CAPTURE_INPUT');const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!url.hostname) throw Error('INVALID_CAPTURE_INPUT');return value;}
export function parseWorkerInput(value:unknown):WorkerInput {
  const v=record(value);keys(v,['url','credentialRef','selectedUrl','doi','maxBytes','imagePdfTimeoutMs','videoTimeoutMs']);
  const input:WorkerInput={url:https(v.url)};
  if(v.selectedUrl!==undefined) input.selectedUrl=https(v.selectedUrl);
  for(const name of ['credentialRef','doi'] as const) {if(v[name]!==undefined) {if(typeof v[name]!=='string'||!v[name]||v[name].length>4096||/[\u0000-\u001f]/.test(v[name])) throw Error('INVALID_CAPTURE_INPUT');input[name]=v[name];}}
  for(const name of ['maxBytes','imagePdfTimeoutMs','videoTimeoutMs'] as const) if(v[name]!==undefined) {if(typeof v[name]!=='number'||!Number.isSafeInteger(v[name])||v[name]<=0||v[name]>CAPTURE_LIMITS[name]) throw Error('INVALID_CAPTURE_INPUT');input[name]=v[name];}
  if(Buffer.byteLength(JSON.stringify(input))>CAPTURE_LIMITS.inputMaxBytes) throw Error('INPUT_LIMIT');
  return input;
}
export function parseResultHeader(value:unknown):WireResult {
  const v=record(value);
  if(v.state==='file') {
    keys(v,['state','file','strategy']);const file=record(v.file);keys(file,['sha256','size','mime']);validateBlob(file as BlobDescriptor);
    if(!/^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|video\/(mp4|webm|ogg))$/.test(String(file.mime))||(v.strategy!=='https'&&v.strategy!=='yt-dlp')) throw Error('CAPTURE_PROTOCOL');
    return {state:'file',file:{sha256:file.sha256 as string,size:file.size as number,mime:file.mime as string},strategy:v.strategy as 'https'|'yt-dlp'};
  }
  if(typeof v.state!=='string'||!['needs-selection','needs-permission','unsupported','failed'].includes(v.state)) throw Error('CAPTURE_PROTOCOL');
  keys(v,v.state==='needs-selection'?['state','errorCode','candidates']:['state','errorCode','transient']);
  if(typeof v.errorCode!=='string'||! /^[A-Z0-9_]{1,100}$/.test(v.errorCode)) throw Error('CAPTURE_PROTOCOL');
  if(v.transient!==undefined&&(v.state!=='failed'||typeof v.transient!=='boolean')) throw Error('CAPTURE_PROTOCOL');
  if(v.state==='needs-selection') {if(!Array.isArray(v.candidates)||v.candidates.length>100) throw Error('CAPTURE_PROTOCOL');return {state:'needs-selection',errorCode:v.errorCode,candidates:v.candidates.map(parseCaptureCandidate)};}
  return {state:v.state as 'needs-permission'|'unsupported'|'failed',errorCode:v.errorCode,...(v.transient===undefined?{}:{transient:v.transient as boolean})};
}
export function resultHeader(value:unknown):Buffer {const header=Buffer.from(JSON.stringify(parseResultHeader(value))+'\n');if(header.length>HEADER_MAX_BYTES) throw Error('CAPTURE_PROTOCOL');return header;}
/** The same basic file signatures already required by the isolated worker are
 * checked again at both private transport boundaries. This is not media decoding. */
export function validateCaptureSignature(prefix:Buffer,mime:string):void {
  const ascii=(start:number,end:number)=>prefix.toString('ascii',start,end);
  const valid=mime==='application/pdf'?ascii(0,5)==='%PDF-':
    mime==='image/png'?prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    mime==='image/jpeg'?prefix[0]===255&&prefix[1]===216:
    mime==='image/gif'?/^GIF8[79]a/.test(ascii(0,6)):
    mime==='image/webp'?ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP':
    mime==='image/avif'?ascii(4,8)==='ftyp'&&/avif|avis/.test(ascii(8,32)):
    mime==='video/mp4'?ascii(4,8)==='ftyp':
    mime==='video/webm'?prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):
    mime==='video/ogg'?ascii(0,4)==='OggS':false;
  if(!valid)throw Error('CONTENT_SIGNATURE_MISMATCH');
}
/** Bounded framing shared by Docker stdout and UDS. Never accepts a remote path. */
export async function readCaptureResult(source:Readable, scratchRoot:string, signal:AbortSignal,maxBytes:number=CAPTURE_LIMITS.maxBytes):Promise<IsolatedResult> {
  signal.throwIfAborted();let header=Buffer.alloc(0),result:WireResult|undefined,directory:string|undefined,file:FileHandle|undefined,size=0;
  const hash=createHash('sha256');let prefix=Buffer.alloc(0);
  const abort=()=>source.destroy(signal.reason instanceof Error?signal.reason:Error('CANCELLED'));
  signal.addEventListener('abort',abort,{once:true});
  try {
    for await(const chunk of source) {
      signal.throwIfAborted();let bytes=Buffer.from(chunk);
      if(!result) {const newline=bytes.indexOf(10);const part=newline<0?bytes:bytes.subarray(0,newline);if(header.length+part.length+1>HEADER_MAX_BYTES) throw Error('CAPTURE_PROTOCOL');header=Buffer.concat([header,part]);if(newline<0)continue;result=parseResultHeader(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(header)));bytes=bytes.subarray(newline+1);header=Buffer.alloc(0);
        if(result.state==='file') {if(result.file.size>maxBytes)throw Error('BODY_LIMIT');directory=await mkdtemp(join(scratchRoot,'capture-'));file=await open(join(directory,'resource'),'wx',0o600);}
      }
      if(bytes.length) {if(result.state!=='file')throw Error('CAPTURE_PROTOCOL');size+=bytes.length;if(size>result.file.size||size>maxBytes)throw Error('BODY_LIMIT');hash.update(bytes);if(prefix.length<32)prefix=Buffer.concat([prefix,bytes.subarray(0,32-prefix.length)]);await file!.writeFile(bytes);}
    }
    signal.throwIfAborted();if(!result)throw Error('CAPTURE_PROTOCOL');
    if(result.state!=='file')return result;
    if(size!==result.file.size||hash.digest('hex')!==result.file.sha256)throw Error('CHECKSUM_MISMATCH');
    validateCaptureSignature(prefix,result.file.mime);await file!.close();file=undefined;const owned=directory!;
    return {...result,path:join(owned,'resource'),dispose:()=>rm(owned,{recursive:true,force:true})};
  } catch(error) {source.destroy();await file?.close().catch(()=>{});if(directory)await rm(directory,{recursive:true,force:true});throw error;}
  finally {signal.removeEventListener('abort',abort);}
}
